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

// ============================================================
// TITLE HELPERS
// ============================================================

// Only latin script (no Japanese/Chinese/Korean)
function isLatinScript(str) {
  return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF\s\-:!?.'&]+$/.test(str);
}

// Filter out junk titles: Mini Anime, Recap, Special, OVA, PV, etc.
function isJunkTitle(str) {
  return /mini anime|recap|ova|special|pv|promo|preview|part \d|●|\?\?/i.test(str);
}

// Kitsu ID → names
async function getNamesFromKitsu(kitsuId) {
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 8000 });
    const attrs = res.data?.data?.attributes;
    if (!attrs) return { names: [], year: null };

    const names = [
      attrs.titles?.en_jp,   // romaji
      attrs.titles?.en,      // english
      attrs.canonicalTitle,
    ].filter(n => n && isLatinScript(n) && !isJunkTitle(n));

    const year = attrs.startDate ? parseInt(attrs.startDate.substring(0, 4)) : null;
    console.log(`Kitsu: names=${JSON.stringify(names)} year=${year}`);
    return { names: [...new Set(names)], year };
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
        Page(page: 1, perPage: 10) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            format
            title { romaji english native }
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

    // Prefer TV series over movies when type=series, prefer exact format match
    const isSeriesRequest = type === 'series';
    const best = mediaList.find(m =>
      isSeriesRequest ? (m.format === 'TV' || m.format === 'TV_SHORT') : m.format === 'MOVIE'
    ) || mediaList[0];

    console.log(`AniList: best match format=${best.format} title="${best.title?.romaji || best.title?.english}"`);

    const names = [
      best.title?.romaji,
      best.title?.english,
    ].filter(n => n && isLatinScript(n) && !isJunkTitle(n));

    // Fallback: if filters removed everything, use the Cinemeta name directly
    const finalNames = names.length ? names : [name];

    console.log(`AniList: resolved names=${JSON.stringify(finalNames)} for "${name}"`);
    return { names: [...new Set(finalNames)], year: best.startDate?.year || null };
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

  // Always cache, even empty (but with short TTL if empty to allow retry)
  nameCache.set(cacheKey, { data: result, timestamp: result.names.length ? Date.now() : Date.now() - NAME_CACHE_TTL + 60000 });
  return result;
}

// Parse episode and season from Stremio ID
// kitsu:12345:5        → season 1, episode 5
// tt1234567:1:5        → season 1, episode 5
// tt1234567:2:5        → season 2, episode 5
function parseEpisodeAndSeason(fullId) {
  const parts = fullId.split(':');
  if (fullId.startsWith('kitsu:')) {
    return { season: 1, episode: parseInt(parts[2]) || 1 };
  } else {
    if (parts.length >= 3) {
      return { season: parseInt(parts[1]) || 1, episode: parseInt(parts[2]) || 1 };
    }
    return { season: 1, episode: parseInt(parts[1]) || 1 };
  }
}

// Keep old name for compatibility
function parseEpisode(fullId) {
  return parseEpisodeAndSeason(fullId).episode;
}

// ============================================================
// NYAA SEARCH
// ============================================================
function buildSearchVariants(animeName, episode) {
  // Clean: remove season/part tags and colons
  const clean = animeName
    .replace(/Season \d+/i, '').replace(/Part \d+/i, '')
    .replace(/2nd Season|3rd Season/i, '')
    .replace(/\([^)]*\)/g, '').replace(/:/g, '').trim();

  const base = [...new Set([animeName, clean].filter(Boolean))];

  if (episode != null) {
    const epPad = String(episode).padStart(2, '0');
    return base.flatMap(n => [`${n} ${epPad}`, `${n} ${String(episode)}`]);
  }
  return base;
}

async function searchNyaaForName(animeName, episode, season = 1) {
  const cacheKey = `nyaa:${animeName}:${episode}:s${season}`;
  const cached = nyaaCache.get(cacheKey);
  if (isCacheValid(cached, NYAA_CACHE_TTL)) {
    console.log(`Nyaa: ✅ Cache hit "${animeName}" ep${episode}`);
    return cached.data;
  }

  // Search both with episode number AND just the name (catches batch packs, alternate naming)
  const variants = buildSearchVariants(animeName, episode);
  const nameOnlyVariants = buildSearchVariants(animeName, null);
  const allVariants = [...new Set([...variants, ...nameOnlyVariants])];
  console.log(`Nyaa: 🔍 ${allVariants.length} variants for "${animeName}" ep${episode}`);

  const seenHashes = new Set();
  const allTorrents = [];

  const results = await Promise.allSettled(
    allVariants.map(q => si.searchAll(q, { filter: 0, category: '1_2' }).catch(() => []))
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

  // Filter out wrong seasons
  // e.g. if we want S1, reject torrents with S02/2nd Season/Season 2 etc.
  if (season != null) {
    const wrongSeasons = [];
    for (let s = 1; s <= 20; s++) {
      if (s !== season) {
        wrongSeasons.push(
          new RegExp(`S0*${s}E`, 'i'),           // S02E01
          new RegExp(`Season\\s*${s}(?!\\d)`, 'i'), // Season 2
          s === 2 ? /2nd\s*Season/i : null,
          s === 3 ? /3rd\s*Season/i : null,
          s >= 4 ? new RegExp(`${s}th\\s*Season`, 'i') : null,
        ).filter(Boolean);
      }
    }
    const allWrongPatterns = wrongSeasons.flat();
    filtered = filtered.filter(t => {
      const name = t.name || '';
      return !allWrongPatterns.some(p => p.test(name));
    });
  }

  const sorted = filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  nyaaCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
  return sorted;
}

// Search Nyaa: romaji first, fallback to english if nothing found
async function searchNyaaAll(names, episode, season = 1) {
  // names[0] = romaji, names[1] = english (from AniList/Kitsu order)
  const romaji = names[0] || null;
  const english = names[1] || null;

  if (romaji) {
    console.log(`Nyaa: Searching romaji "${romaji}" ep${episode} season${season}`);
    const torrents = await searchNyaaForName(romaji, episode, season);
    if (torrents.length) {
      console.log(`Nyaa: ✅ Found ${torrents.length} results with romaji`);
      return torrents;
    }
    console.log(`Nyaa: No results for romaji, trying english...`);
  }

  if (english && english !== romaji) {
    console.log(`Nyaa: Searching english "${english}" ep${episode} season${season}`);
    const torrents = await searchNyaaForName(english, episode, season);
    if (torrents.length) {
      console.log(`Nyaa: ✅ Found ${torrents.length} results with english`);
      return torrents;
    }
    console.log(`Nyaa: No results for english either`);
  }

  return [];
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

  const { season, episode } = parseEpisodeAndSeason(fullId);
  console.log(`Parsed season: ${season} episode: ${episode}`);

  // Resolve anime names from ID
  const { names, year } = await resolveAnimeNames(type, fullId);
  if (!names.length) {
    console.log('Could not resolve anime names');
    return { streams: [{ name: '❌ Nenalezeno', title: 'Nepodařilo se najít název anime', url: 'https://nyaa.si', behaviorHints: { notWebReady: true } }] };
  }

  console.log(`Resolved names: ${JSON.stringify(names)}`);

  // Search Nyaa across all name variants
  const torrents = await searchNyaaAll(names, episode, season);
  console.log(`Nyaa: total ${torrents.length} torrents after dedup`);

  if (!torrents.length) {
    return { streams: [{ name: '⏳ Nenalezeno', title: `Ep ${episode} není na Nyaa.si\n${names[0]}`, url: 'https://nyaa.si', behaviorHints: { notWebReady: true } }] };
  }

  const hasRD = rdKey && rdKey !== 'nord';

  // Preferred release groups in order
  const GROUP_PRIORITY = ['SubsPlease', 'Erai-raws', 'EMBER', 'ASW'];

  function getGroupPriority(torrentName) {
    const name = torrentName || '';
    for (let i = 0; i < GROUP_PRIORITY.length; i++) {
      if (name.toLowerCase().includes(GROUP_PRIORITY[i].toLowerCase())) return i;
    }
    return GROUP_PRIORITY.length;
  }

  function is1080p(torrentName) {
    return /1080p/i.test(torrentName || '');
  }

  const sorted = torrents
    .filter(t => t.magnet && (t.seeders || 0) > 0)
    .sort((a, b) => {
      const a1080 = is1080p(a.name) ? 0 : 1;
      const b1080 = is1080p(b.name) ? 0 : 1;
      if (a1080 !== b1080) return a1080 - b1080;  // 1080p first
      const pa = getGroupPriority(a.name);
      const pb = getGroupPriority(b.name);
      if (pa !== pb) return pa - pb;               // then preferred group
      return (b.seeders || 0) - (a.seeders || 0); // then seeders
    });

  // Show all found torrents - RD conversion happens ONLY when user clicks a specific stream
  const streams = sorted.map(t => {
    // Detect if torrent title matches S1 pattern (no season number = season 1)
    const name = t.name || '';
    const hasSeasonTag = /S\d{2}|Season\s*\d/i.test(name);
    const isS1implicit = !hasSeasonTag; // no season tag → likely S1
    const seasonHint = isS1implicit ? ' [S1]' : '';

    const title = `${t.name}${seasonHint}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`;

    if (hasRD) {
      return {
        name: '🎌 RealDebrid',
        title,
        url: `${BASE_URL}/${rdKey}/rd/${encodeURIComponent(t.magnet)}`,
        behaviorHints: { bingeGroup: 'anime-nyaa-rd' }
      };
    }
    return {
      name: '🧲 Nyaa Magnet',
      title,
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

// Clear name cache on startup (filters may have changed between deploys)
nameCache.clear();
console.log('🗑️  Name cache cleared on startup');

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
