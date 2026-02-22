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
const anilistSearchCache = new Map();
const ANILIST_CACHE_TTL = 10 * 60 * 1000;

const anilistDetailsCache = new Map();
const ANILIST_DETAILS_TTL = 30 * 60 * 1000;

const nyaaCache = new Map();
const NYAA_CACHE_TTL = 30 * 60 * 1000;

const rdCache = new Map();
const RD_CACHE_TTL = 60 * 60 * 1000;

function isCacheValid(entry, ttl) {
  return entry && Date.now() - entry.timestamp < ttl;
}

cron.schedule('*/30 * * * *', () => {
  const now = Date.now();
  for (const [k, v] of anilistSearchCache) if (now - v.timestamp > ANILIST_CACHE_TTL) anilistSearchCache.delete(k);
  for (const [k, v] of anilistDetailsCache) if (now - v.timestamp > ANILIST_DETAILS_TTL) anilistDetailsCache.delete(k);
  for (const [k, v] of nyaaCache) if (now - v.timestamp > NYAA_CACHE_TTL) nyaaCache.delete(k);
  for (const [k, v] of rdCache) if (now - v.timestamp > RD_CACHE_TTL) rdCache.delete(k);
  console.log('🗑️  Cache cleanup done');
});

// ============================================================
// ANILIST API
// ============================================================
const ANILIST_URL = 'https://graphql.anilist.co';

async function searchAniList(query) {
  const cacheKey = `search:${query}`;
  const cached = anilistSearchCache.get(cacheKey);
  if (isCacheValid(cached, ANILIST_CACHE_TTL)) {
    console.log(`AniList: ✅ Cache hit for "${query}"`);
    return cached.data;
  }

  const gql = `
    query ($search: String) {
      Page(page: 1, perPage: 30) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id type format
          title { romaji english native }
          coverImage { extraLarge large }
          bannerImage description genres
          averageScore episodes status season seasonYear
        }
      }
    }
  `;

  try {
    const res = await axios.post(ANILIST_URL, { query: gql, variables: { search: query } }, { timeout: 8000 });
    const data = res.data?.data?.Page?.media || [];
    anilistSearchCache.set(cacheKey, { data, timestamp: Date.now() });
    console.log(`AniList: 🔍 Found ${data.length} results for "${query}"`);
    return data;
  } catch (err) {
    console.error('AniList search error:', err.message);
    return [];
  }
}

async function getAniListDetails(anilistId) {
  const key = String(anilistId);
  const cached = anilistDetailsCache.get(key);
  if (isCacheValid(cached, ANILIST_DETAILS_TTL)) return cached.data;

  const gql = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id type format
        title { romaji english native }
        coverImage { extraLarge large }
        bannerImage description genres
        averageScore episodes status season seasonYear
      }
    }
  `;

  try {
    const res = await axios.post(ANILIST_URL, { query: gql, variables: { id: parseInt(anilistId) } }, { timeout: 8000 });
    const data = res.data?.data?.Media || null;
    if (data) anilistDetailsCache.set(key, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error('AniList details error:', err.message);
    return null;
  }
}

function getStremioType(media) {
  return (media.format === 'MOVIE' || media.format === 'SPECIAL') ? 'movie' : 'series';
}

function getBestTitle(title) {
  return title.romaji || title.english || title.native || 'Unknown';
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

async function searchNyaa(animeName, episode) {
  const cacheKey = `${animeName}:${episode}`;
  const cached = nyaaCache.get(cacheKey);
  if (isCacheValid(cached, NYAA_CACHE_TTL)) {
    console.log(`Nyaa: ✅ Cache hit "${animeName}" ep${episode}`);
    return cached.data;
  }

  const variants = buildSearchVariants(animeName, episode);
  console.log(`Nyaa: 🔍 ${variants.length} variants parallel for "${animeName}" ep${episode}`);

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
  console.log(`Nyaa: ✅ ${sorted.length} torrents (from ${allTorrents.length} total)`);
  nyaaCache.set(cacheKey, { data: sorted, timestamp: Date.now() });
  return sorted;
}

// ============================================================
// REALDEBRID
// ============================================================
async function getRDStream(magnet, apiKey) {
  if (!apiKey || apiKey === 'nord') return null;

  const cacheKey = `${magnet}_${apiKey}`;
  const cached = rdCache.get(cacheKey);
  if (isCacheValid(cached, RD_CACHE_TTL)) { console.log('RD: ✅ Cache hit'); return cached.url; }

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };

  try {
    console.log('RD: Adding magnet...');
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

function preCacheRD(magnet, apiKey) {
  if (!apiKey || apiKey === 'nord') return;
  if (isCacheValid(rdCache.get(`${magnet}_${apiKey}`), RD_CACHE_TTL)) return;
  getRDStream(magnet, apiKey).catch(() => {});
}

// ============================================================
// HANDLERS
// ============================================================
async function handleCatalogRequest(args) {
  const { type, extra } = args;
  const search = extra?.search || null;
  const skip = parseInt(extra?.skip) || 0;

  console.log(`=== CATALOG REQUEST === type=${type} search="${search}" skip=${skip}`);

  if (skip > 0) return { metas: [] };
  if (!search || !search.trim()) return { metas: [] };

  try {
    const results = await searchAniList(search.trim());
    const metas = results
      .filter(m => getStremioType(m) === type)
      .map(m => ({
        id: `anilist:${m.id}`,
        type: getStremioType(m),
        name: getBestTitle(m.title),
        poster: m.coverImage?.extraLarge || m.coverImage?.large || '',
        background: m.bannerImage || m.coverImage?.extraLarge || '',
        description: (m.description || '').replace(/<[^>]*>/g, ''),
        genres: m.genres || [],
        releaseInfo: [m.season, m.seasonYear].filter(Boolean).join(' ') || undefined,
        imdbRating: m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined
      }));
    console.log(`📋 Returning ${metas.length} metas`);
    return { metas };
  } catch (err) {
    console.error('Catalog error:', err.message);
    return { metas: [] };
  }
}

async function handleMetaRequest(args) {
  const { id } = args;
  // id = "anilist:12345"
  const match = id.match(/^anilist:(\d+)$/);
  if (!match) return { meta: null };
  const anilistId = match[1];

  console.log(`=== META REQUEST === id=${id}`);

  try {
    const media = await getAniListDetails(anilistId);
    if (!media) return { meta: null };

    const type = getStremioType(media);
    const title = getBestTitle(media.title);
    const poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
    const background = media.bannerImage || poster;
    const totalEpisodes = media.episodes || 1;

    const meta = {
      id: `anilist:${media.id}`,
      type,
      name: title,
      poster,
      background,
      description: (media.description || '').replace(/<[^>]*>/g, ''),
      genres: media.genres || [],
      releaseInfo: [media.season, media.seasonYear].filter(Boolean).join(' ') || String(media.seasonYear || ''),
      imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined
    };

    if (type === 'series') {
      meta.videos = Array.from({ length: totalEpisodes }, (_, i) => ({
        id: `anilist:${media.id}:${i + 1}`,
        title: `Epizoda ${i + 1}`,
        episode: i + 1,
        season: 1,
        released: new Date(0).toISOString()
      }));
    } else {
      meta.videos = [{ id: `anilist:${media.id}:1`, title, episode: 1, season: 1, released: new Date(0).toISOString() }];
    }

    return { meta };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
}

async function handleStreamRequest(args) {
  const { id, config } = args;
  const rdKey = config?.rdKey || 'nord';

  // id = "anilist:12345:1"
  const match = id.match(/^anilist:(\d+):(\d+)$/);
  if (!match) return { streams: [] };
  const anilistId = match[1];
  const episode = parseInt(match[2]) || 1;

  console.log(`=== STREAM REQUEST === id=${id} episode=${episode}`);

  try {
    const media = await getAniListDetails(anilistId);
    if (!media) return { streams: [] };

    const titleRomaji = media.title.romaji;
    const titleEnglish = media.title.english;
    const isMovie = getStremioType(media) === 'movie';
    const ep = isMovie ? null : episode;

    let torrents = [];
    if (titleRomaji && titleEnglish && titleRomaji !== titleEnglish) {
      const [r1, r2] = await Promise.all([searchNyaa(titleRomaji, ep), searchNyaa(titleEnglish, ep)]);
      const seen = new Set();
      for (const t of [...r1, ...r2]) {
        const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
        if (hash && !seen.has(hash)) { seen.add(hash); torrents.push(t); }
      }
      torrents.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    } else {
      torrents = await searchNyaa(titleRomaji || titleEnglish || '', ep);
    }

    if (!torrents.length) {
      return { streams: [{ name: '⏳ Nenalezeno', title: `Ep ${episode} není na Nyaa.si`, url: 'https://nyaa.si', behaviorHints: { notWebReady: true } }] };
    }

    const hasRD = rdKey && rdKey !== 'nord';
    const streams = torrents.filter(t => t.magnet).slice(0, 10).map(t => {
      if (hasRD) {
        preCacheRD(t.magnet, rdKey);
        const isReady = isCacheValid(rdCache.get(`${t.magnet}_${rdKey}`), RD_CACHE_TTL);
        return {
          name: isReady ? '🎌 RealDebrid ✅' : '🎌 RealDebrid',
          title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
          url: `${BASE_URL}/${rdKey}/rd/${encodeURIComponent(t.magnet)}`,
          behaviorHints: { bingeGroup: 'anime-rd' }
        };
      }
      return {
        name: '🧲 Magnet',
        title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
        url: t.magnet,
        behaviorHints: { notWebReady: true }
      };
    });

    return { streams };
  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
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
// Config is base64-encoded JSON: { rdKey: "..." }
app.get('/:userConfig/manifest.json', (req, res) => {
  try {
    const configJson = Buffer.from(req.params.userConfig, 'base64').toString('utf8');
    const config = JSON.parse(configJson);
    console.log(`📄 Manifest for rdKey: ${config.rdKey ? config.rdKey.substring(0, 8) + '...' : 'none'}`);
  } catch(e) {
    console.log(`📄 Manifest (invalid config)`);
  }

  res.json({
    id: 'cz.anime.nyaa.anilist.rd',
    version: '2.0.0',
    name: '🎌 Anime Search',
    description: 'Vyhledávání anime přes AniList + Nyaa torrenty + RealDebrid',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    catalogs: [
      {
        type: 'series',
        id: 'anime-search',
        name: 'Anime (Series)',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      },
      {
        type: 'movie',
        id: 'anime-movies',
        name: 'Anime (Filmy)',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      }
    ],
    idPrefixes: ['anilist:'],
    behaviorHints: { configurable: false, configurationRequired: false }
  });
});

// ── CATALOG ───────────────────────────────────────────────
// Regex: captures everything after catalogId including extra path segments
// e.g. /CONFIG/catalog/series/anime-search/search=Naruto.json
app.get(/^\/([^\/]+)\/catalog\/([^\/]+)\/([^\/]+)\/(.+)$/, async (req, res) => {
  try {
    const configB64 = req.params[0];
    const type = req.params[1];
    const extraPath = req.params[3].replace(/\.json$/, '');

    const config = JSON.parse(Buffer.from(configB64, 'base64').toString('utf8'));

    // Parse extra params from path: "search=Naruto&skip=0"
    const extra = {};
    for (const pair of extraPath.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      extra[pair.slice(0, eqIdx)] = decodeURIComponent(pair.slice(eqIdx + 1));
    }

    const result = await handleCatalogRequest({ type, extra, config });
    res.json(result);
  } catch (err) {
    console.error('Catalog route error:', err.message);
    res.json({ metas: [] });
  }
});

// ── META ──────────────────────────────────────────────────
// e.g. /CONFIG/meta/series/anilist:12345.json
app.get('/:userConfig/meta/:type/:id.json', async (req, res) => {
  try {
    const config = JSON.parse(Buffer.from(req.params.userConfig, 'base64').toString('utf8'));
    const result = await handleMetaRequest({ type: req.params.type, id: req.params.id, config });
    res.json(result);
  } catch (err) {
    console.error('Meta route error:', err.message);
    res.json({ meta: null });
  }
});

// ── STREAM ────────────────────────────────────────────────
// e.g. /CONFIG/stream/series/anilist:12345:1.json
app.get('/:userConfig/stream/:type/:id.json', async (req, res) => {
  try {
    const config = JSON.parse(Buffer.from(req.params.userConfig, 'base64').toString('utf8'));
    const result = await handleStreamRequest({ type: req.params.type, id: req.params.id, config });
    res.json(result);
  } catch (err) {
    console.error('Stream route error:', err.message);
    res.json({ streams: [] });
  }
});

// ── REALDEBRID PROXY ──────────────────────────────────────
// Uses rdKey directly (not from config) for simplicity in the proxy URL
app.get('/:rdKey/rd/:magnet(*)', async (req, res) => {
  const magnet = decodeURIComponent(req.params.magnet);
  const rdKey = req.params.rdKey;
  // rdKey here is the raw RD key, not base64 config
  // We detect it by checking if it's valid base64 JSON or a plain key
  let actualKey = rdKey;
  try {
    const config = JSON.parse(Buffer.from(rdKey, 'base64').toString('utf8'));
    if (config.rdKey) actualKey = config.rdKey;
  } catch(e) { /* plain key, use as-is */ }

  console.log('RD proxy: converting magnet...');
  const stream = await getRDStream(magnet, actualKey);
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
  console.log(`📦 Install: stremio://${BASE_URL.replace(/^https?:\/\//, '')}/CONFIG_BASE64/manifest.json`);
});
