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

// -------------------- Helpers (kept/compatible with your original code) --------------------
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

// -------------------- Original manifest + builder (unchanged behaviour) --------------------
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
      extra: [{ name: 'genre', isRequired: false }],
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
// -------------------- Full CORS fix for ALL /addon/* endpoints --------------------
app.use('/addon', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Handle preflight requests
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});


// Optional: handle OPTIONS preflight requests (Stremio sometimes sends these)
app.options('/addon/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve UI (Tailwind) at root
app.get('/', (req, res) => {
  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Shanny IPTV — Add Playlist</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 min-h-screen flex items-center justify-center p-6">
      <div class="w-full max-w-3xl">
        <div class="bg-white p-6 rounded-xl shadow">
          <h1 class="text-2xl font-semibold mb-4">Shanny — Add Playlist (M3U / Xtreme Codes)</h1>
          <p class="text-sm text-gray-600 mb-6">Paste an M3U URL or Xtreme Codes credentials to generate a unique Stremio install link (each link installs as a separate addon).</p>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h2 class="font-medium mb-2">M3U Playlist</h2>
              <input id="m3uUrl" class="w-full border p-3 rounded" placeholder="https://example.com/playlist.m3u" />
              <input id="epgUrl" class="w-full border p-3 rounded mt-3" placeholder="(optional) XMLTV EPG URL" />
              <div class="flex gap-2 mt-3">
                <button id="generateM3U" class="bg-blue-600 text-white px-4 py-2 rounded">Generate Install Link</button>
                <button id="testM3U" class="bg-gray-200 px-4 py-2 rounded">Test Fetch</button>
              </div>
              <p id="m3uResult" class="mt-3 text-sm text-gray-700"></p>
            </div>

            <div>
              <h2 class="font-medium mb-2">Xtreme Codes (XC)</h2>
              <input id="xcHost" class="w-full border p-3 rounded" placeholder="xtream.host.com" />
              <input id="xcUser" class="w-full border p-3 rounded mt-3" placeholder="username" />
              <input id="xcPass" type="password" class="w-full border p-3 rounded mt-3" placeholder="password" />
              <div class="flex gap-2 mt-3">
                <button id="generateXC" class="bg-blue-600 text-white px-4 py-2 rounded">Generate Install Link</button>
                <button id="testXC" class="bg-gray-200 px-4 py-2 rounded">Test Fetch</button>
              </div>
              <p id="xcResult" class="mt-3 text-sm text-gray-700"></p>
            </div>
          </div>

          <div class="mt-6">
            <h3 class="font-medium">How to install</h3>
            <ol class="list-decimal list-inside text-sm text-gray-700">
              <li>Click Generate Install Link → a page will open with the unique manifest URL.</li>
              <li>Open Stremio → Add-ons → Add by URL → paste the manifest URL (or open on device).</li>
              <li>Each unique manifest URL installs as a separate addon entry in Stremio.</li>
            </ol>
          </div>
        </div>
      </div>

      <script>
      async function openInstall(url) { window.open(url, '_blank'); }

      document.getElementById('generateM3U').addEventListener('click', () => {
        const m3u = document.getElementById('m3uUrl').value.trim();
        const epg = document.getElementById('epgUrl').value.trim();
        if (!m3u) return alert('Enter M3U URL');
        const params = new URLSearchParams();
        params.set('m3uUrl', m3u);
        if (epg) params.set('epgUrl', epg);
        window.open('/addon/m3u/manifest.json?' + params.toString(), '_blank');
        window.open('/addon/generate-install?' + params.toString(), '_blank');
      });

      document.getElementById('generateXC').addEventListener('click', () => {
        const host = document.getElementById('xcHost').value.trim();
        const user = document.getElementById('xcUser').value.trim();
        const pass = document.getElementById('xcPass').value.trim();
        if (!host || !user || !pass) return alert('Enter XC host, user and pass');
        const params = new URLSearchParams();
        params.set('host', host);
        params.set('user', user);
        params.set('pass', pass);
        window.open('/addon/xc/manifest.json?' + params.toString(), '_blank');
        window.open('/addon/generate-install?' + params.toString(), '_blank');
      });

      document.getElementById('testM3U').addEventListener('click', async () => {
        const m3u = document.getElementById('m3uUrl').value.trim();
        const resText = document.getElementById('m3uResult');
        if (!m3u) return alert('Enter M3U URL');
        resText.textContent = 'Testing...';
        try {
          const r = await fetch('/addon/m3u/catalog.json?m3uUrl=' + encodeURIComponent(m3u));
          const j = await r.json();
          resText.textContent = 'Found ' + (j.metas?.length || 0) + ' channels';
        } catch (e) {
          resText.textContent = 'Fetch failed: ' + e.message;
        }
      });

      document.getElementById('testXC').addEventListener('click', async () => {
        const host = document.getElementById('xcHost').value.trim();
        const user = document.getElementById('xcUser').value.trim();
        const pass = document.getElementById('xcPass').value.trim();
        const resText = document.getElementById('xcResult');
        if (!host || !user || !pass) return alert('Enter XC host, user and pass');
        resText.textContent = 'Testing...';
        try {
          const r = await fetch('/addon/xc/catalog.json?host=' + encodeURIComponent(host) + '&user=' + encodeURIComponent(user) + '&pass=' + encodeURIComponent(pass));
          const j = await r.json();
          resText.textContent = 'Found ' + (j.metas?.length || 0) + ' channels';
        } catch (e) {
          resText.textContent = 'Fetch failed: ' + e.message;
        }
      });
      </script>
    </body>
  </html>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// -------------------- Utility functions used by dynamic endpoints --------------------
function readParams(req) {
  const q = req.query || {};

  // Always safely decode
  const decode = (v) => {
    try {
      return v ? decodeURIComponent(v) : "";
    } catch {
      return v || "";
    }
  };

  const params = {
    m3uUrl: decode(q.m3uUrl),
    epgUrl: decode(q.epgUrl),
    host: decode(q.host),
    user: decode(q.user),
    pass: decode(q.pass),
    genre: decode(q.genre),
  };

  // -------------------------------------------
  // IMPORTANT: Persist last known M3U/XC params
  // -------------------------------------------
  if (!global._lastParams) global._lastParams = {};

  // If a param is missing but we have a previous one, restore it
  for (const key of Object.keys(params)) {
    if (params[key]) {
      global._lastParams[key] = params[key];
    } else if (global._lastParams[key]) {
      params[key] = global._lastParams[key];
    }
  }

  return params;
}

async function loadM3UFromUrl(m3uUrl) {
  if (!m3uUrl) throw new Error('No m3uUrl');
  const r = await fetch(m3uUrl, { timeout: 20000 });
  if (!r.ok) throw new Error('Failed to fetch M3U');
  const text = await r.text();
  const parsed = parser.parse(text);
  return parsed.items.map((item, idx) => ({
    id: `m3u-${idx}-${item.url}`,
    name: item.name,
    url: item.url,
    logo: item.tvg?.logo || null,
    category: item.group?.title || 'Uncategorized',
    tvgId: item.tvg?.id || item.tvg?.name || item.name,
  }));
}

async function loadXCAsM3U({ host, user, pass }) {
  if (!host || !user || !pass) throw new Error('Missing XC credentials');
  // Try player_api first
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
  } catch (e) {
    // continue to fallback
  }

  // Fallback to get.php m3u_plus
  try {
    const m3uTry = `http://${host}/get.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&type=m3u_plus`;
    const r2 = await fetch(m3uTry, { timeout: 15000 });
    if (!r2.ok) throw new Error('XC m3u fetch failed');
    const text = await r2.text();
    const parsed = parser.parse(text);
    return parsed.items.map((item, idx) => ({
      id: `xc-m3u-${idx}-${item.url}`,
      name: item.name,
      url: item.url,
      logo: item.tvg?.logo || null,
      category: item.group?.title || 'Live',
      tvgId: item.tvg?.id || item.name,
    }));
  } catch (err) {
    throw new Error('XC fetch failed: ' + err.message);
  }
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
    console.warn('EPG fetch failed:', e.message);
    return {};
  }
}

// -------------------- Dynamic endpoints mounted under /addon --------------------

// -------------------- Dynamic M3U manifest (query param version) --------------------
app.get('/addon/m3u/manifest.json', async (req, res) => {
  const { m3uUrl } = readParams(req); // read query param ?m3uUrl=
  if (!m3uUrl) return res.status(400).json({ error: 'Missing m3uUrl' });

  let items = [];
  try {
    items = await loadM3UFromUrl(m3uUrl); // load channels dynamically
  } catch (err) {
    console.error('Error loading M3U for manifest:', err.message);
  }

  // build unique categories
  const catSet = new Set(items.map(ch => ch.category || 'Live'));
  const catArray = ['All', ...Array.from(catSet).sort()];

  const man = {
    id: `shanny.m3u.${encodeURIComponent(m3uUrl).slice(0, 40)}`,
    version: '1.0.0',
    name: `Shanny (M3U)`,
    description: 'Dynamic M3U addon (per-playlist install)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [
      {
        id: 'iptv_catalog',
        type: 'tv',
        name: 'Shanny IPTV',
        extra: [{ name: 'genre', isRequired: false, options: catArray }],
      },
    ],
  };

  res.json(man);
});

// -------------------- Catalog (dynamic) --------------------
app.get('/addon/m3u/catalog/:type/:id.json', async (req, res) => {
  const { m3uUrl, genre } = readParams(req);
  if (!m3uUrl) return res.json({ metas: [] });

  try {
    const items = await loadM3UFromUrl(m3uUrl);

    let filtered = items;
    if (genre && genre !== 'All') {
      filtered = items.filter(ch => (ch.category || 'Live') === genre);
    }

    const metas = filtered.map(ch => ({
      id: `m3u:${ch.id}`,
      name: ch.name,
      type: 'tv',
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: 'Live stream',
      genres: [ch.category || 'Live'],
    }));

    res.json({ metas });
  } catch (err) {
    console.error('/addon/m3u/catalog error', err.message);
    res.json({ metas: [] });
  }
});

// -------------------- Meta (dynamic) --------------------
app.get('/addon/m3u/meta/:id.json', async (req, res) => {
  const { m3uUrl } = readParams(req);
  const rawId = req.params.id.replace(/^m3u:/, "");
  if (!m3uUrl) return res.json({ meta: {} });

  try {
    const items = await loadM3UFromUrl(m3uUrl);
    const ch = items.find(c => String(c.id) === rawId);
    if (!ch) return res.json({ meta: {} });

    return res.json({
      meta: {
        id: `m3u:${ch.id}`,
        type: 'tv',
        name: ch.name,
        poster: ch.logo,
        background: getUnsplashImage(ch.category),
        description: `Live stream for ${ch.name}`,
        genres: [ch.category || 'Live'],
      },
    });
  } catch (err) {
    console.error('/addon/m3u/meta error', err.message);
    res.json({ meta: {} });
  }
});

// -------------------- Stream (dynamic) --------------------
app.get('/addon/m3u/stream/:id.json', async (req, res) => {
  const { m3uUrl } = readParams(req);
  const rawId = req.params.id.replace(/^m3u:/, "");
  if (!m3uUrl) return res.json({ streams: [] });

  try {
    const items = await loadM3UFromUrl(m3uUrl);
    const ch = items.find(c => String(c.id) === rawId);
    if (!ch) return res.json({ streams: [] });

    return res.json({
      streams: [
        {
          url: ch.url,
          title: ch.name,
          externalUrl: true,
        },
      ],
    });
  } catch (err) {
    console.error('/addon/m3u/stream error', err.message);
    res.json({ streams: [] });
  }
});


// XC dynamic manifest
app.get('/addon/xc/manifest.json', (req, res) => {
  const params = readParams(req);
  const idSuffix = params.host ? encodeURIComponent(params.host).slice(0, 40) : Date.now();
  const man = {
    id: `shanny.xc.${idSuffix}`,
    version: '1.0.0',
    name: `Shanny (XC)`,
    description: 'Dynamic Xtreme Codes addon (per-login install)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ id: 'iptv_catalog', type: 'tv', name: 'XC Channels' }],
  };
  res.json(man);
});

app.get('/addon/xc/catalog/:type/:id.json', async (req, res) => {
  const { host, user, pass } = readParams(req);
  try {
    const items = await loadXCAsM3U({ host, user, pass });
    const metas = items.map((ch) => ({
      id: `xc:${ch.id}`,
      name: ch.name,
      type: 'tv',
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: `Live stream for ${ch.name}`,
      genres: [ch.category || 'Live'],
    }));
    res.json({ metas });
  } catch (err) {
    console.error('/addon/xc/catalog error', err.message);
    res.json({ metas: [] });
  }
});

app.get('/addon/xc/meta/:id.json', async (req, res) => {
  const { host, user, pass } = readParams(req);
  const rawId = req.params.id.replace(/^xc:/, ""); // <-- FIXED

  try {
    const items = await loadXCAsM3U({ host, user, pass });
    const ch = items.find((c) => String(c.id) === rawId); // <-- FIXED
    if (!ch) return res.json({ meta: {} });

    return res.json({
      meta: {
        id: `xc:${ch.id}`, // <-- MUST MATCH CATALOG ID
        type: 'tv',
        name: ch.name,
        poster: ch.logo,
        background: getUnsplashImage(ch.category),
        description: `Live stream for ${ch.name}`,
        genres: [ch.category || 'Live'],
      },
    });
  } catch (err) {
    console.error('/addon/xc/meta error', err.message);
    res.json({ meta: {} });
  }
});

app.get('/addon/xc/stream/:id.json', async (req, res) => {
  const { host, user, pass } = readParams(req);
  const rawId = req.params.id.replace(/^xc:/, ""); // <-- FIXED

  try {
    const items = await loadXCAsM3U({ host, user, pass });
    const ch = items.find((c) => String(c.id) === rawId); // <-- FIXED
    if (!ch) return res.json({ streams: [] });

    const streamUrl = ch.url || `http://${host}/live/${user}/${pass}/${ch.tvgId}.m3u8`;

    return res.json({
      streams: [
        {
          url: streamUrl,
          title: ch.name,
          externalUrl: true,
        },
      ],
    });
  } catch (err) {
    console.error('/addon/xc/stream error', err.message);
    res.json({ streams: [] });
  }
});

// UI backward compatibility for Test Fetch (returns simple JSON instead of HTML)
app.get('/addon/m3u/catalog.json', (req, res) => {
    res.json({ ok: true, message: 'Use /addon/m3u/catalog/tv/iptv_catalog.json instead.' });
});

app.get('/addon/xc/catalog.json', (req, res) => {
    res.json({ ok: true, message: 'Use /addon/xc/catalog/tv/iptv_catalog.json instead.' });
});


// One-click install generator (returns manifest link HTML)
app.get('/addon/generate-install', (req, res) => {
  const raw = req.url.split('?')[1] || '';
  const params = new URLSearchParams(raw);
  let manifestUrl;
  if (params.has('m3uUrl') || params.has('epgUrl')) {
    manifestUrl = `${req.protocol}://${req.get('host')}/addon/m3u/manifest.json?${raw}`;
  } else if (params.has('host') && params.has('user') && params.has('pass')) {
    manifestUrl = `${req.protocol}://${req.get('host')}/addon/xc/manifest.json?${raw}`;
  } else {
    return res.status(400).send('Invalid generate-install parameters');
  }

  const html = `
    <!doctype html><html><body style="font-family:system-ui,Arial;padding:20px">
    <h2>Stremio install link</h2>
    <p>Use the link below to add this playlist as a separate addon in Stremio. Copy & paste it into <strong>Stremio → Add-ons → Add by URL</strong> or open it directly on the device where Stremio runs.</p>
    <p><a href="${manifestUrl}" target="_blank">${manifestUrl}</a></p>
    <p style="margin-top:18px;color:#666;font-size:14px">Note: the addon manifest is unique to this playlist/login. Each different manifest URL installs as a different addon in Stremio.</p>
    </body></html>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Serve static /public if you want to add local backgrounds later
app.use('/public', express.static(path.join(__dirname, 'public')));


// Expose the original manifest.json for backwards compatibility (env-mode)
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
