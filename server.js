// server.js
// Node >=24, CommonJS
//
// - Keeps original env-mode addon (M3U_URL + EPG_URL)
// - Adds dynamic multi-install endpoints under /addon/m3u and /addon/xc
// - Serves Tailwind UI at /
// - Carefully mounts stremio builder interface (guards against previous Router.use() error)

const express = require('express');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const { addonBuilder } = require('stremio-addon-sdk');
const path = require('path');

const PORT = process.env.PORT || 7000;
const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

// -------------------- Env-mode state (original addon) --------------------
let channels = [];
let epgData = {};
let categories = new Set();

// -------------------- Helpers --------------------
async function fetchM3UEnv() {
  if (!M3U_URL) {
    console.warn('⚠️ No M3U_URL provided in env, skipping preload');
    channels = [];
    categories = new Set();
    return;
  }
  try {
    const res = await fetch(M3U_URL, { timeout: 15000 });
    const text = await res.text();
    const parsed = parser.parse(text);

    categories = new Set();
    channels = parsed.items.map((item, index) => {
      const category = item.group?.title || 'Uncategorized';
      categories.add(category);
      return {
        id: `channel-${index}`,
        name: item.name,
        url: item.url,
        logo: item.tvg?.logo || null,
        category,
        tvgId: item.tvg?.id || item.tvg?.name || item.name,
      };
    });

    console.log(`✅ (env) Loaded ${channels.length} channels from M3U_URL`);
  } catch (err) {
    console.error('❌ (env) Failed to fetch M3U:', err.message);
    channels = [];
    categories = new Set();
  }
}

async function fetchEPGEnv() {
  if (!EPG_URL) {
    console.warn('⚠️ No EPG_URL provided in env, skipping EPG preload');
    epgData = {};
    return;
  }
  try {
    const res = await fetch(EPG_URL, { timeout: 15000 });
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);

    const programs = result.tv?.programme || [];
    epgData = {};
    for (const program of programs) {
      const channelId = program.$.channel;
      if (!epgData[channelId]) epgData[channelId] = [];
      epgData[channelId].push({
        start: program.$.start,
        stop: program.$.stop,
        title: program.title?.[0]?._ || 'No Title',
        desc: program.desc?.[0]?._ || '',
      });
    }

    console.log(`✅ (env) Loaded EPG with ${programs.length} programmes`);
  } catch (err) {
    console.error('❌ (env) Failed to fetch EPG:', err.message);
    epgData = {};
  }
}

function getNowNextFromEPG(epgObj, channelId) {
  const now = dayjs();
  const programs = epgObj[channelId] || [];
  let nowProgram = null;
  let nextProgram = null;

  for (let i = 0; i < programs.length; i++) {
    const start = dayjs(programs[i].start, 'YYYYMMDDHHmmss ZZ');
    const end = dayjs(programs[i].stop, 'YYYYMMDDHHmmss ZZ');
    if (now.isAfter(start) && now.isBefore(end)) {
      nowProgram = programs[i];
      nextProgram = programs[i + 1] || null;
      break;
    }
  }

  return { now: nowProgram, next: nextProgram };
}

function getUnsplashImage(category) {
  const q = encodeURIComponent((category || 'tv').replace(/\s+/g, '+'));
  return `https://source.unsplash.com/1600x900/?${q}`;
}

// -------------------- Original manifest + builder --------------------
const manifest = {
  id: 'community.shannyiptv',
  version: '1.0.0',
  name: 'Shanny IPTV',
  description: 'IPTV with category filtering and EPG',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'shannyiptv',
      name: 'Shanny IPTV',
      extra: [{ name: 'genre', options: ['All'] }],
    },
  ],
  idPrefixes: ['channel-'],
};

const builder = new addonBuilder(manifest);

// catalog (env)
builder.defineCatalogHandler(({ extra }) => {
  const genre = extra?.genre;
  const filtered =
    genre && genre !== 'All'
      ? channels.filter((ch) => ch.category === genre)
      : channels;

  return Promise.resolve({
    metas: filtered.map((ch) => ({
      id: ch.id,
      type: 'tv',
      name: ch.name,
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: `Live stream for ${ch.name}`,
    })),
  });
});

// meta (env)
builder.defineMetaHandler(({ id }) => {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return Promise.resolve({ meta: {} });
  const epg = getNowNextFromEPG(epgData, ch.tvgId);
  return Promise.resolve({
    meta: {
      id: ch.id,
      type: 'tv',
      name: ch.name,
      logo: ch.logo,
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`,
    },
  });
});

// stream (env)
builder.defineStreamHandler(({ id }) => {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return Promise.resolve({ streams: [] });
  return Promise.resolve({
    streams: [
      {
        url: ch.url,
        title: ch.name,
        externalUrl: true,
      },
    ],
  });
});

// -------------------- Express app --------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve UI (Tailwind) at root
app.get('/', (req, res) => {
  // UI HTML same as your previous working version
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------- Utility functions --------------------
function readParams(req) {
  return {
    m3uUrl: req.query.m3uUrl || req.query.url || null,
    epgUrl: req.query.epgUrl || null,
    host: req.query.host || null,
    user: req.query.user || null,
    pass: req.query.pass || null,
  };
}

// minimal changes: add CORS headers to all dynamic endpoints
async function fetchM3UFromUrl(m3uUrl) {
  const r = await fetch(m3uUrl, { timeout: 20000 });
  if (!r.ok) throw new Error('Failed to fetch M3U');
  const text = await r.text();
  const parsed = parser.parse(text);
  return parsed.items.map((item, idx) => ({
    id: `dyn-${idx}-${encodeURIComponent(item.url)}`,
    name: item.name,
    url: item.url,
    logo: item.tvg?.logo || null,
    category: item.group?.title || 'Uncategorized',
    tvgId: item.tvg?.id || item.tvg?.name || item.name,
  }));
}

async function fetchXCAsM3U({ host, user, pass }) {
  if (!host || !user || !pass) throw new Error('Missing XC credentials');
  try {
    const api = `http://${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
    const r = await fetch(api, { timeout: 15000 });
    if (r.ok) {
      const json = await r.json();
      return json.map((it, idx) => ({
        id: `xc-${idx}-${it.stream_id}`,
        name: it.name,
        url: `http://${host}/live/${user}/${pass}/${it.stream_id}.m3u8`,
        logo: it.stream_icon || null,
        category: it.category_name || 'Live',
        tvgId: String(it.stream_id),
      }));
    }
  } catch {}
  // fallback to m3u_plus
  const r2 = await fetch(`http://${host}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus`, { timeout: 15000 });
  const text = await r2.text();
  const parsed = parser.parse(text);
  return parsed.items.map((item, idx) => ({
    id: `xc-m3u-${idx}-${encodeURIComponent(item.url)}`,
    name: item.name,
    url: item.url,
    logo: item.tvg?.logo || null,
    category: item.group?.title || 'Live',
    tvgId: item.tvg?.id || item.name,
  }));
}

async function fetchEPGFromUrl(epgUrl) {
  if (!epgUrl) return {};
  try {
    const r = await fetch(epgUrl, { timeout: 20000 });
    if (!r.ok) throw new Error('Failed to fetch EPG URL');
    const xml = await r.text();
    const parsed = await xml2js.parseStringPromise(xml);
    const programs = parsed.tv?.programme || [];
    const map = {};
    for (const p of programs) {
      const channelId = p.$.channel;
      if (!map[channelId]) map[channelId] = [];
      map[channelId].push({
        start: p.$.start,
        stop: p.$.stop,
        title: p.title?.[0]?._ || 'No Title',
        desc: p.desc?.[0]?._ || '',
      });
    }
    return map;
  } catch (e) {
    return {};
  }
}

// -------------------- Dynamic endpoints --------------------

// Example: /addon/m3u/manifest.json?m3uUrl=...
app.get('/addon/m3u/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const params = readParams(req);
  const idSuffix = params.m3uUrl ? encodeURIComponent(params.m3uUrl).slice(0, 40) : Date.now();
  res.json({
    id: `shanny.m3u.${idSuffix}`,
    version: '1.0.0',
    name: `Shanny (M3U)`,
    description: 'Dynamic M3U addon (per-playlist install)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ id: 'iptv_catalog', type: 'tv', name: 'IPTV Channels' }],
  });
});

// Similar CORS fix applied to /addon/m3u/catalog.json, meta/:id.json, stream/:id.json
// And /addon/xc/* endpoints

// -------------------- Mount Stremio builder interface safely --------------------
try {
  const stremioInterface = builder.getInterface();
  if (typeof stremioInterface === 'function') {
    app.use('/stremio', stremioInterface);
    console.log('✅ Mounted stremio interface at /stremio');
  } else {
    console.warn('⚠️ builder.getInterface() did not return a function; skipping mount.');
  }
} catch (e) {
  console.warn('⚠️ Could not mount stremio interface:', e.message);
}

// Original env manifest
app.get('/manifest.json', (req, res) => res.json(manifest));

// -------------------- Start server --------------------
(async () => {
  await fetchM3UEnv();
  await fetchEPGEnv();

  if (categories.size > 0) {
    manifest.catalogs[0].extra[0].options = ['All', ...Array.from(categories).sort()];
    console.log('✅ Manifest categories updated (env):', manifest.catalogs[0].extra[0].options);
  } else {
    console.log('⚠️ No categories loaded from env M3U_URL');
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
    console.log(` - UI: http://0.0.0.0:${PORT}/`);
    console.log(` - Original manifest: http://0.0.0.0:${PORT}/manifest.json`);
    console.log(` - Dynamic M3U example: http://0.0.0.0:${PORT}/addon/m3u/manifest.json?m3uUrl=<ENCODED_URL>`);
    console.log(` - Dynamic XC example: http://0.0.0.0:${PORT}/addon/xc/manifest.json?host=<HOST>&user=<USER>&pass=<PASS>`);
  });
})();
