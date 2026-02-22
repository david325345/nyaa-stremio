const axios = require('axios');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

console.log('🚀 Starting Anime Nyaa Stremio Addon...');
console.log('  PORT:', PORT);
console.log('  BASE_URL:', BASE_URL);

// ============================================================
// CACHES
// ============================================================
const nameCache = new Map();       // kitsu/imdb ID → { names[], year }
const NAME_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h - names don't change

const nyaaCache = new Map();
const NYAA_CACHE_TTL = 30 * 60 * 1000;

const rdCache = new Map();
const RD_CACHE_TTL = 60 * 60 * 1000;

function isCacheValid(entry, ttl) {
  return entry && Date.now() - entry.timestamp < ttl;
}

cron.schedule('*/30 * * * *', () => {
  const now = Date.now();
  for (const [k, v] of nameCache) if (now - v.timestamp > NAME_CACHE_TTL) nameCache.delete(k);
  for (const [k, v] of nyaaCache) if (now - v.timestamp > NYAA_CACHE_TTL) nyaaCache.delete(k);
  for (const [k, v] of rdCache) if (now - v.timestamp > RD_CACHE_TTL) rdCache.delete(k);
  console.log('🗑️  Cache cleanup done');
});

// ============================================================
// ANIME OFFLINE DATABASE (IMDb → MAL mapping)
// ============================================================
// ============================================================
// NAME RESOLVERS
// ============================================================

// Kitsu ID → names
async function getNamesFromKitsu(kitsuId) {
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 8000 });
    const attrs = res.data?.data?.attributes;
    if (!attrs) return { names: [], year: null };

    const names = [];
    if (attrs.canonicalTitle) names.push(attrs.canonicalTitle);
    if (attrs.titles?.en) names.push(attrs.titles.en);
    if (attrs.titles?.en_jp) names.push(attrs.titles.en_jp);
    if (attrs.titles?.ja_jp) names.push(attrs.titles.ja_jp);
    if (attrs.abbreviatedTitles) names.push(...attrs.abbreviatedTitles);

    const year = attrs.startDate ? parseInt(attrs.startDate.substring(0, 4)) : null;
    console.log(`Kitsu: names=${JSON.stringify(names)} year=${year}`);
    return { names: [...new Set(names.filter(Boolean))], year };
  } catch (err) {
    console.error('Kitsu error:', err.message);
    return { names: [], year: null };
  }
}

// IMDb ID → Cinemeta (get English name) → AniList (get all title variants)
async function getNamesFromIMDb(type, imdbId) {
  try {
    // Step 1: get English name from Cinemeta
    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const name = res.data?.meta?.name;
    if (!name) { console.log(`Cinemeta: no name for ${imdbId}`); return { names: [], year: null }; }
    console.log(`Cinemeta: "${name}" for ${imdbId}`);

    // Step 2: search AniList with that name to get romaji + all variants
    const gql = `
      query ($search: String) {
        Page(page: 1, perPage: 5) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            title { romaji english native }
            synonyms
            startDate { year }
          }
        }
      }
    `;
    const aRes = await axios.post('https://graphql.anilist.co',
      { query: gql, variables: { search: name } }, { timeout: 8000 });

    const mediaList = aRes.data?.data?.Page?.media || [];
    if (!mediaList.length) {
      console.log(`AniList: no results for "${name}", using Cinemeta name only`);
      return { names: [name], year: null };
    }

    const best = mediaList[0];
    const names = [
      best.title?.romaji,
      best.title?.english,
      name,
      ...(best.synonyms || [])
    ].filter(Boolean);

    console.log(`AniList: resolved ${names.length} name variants for "${name}"`);
    return { names: [...new Set(names)], year: best.startDate?.year || null };
  } catch (err) {
    console.error('IMDb→AniList error:', err.message);
    return { names: [], year: null };
  }
}


// Master resolver: given full Stremio ID → anime names
async function resolveAnimeNames(type, fullId) {
  const cacheKey = `names:${type}:${fullId}`;
  const cached = nameCache.get(cacheKey);
  if (isCacheValid(cached, NAME_CACHE_TTL)) {
    console.log(`Names: ✅ Cache hit for ${fullId}`);
    return cached.data;
  }

  const baseId = fullId.split(':')[0]; // e.g. "kitsu:12345:1" → "kitsu"

  let result = { names: [], year: null };

  if (fullId.startsWith('kitsu:')) {
    const kitsuId = fullId.split(':')[1];
    result = await getNamesFromKitsu(kitsuId);
  } else if (fullId.startsWith('tt')) {
    const imdbId = baseId;
    result = await getNamesFromIMDb(type, imdbId);
  } else {
    // Unknown prefix - try Cinemeta → AniList
    result = await getNamesFromIMDb(type, baseId);
  }

  if (result.names.length) {
    nameCache.set(cacheKey, { data: result, timestamp: Date.now() });
  }
  return result;
}

// Parse episode number from Stremio ID
// kitsu:12345:5 → episode 5
// tt1234567:1:5 → season 1 episode 5
// tt1234567:5 → episode 5
function parseEpisode(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('kitsu:')) {
    // kitsu:ID:episode
    return parseInt(parts[2]) || 1;
  } else {
    // tt:season:episode  OR  tt:episode
    if (parts.length >= 3) return parseInt(parts[parts.length - 1]) || 1;
    if (parts.length === 2) return parseInt(parts[1]) || 1;
    return 1;
  }
}

// ============================================================
// NYAA SEARCH
// ============================================================
function buildSearchVariants(animeName, episode) {
  const clean = (n) => n
    .replace(/Season \d+/i, '').replace(/Part \d+/i, '')
    .replace(/2nd Season/i, '').replace(/3rd Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, '').trim();

  const base = [
    animeName,
    clean(animeName),
    animeName.split(':')[0].trim(),
    animeName.split('-')[0].trim(),
    animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(),
  ];
  const unique = [...new Set(base.filter(Boolean))];

  if (episode != null) {
    const epPad = String(episode).padStart(2, '0');
    const epRaw = String(episode);
    return unique.flatMap(n => [`${n} ${epPad}`, `${n} ${epRaw}`]);
  }
  return unique;
}

async function searchNyaaForName(animeName, episode) {
  const cacheKey = `nyaa:${animeName}:${episode}`;
  const cached = nyaaCache.get(cacheKey);
  if (isCacheValid(cached, NYAA_CACHE_TTL)) {
    console.log(`Nyaa: ✅ Cache hit "${animeName}" ep${episode}`);
    return cached.data;
  }

  const variants = buildSearchVariants(animeName, episode);
  console.log(`Nyaa: 🔍 ${variants.length} variants for "${animeName}" ep${episode}`);

  const seenHashes = new Set();
  const allTorrents = [];

  const results = await Promise.allSettled(
    variants.map(q => si.searchAll(q, { filter: 0, category: '1_2' }).catch(() => []))
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of (r.value || [])) {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) { seenHashes.add(hash); allTorrents.push(t); }
    }
  }

  let filtered = allTorrents;
  if (episode != null) {
    const ep = parseInt(episode);
    filtered = allTorrents.filter(t => {
      const pattern = new RegExp(`(?:[-_\\s\\[\\(]|e(?:p(?:isode)?)?\\s*)0*${ep}(?:[\\s\\-_\\]\\)v]|$|\\D)`, 'i');
      return pattern.test(t.name || '');
    });
  }

  const sorted = filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  nyaaCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
  return sorted;
}

// Search Nyaa across multiple name variants in parallel
async function searchNyaaAll(names, episode) {
  console.log(`Nyaa: Searching ${names.length} name variants: ${names.slice(0, 3).join(', ')}`);

  const results = await Promise.allSettled(
    names.slice(0, 4).map(name => searchNyaaForName(name, episode)) // top 4 names
  );

  const seen = new Set();
  const combined = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seen.has(hash)) { seen.add(hash); combined.push(t); }
    }
  }

  return combined.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

// ============================================================
// REALDEBRID
// ============================================================
async function getRDStream(magnet, apiKey) {
  if (!apiKey || apiKey === 'nord') return null;

  const cacheKey = `rd:${magnet}_${apiKey}`;
  const cached = rdCache.get(cacheKey);
  if (isCacheValid(cached, RD_CACHE_TTL)) { console.log('RD: ✅ Cache hit'); return cached.url; }

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  try {
    const add = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`, { headers, timeout: 12000 });
    const torrentId = add.data?.id;
    if (!torrentId) return null;

    const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers, timeout: 10000 });
    const files = info.data?.files || [];
    if (!files.length) return null;

    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${files.map((_, i) => i + 1).join(',')}`, { headers, timeout: 10000 });

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, { headers, timeout: 10000 });
      const link = poll.data?.links?.[0];
      if (link) {
        const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(link)}`, { headers, timeout: 10000 });
        const url = unrestrict.data?.download;
        if (url) { rdCache.set(cacheKey, { url, timestamp: Date.now() }); console.log('RD: ✅ Ready'); return url; }
      }
    }
    return null;
  } catch (err) {
    console.error('RD error:', err.response?.status, err.response?.data?.error || err.message);
    return null;
  }
}

// ============================================================
// STREAM HANDLER
// ============================================================
async function handleStreamRequest(type, fullId, rdKey) {
  console.log(`=== STREAM REQUEST === type=${type} id=${fullId}`);

  const episode = parseEpisode(fullId);
  console.log(`Parsed episode: ${episode}`);

  // Resolve anime names from ID
  const { names, year } = await resolveAnimeNames(type, fullId);
  if (!names.length) {
    console.log('Could not resolve anime names');
    return { streams: [{ name: '❌ Nenalezeno', title: 'Nepodařilo se najít název anime', url: 'https://nyaa.si', behaviorHints: { notWebReady: true } }] };
  }

  console.log(`Resolved names: ${JSON.stringify(names)}`);

  // Search Nyaa across all name variants
  const torrents = await searchNyaaAll(names, episode);

  if (!torrents.length) {
    return { streams: [{ name: '⏳ Nenalezeno', title: `Ep ${episode} není na Nyaa.si\n${names[0]}`, url: 'https://nyaa.si', behaviorHints: { notWebReady: true } }] };
  }

  const hasRD = rdKey && rdKey !== 'nord';

  // Show all found torrents - RD conversion happens ONLY when user clicks a specific stream
  const streams = torrents.filter(t => t.magnet).slice(0, 10).map(t => {
    if (hasRD) {
      return {
        name: '🎌 RealDebrid',
        title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
        url: `${BASE_URL}/${rdKey}/rd/${encodeURIComponent(t.magnet)}`,
        behaviorHints: { bingeGroup: 'anime-nyaa-rd' }
      };
    }
    return {
      name: '🧲 Nyaa Magnet',
      title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
      url: t.magnet,
      behaviorHints: { notWebReady: true }
    };
  });

  return { streams };
}

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── MANIFEST ──────────────────────────────────────────────
app.get('/:rdKey/manifest.json', (req, res) => {
  const rdKey = req.params.rdKey;
  console.log(`📄 Manifest for rdKey: ${rdKey.substring(0, 8)}...`);
  res.json({
    id: 'cz.anime.nyaa.rd',
    version: '3.0.0',
    name: '🎌 Anime Nyaa',
    description: 'Streamuje anime z Nyaa.si přes RealDebrid. Funguje s Cinemeta/Kitsu katalogy.',
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['kitsu:', 'tt'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// ── STREAM ────────────────────────────────────────────────
// /rdKey/stream/series/kitsu:12345:1.json
// /rdKey/stream/series/tt1234567:1:5.json
app.get(/^\/([^\/]+)\/stream\/([^\/]+)\/(.+)\.json$/, async (req, res) => {
  const rdKey = req.params[0];
  const type = req.params[1];
  const fullId = req.params[2];

  try {
    const result = await handleStreamRequest(type, fullId, rdKey);
    res.json(result);
  } catch (err) {
    console.error('Stream route error:', err.message);
    res.json({ streams: [] });
  }
});

// ── REALDEBRID PROXY ──────────────────────────────────────
app.get('/:rdKey/rd/:magnet(*)', async (req, res) => {
  const rdKey = req.params.rdKey;
  const magnet = decodeURIComponent(req.params.magnet);
  console.log('RD proxy: converting magnet...');
  const stream = await getRDStream(magnet, rdKey);
  stream ? res.redirect(stream) : res.status(500).send('RealDebrid: Failed');
});

// ── KEEP-ALIVE ────────────────────────────────────────────
setInterval(async () => {
  if (new Date().getUTCHours() >= 23) return;
  try { await axios.get(`${BASE_URL}/`, { timeout: 5000 }); console.log('⏰ Keep-alive'); }
  catch (_) {}
}, 10 * 60 * 1000);

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server: ${BASE_URL}`);
  console.log(`📦 Install: stremio://${BASE_URL.replace(/^https?:\/\//, '')}/YOUR_RD_KEY/manifest.json`);
});
