const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const path = require('path');
const { si } = require('nyaapi');
const cron = require('node-cron');

const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

console.log('🚀 Starting Anime Nyaa Stremio Addon...');
console.log('  PORT:', PORT);
console.log('  BASE_URL:', BASE_URL);

// ============================================================
// CACHES
// ============================================================

// AniList search cache: key → { data, timestamp }
const anilistSearchCache = new Map();
const ANILIST_CACHE_TTL = 10 * 60 * 1000; // 10 min

// AniList details cache
const anilistDetailsCache = new Map();
const ANILIST_DETAILS_TTL = 30 * 60 * 1000; // 30 min

// Nyaa search cache: `${name}:${episode}` → { data, timestamp }
const nyaaCache = new Map();
const NYAA_CACHE_TTL = 30 * 60 * 1000; // 30 min

// RealDebrid cache: `${magnet}_${key}` → { url, timestamp }
const rdCache = new Map();
const RD_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function isCacheValid(entry, ttl) {
  return entry && Date.now() - entry.timestamp < ttl;
}

// Cleanup old cache entries every 30 minutes
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

async function searchAniList(query, type = null) {
  const cacheKey = `search:${query}:${type}`;
  const cached = anilistSearchCache.get(cacheKey);
  if (isCacheValid(cached, ANILIST_CACHE_TTL)) {
    console.log(`AniList: ✅ Cache hit for "${query}"`);
    return cached.data;
  }

  const gql = `
    query ($search: String, $type: MediaType) {
      Page(page: 1, perPage: 30) {
        media(search: $search, type: $type, sort: SEARCH_MATCH) {
          id
          type
          format
          title { romaji english native }
          coverImage { extraLarge large }
          bannerImage
          description
          genres
          averageScore
          episodes
          status
          season
          seasonYear
        }
      }
    }
  `;

  try {
    const res = await axios.post(ANILIST_URL, {
      query: gql,
      variables: { search: query, type: type || 'ANIME' }
    }, { timeout: 8000 });

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
  const cached = anilistDetailsCache.get(anilistId);
  if (isCacheValid(cached, ANILIST_DETAILS_TTL)) return cached.data;

  const gql = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        type
        format
        title { romaji english native }
        coverImage { extraLarge large }
        bannerImage
        description
        genres
        averageScore
        episodes
        status
        season
        seasonYear
        studios(isMain: true) { nodes { name } }
        characters(sort: ROLE, perPage: 5) {
          nodes { name { full } }
        }
      }
    }
  `;

  try {
    const res = await axios.post(ANILIST_URL, {
      query: gql,
      variables: { id: parseInt(anilistId) }
    }, { timeout: 8000 });

    const data = res.data?.data?.Media || null;
    if (data) anilistDetailsCache.set(anilistId, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.error('AniList details error:', err.message);
    return null;
  }
}

// Convert AniList format to Stremio type
function getStremioType(media) {
  return media.format === 'MOVIE' || media.format === 'SPECIAL' ? 'movie' : 'series';
}

// Best title: romaji first, fallback english
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

  const epStr = episode != null ? ` ${String(episode).padStart(2, '0')}` : '';
  const epStrRaw = episode != null ? ` ${episode}` : '';

  const base = [
    animeName,
    clean(animeName),
    animeName.split(':')[0].trim(),
    animeName.split('-')[0].trim(),
    animeName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim(),
  ];

  // Deduplicate
  const unique = [...new Set(base.filter(Boolean))];

  if (episode != null) {
    return unique.flatMap(n => [`${n}${epStr}`, `${n}${epStrRaw}`]);
  }
  return unique;
}

async function searchNyaa(animeName, episode) {
  const cacheKey = `${animeName}:${episode}`;
  const cached = nyaaCache.get(cacheKey);
  if (isCacheValid(cached, NYAA_CACHE_TTL)) {
    console.log(`Nyaa: ✅ Cache hit for "${animeName}" ep${episode}`);
    return cached.data;
  }

  const variants = buildSearchVariants(animeName, episode);
  console.log(`Nyaa: 🔍 Searching ${variants.length} variants in parallel for "${animeName}" ep${episode}`);

  const seenHashes = new Set();
  const allTorrents = [];

  // Parallel search across all variants
  const results = await Promise.allSettled(
    variants.map(query =>
      si.searchAll(query, { filter: 0, category: '1_2' })
        .catch(() => [])
    )
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const torrents = result.value || [];
    for (const t of torrents) {
      const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        allTorrents.push(t);
      }
    }
  }

  // Filter correct episode
  let filtered = allTorrents;
  if (episode != null) {
    const ep = parseInt(episode);
    filtered = allTorrents.filter(t => {
      const name = t.name || '';
      const episodePattern = new RegExp(
        `(?:[-_\\s\\[\\(]|e(?:p(?:isode)?)?\\s*)0*${ep}(?:[\\s\\-_\\]\\)v]|$|\\D)`, 'i'
      );
      return episodePattern.test(name);
    });
  }

  const sorted = filtered.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  console.log(`Nyaa: ✅ ${sorted.length} torrents (from ${allTorrents.length} total) for ep${episode}`);

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
  if (isCacheValid(cached, RD_CACHE_TTL)) {
    console.log('RD: ✅ Cache hit');
    return cached.url;
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  try {
    console.log('RD: Adding magnet...');
    const add = await axios.post(
      'https://api.real-debrid.com/rest/1.0/torrents/addMagnet',
      `magnet=${encodeURIComponent(magnet)}`,
      { headers, timeout: 12000 }
    );
    const torrentId = add.data?.id;
    if (!torrentId) return null;

    // Get file list
    const info = await axios.get(
      `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
      { headers, timeout: 10000 }
    );
    const files = info.data?.files || [];
    if (!files.length) return null;

    // Select all files
    await axios.post(
      `https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
      `files=${files.map((_, i) => i + 1).join(',')}`,
      { headers, timeout: 10000 }
    );

    // Poll for download link (max 20s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await axios.get(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`,
        { headers, timeout: 10000 }
      );
      const link = poll.data?.links?.[0];
      if (link) {
        const unrestrict = await axios.post(
          'https://api.real-debrid.com/rest/1.0/unrestrict/link',
          `link=${encodeURIComponent(link)}`,
          { headers, timeout: 10000 }
        );
        const url = unrestrict.data?.download;
        if (url) {
          rdCache.set(cacheKey, { url, timestamp: Date.now() });
          console.log('RD: ✅ Stream ready (cached)');
          return url;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('RD error:', err.response?.status, err.response?.data?.error || err.message);
    return null;
  }
}

// Pre-cache RD stream in background
function preCacheRD(magnet, apiKey) {
  if (!apiKey || apiKey === 'nord') return;
  const cacheKey = `${magnet}_${apiKey}`;
  if (rdCache.has(cacheKey)) return;
  // Fire and forget
  getRDStream(magnet, apiKey).catch(() => {});
}

// ============================================================
// STREMIO ADDON
// ============================================================

function buildManifest(rdKey) {
  return {
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
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      },
      {
        type: 'movie',
        id: 'anime-movies',
        name: 'Anime (Filmy)',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false }
        ]
      }
    ],
    idPrefixes: ['anilist:'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  };
}

function buildMeta(media, rdKey) {
  const type = getStremioType(media);
  const title = getBestTitle(media.title);
  const poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
  const background = media.bannerImage || poster;
  const description = (media.description || '').replace(/<[^>]*>/g, '');
  const totalEpisodes = media.episodes || (type === 'movie' ? 1 : null);

  const meta = {
    id: `anilist:${media.id}`,
    type,
    name: title,
    poster,
    background,
    description,
    genres: media.genres || [],
    releaseInfo: [media.season, media.seasonYear].filter(Boolean).join(' ') || undefined,
    imdbRating: media.averageScore ? (media.averageScore / 10).toFixed(1) : undefined
  };

  // Build videos for series
  if (type === 'series') {
    const count = totalEpisodes || 1;
    meta.videos = Array.from({ length: count }, (_, i) => ({
      id: `anilist:${media.id}:${i + 1}`,
      title: `Epizoda ${i + 1}`,
      episode: i + 1,
      season: 1,
      released: new Date(0).toISOString() // placeholder
    }));
  } else {
    meta.videos = [{
      id: `anilist:${media.id}:1`,
      title: title,
      episode: 1,
      season: 1,
      released: new Date(0).toISOString()
    }];
  }

  return meta;
}

// ============================================================
// EXPRESS + DYNAMIC ADDON ROUTING
// ============================================================

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Root → landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /:rdKey/manifest.json
app.get('/:rdKey/manifest.json', (req, res) => {
  const manifest = buildManifest(req.params.rdKey);
  res.json(manifest);
});

// /:rdKey/catalog/:type/:id.json
app.get('/:rdKey/catalog/:type/:id.json', async (req, res) => {
  const { rdKey, type, id } = req.params;
  const search = req.query.search;
  const skip = parseInt(req.query.skip) || 0;

  if (skip > 0) return res.json({ metas: [] });
  if (!search) return res.json({ metas: [] });

  try {
    // For series catalog search without type filter (AniList returns all anime, we filter by format)
    const results = await searchAniList(search, 'ANIME');

    const metas = results
      .filter(m => {
        const sType = getStremioType(m);
        return sType === type;
      })
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

    res.json({ metas });
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.json({ metas: [] });
  }
});

// /:rdKey/meta/:type/:id.json
app.get('/:rdKey/meta/:type/:id.json', async (req, res) => {
  const { rdKey, type, id } = req.params;
  const [prefix, anilistId] = id.split(':');
  if (prefix !== 'anilist' || !anilistId) return res.json({ meta: null });

  try {
    const media = await getAniListDetails(anilistId);
    if (!media) return res.json({ meta: null });

    const meta = buildMeta(media, rdKey);
    res.json({ meta });
  } catch (err) {
    console.error('Meta error:', err.message);
    res.json({ meta: null });
  }
});

// /:rdKey/stream/:type/:id.json
app.get('/:rdKey/stream/:type/:id.json', async (req, res) => {
  const { rdKey, type, id } = req.params;
  const parts = id.split(':');
  const prefix = parts[0];
  const anilistId = parts[1];
  const episode = parseInt(parts[2]) || 1;

  if (prefix !== 'anilist' || !anilistId) return res.json({ streams: [] });

  try {
    const media = await getAniListDetails(anilistId);
    if (!media) return res.json({ streams: [] });

    // Search Nyaa in parallel with both romaji and english titles
    const titleRomaji = media.title.romaji;
    const titleEnglish = media.title.english;

    const isMovie = getStremioType(media) === 'movie';
    const ep = isMovie ? null : episode;

    let torrents = [];

    if (titleRomaji && titleEnglish && titleRomaji !== titleEnglish) {
      const [r1, r2] = await Promise.all([
        searchNyaa(titleRomaji, ep),
        searchNyaa(titleEnglish, ep)
      ]);
      // Merge, deduplicate by hash
      const seen = new Set();
      for (const t of [...r1, ...r2]) {
        const hash = t.magnet?.match(/btih:([a-zA-Z0-9]+)/i)?.[1]?.toLowerCase();
        if (hash && !seen.has(hash)) {
          seen.add(hash);
          torrents.push(t);
        }
      }
      torrents.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    } else {
      torrents = await searchNyaa(titleRomaji || titleEnglish || '', ep);
    }

    if (!torrents.length) {
      return res.json({
        streams: [{
          name: '⏳ Nenalezeno',
          title: `Ep ${episode} není dostupná na Nyaa.si\nZkuste to za chvíli`,
          url: 'https://nyaa.si',
          behaviorHints: { notWebReady: true }
        }]
      });
    }

    const streams = torrents
      .filter(t => t.magnet)
      .slice(0, 10) // limit to top 10
      .map(t => {
        const hasRD = rdKey && rdKey !== 'nord';

        // Background pre-cache for RD
        if (hasRD) preCacheRD(t.magnet, rdKey);

        const rdCacheKey = `${t.magnet}_${rdKey}`;
        const rdCached = rdCache.get(rdCacheKey);
        const isReady = isCacheValid(rdCached, RD_CACHE_TTL);

        if (hasRD) {
          const streamUrl = `${BASE_URL}/${rdKey}/rd/${encodeURIComponent(t.magnet)}`;
          return {
            name: isReady ? '🎌 RealDebrid ✅' : '🎌 RealDebrid',
            title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
            url: streamUrl,
            behaviorHints: { bingeGroup: 'anime-rd' }
          };
        } else {
          return {
            name: '🧲 Magnet',
            title: `${t.name}\n👥 ${t.seeders || 0} seeders | 📦 ${t.filesize || '?'}`,
            url: t.magnet,
            behaviorHints: { notWebReady: true }
          };
        }
      });

    res.json({ streams });
  } catch (err) {
    console.error('Stream error:', err.message);
    res.json({ streams: [] });
  }
});

// /:rdKey/rd/:magnet — RealDebrid proxy
app.get('/:rdKey/rd/:magnet', async (req, res) => {
  const { rdKey } = req.params;
  const magnet = decodeURIComponent(req.params.magnet);

  if (!rdKey || rdKey === 'nord') return res.status(400).send('No RealDebrid key');

  const stream = await getRDStream(magnet, rdKey);
  if (stream) {
    res.redirect(stream);
  } else {
    res.status(500).send('RealDebrid: Failed to get stream');
  }
});

// Keep-alive self-ping (for Render free tier)
let keepAliveActive = true;
setInterval(async () => {
  if (!keepAliveActive) return;
  const hour = new Date().getUTCHours();
  if (hour >= 23) return;
  try {
    await axios.get(`${BASE_URL}/`, { timeout: 5000 });
    console.log(`⏰ Keep-alive ping`);
  } catch (err) {
    // ignore
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Server running at ${BASE_URL}`);
  console.log(`📦 Install URL: stremio://${BASE_URL.replace(/^https?:\/\//, '')}/YOUR_RD_KEY/manifest.json`);
});
