/**
 * Shanny IPTV Addon (v4) - One-click Stremio install + XC + M3U + Optional Env
 */
const express = require('express');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- ENV MODE (optional) ----------------
const ENV_M3U = process.env.M3U_URL || null;
const ENV_EPG = process.env.EPG_URL || null;

// ---------------- GLOBAL STATE ----------------
let playlists = {}; // { [playlistId]: { channels, epgData, categories, addon } }

// ---------------- UTILITY FUNCTIONS ----------------
function getUnsplashImage(category) {
  return `https://source.unsplash.com/1600x900/?${encodeURIComponent(category || 'tv')}`;
}

function getNowNext(epgData, channelId) {
  const now = dayjs();
  const programs = epgData[channelId] || [];
  let nowProgram = null, nextProgram = null;

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

async function fetchM3U(url) {
  try {
    const res = await fetch(url, { timeout: 15000 });
    const text = await res.text();
    const parsed = parser.parse(text);

    const categories = new Set();
    const channels = parsed.items.map((item, index) => {
      const category = item.group?.title || 'Uncategorized';
      categories.add(category);
      return {
        id: `channel-${index}`,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo,
        category,
        tvgId: item.tvg.id,
      };
    });

    return { channels, categories };
  } catch (err) {
    console.error('❌ Failed to fetch M3U:', err.message);
    return { channels: [], categories: new Set() };
  }
}

async function fetchEPG(url) {
  try {
    const res = await fetch(url, { timeout: 15000 });
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);

    const programs = result.tv?.programme || [];
    const epgData = {};
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

    return epgData;
  } catch (err) {
    console.error('❌ Failed to fetch EPG:', err.message);
    return {};
  }
}

async function fetchXCPlaylist(username, password, type = 'm3u_plus') {
  const url = `http://xtremecodes.streamtv.to:8080/get.php?username=${username}&password=${password}&type=${type}&output=m3u`;
  return fetchM3U(url);
}

// ---------------- MANIFEST BUILDER ----------------
function buildManifest(playlistId, name = 'Shanny IPTV') {
  return {
    id: `shanny.dynamic.${playlistId}`,
    version: '1.0.0',
    name,
    description: 'Dynamic IPTV addon (per-playlist install)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [
      {
        id: 'iptv_catalog',
        type: 'tv',
        name: 'IPTV Channels',
        extra: [{ name: 'genre', options: ['All'] }],
      },
    ],
  };
}

function createAddon(playlistId) {
  const builder = new addonBuilder(buildManifest(playlistId));

  builder.defineCatalogHandler(({ extra }) => {
    const playlist = playlists[playlistId];
    if (!playlist) return Promise.resolve({ metas: [] });

    const genre = extra?.genre;
    const filtered = genre && genre !== 'All'
      ? playlist.channels.filter(ch => ch.category === genre)
      : playlist.channels;

    return Promise.resolve({
      metas: filtered.map(ch => ({
        id: ch.id,
        type: 'tv',
        name: ch.name,
        poster: ch.logo,
        background: getUnsplashImage(ch.category),
        description: `Live stream for ${ch.name}`,
      })),
    });
  });

  builder.defineMetaHandler(({ id }) => {
    const playlist = playlists[playlistId];
    if (!playlist) return Promise.resolve({ meta: {} });
    const ch = playlist.channels.find(c => c.id === id);
    if (!ch) return Promise.resolve({ meta: {} });

    const epg = getNowNext(playlist.epgData, ch.tvgId);
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

  builder.defineStreamHandler(({ id }) => {
    const playlist = playlists[playlistId];
    if (!playlist) return Promise.resolve({ streams: [] });
    const ch = playlist.channels.find(c => c.id === id);
    if (!ch) return Promise.resolve({ streams: [] });

    return Promise.resolve({
      streams: [{ url: ch.url, title: ch.name, externalUrl: true }],
    });
  });

  return builder;
}

// ---------------- DYNAMIC M3U & XC ENDPOINTS ----------------
async function getOrCreatePlaylist(type, identifier, fetchFunc, displayName) {
  if (!playlists[identifier]) {
    console.log(`⬇️ Fetching ${type} playlist:`, identifier);
    const { channels, categories } = await fetchFunc();
    playlists[identifier] = { channels, categories, epgData: {}, addon: createAddon(identifier) };
  }
  const manifest = buildManifest(identifier, displayName);
  manifest.catalogs[0].extra[0].options = ['All', ...Array.from(playlists[identifier].categories).sort()];
  return manifest;
}

app.get('/addon/m3u/manifest.json', async (req, res) => {
  const m3uUrl = req.query.m3uUrl;
  if (!m3uUrl) return res.status(400).json({ error: 'm3uUrl query param required' });
  const playlistId = encodeURIComponent(m3uUrl).slice(0, 40);

  const manifest = await getOrCreatePlaylist(
    'M3U',
    playlistId,
    async () => fetchM3U(m3uUrl),
    `Shanny IPTV (M3U)`
  );

  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

app.get('/addon/xc/manifest.json', async (req, res) => {
  const { username, password, type } = req.query;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  const playlistId = encodeURIComponent(`${username}_${password}_${type || 'm3u_plus'}`).slice(0, 40);
  const manifest = await getOrCreatePlaylist(
    'XC',
    playlistId,
    async () => fetchXCPlaylist(username, password, type || 'm3u_plus'),
    `Shanny IPTV (XC - ${username})`
  );

  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

// ---------------- OPTIONAL ENV MODE PRELOAD ----------------
(async () => {
  if (ENV_M3U) {
    const playlistId = 'env';
    console.log('⬇️ Preloading ENV M3U...');
    const { channels, categories } = await fetchM3U(ENV_M3U);
    let epgData = {};
    if (ENV_EPG) epgData = await fetchEPG(ENV_EPG);
    playlists[playlistId] = { channels, categories, epgData, addon: createAddon(playlistId) };
    console.log(`✅ Loaded ${channels.length} channels from ENV M3U_URL`);
  }
})();

// ---------------- UI HOMEPAGE with One-click Install ----------------
app.get('/', (req, res) => {
  const baseURL = process.env.BASE_URL || `https://localhost:7000`;
  res.send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Shanny IPTV Addon</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gray-900 text-white p-8">
    <div class="max-w-xl mx-auto">
      <h1 class="text-3xl font-bold mb-4">Shanny IPTV Addon</h1>
      <form class="space-y-4" onsubmit="event.preventDefault(); generateM3ULink();">
        <label class="block">Enter M3U URL:
          <input type="url" id="m3uUrl" class="w-full p-2 rounded text-black" placeholder="http://example.com/playlist.m3u" required>
        </label>
        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 p-2 rounded">Generate Stremio M3U Install Link</button>
      </form>
      <div id="m3uLink" class="mt-2"></div>

      <form class="space-y-4 mt-6" onsubmit="event.preventDefault(); generateXCLink();">
        <label class="block">XC Username:
          <input type="text" id="xcUsername" class="w-full p-2 rounded text-black" placeholder="username" required>
        </label>
        <label class="block">XC Password:
          <input type="text" id="xcPassword" class="w-full p-2 rounded text-black" placeholder="password" required>
        </label>
        <label class="block">XC Type:
          <input type="text" id="xcType" class="w-full p-2 rounded text-black" placeholder="m3u_plus (default)">
        </label>
        <button type="submit" class="w-full bg-green-600 hover:bg-green-700 p-2 rounded">Generate Stremio XC Install Link</button>
      </form>
      <div id="xcLink" class="mt-2"></div>
    </div>

    <script>
      function generateM3ULink() {
        const url = encodeURIComponent(document.getElementById('m3uUrl').value);
        const link = '${baseURL}/addon/m3u/manifest.json?m3uUrl=' + url;
        document.getElementById('m3uLink').innerHTML = '<a href="stremio://addon?url=' + link + '" class="text-blue-400 underline">Click here to install M3U addon in Stremio</a>';
      }
      function generateXCLink() {
        const username = document.getElementById('xcUsername').value;
        const password = document.getElementById('xcPassword').value;
        const type = document.getElementById('xcType').value || 'm3u_plus';
        const link = '${baseURL}/addon/xc/manifest.json?username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password) + '&type=' + encodeURIComponent(type);
        document.getElementById('xcLink').innerHTML = '<a href="stremio://addon?url=' + link + '" class="text-green-400 underline">Click here to install XC addon in Stremio</a>';
      }
    </script>
  </body>
  </html>
  `);
});

// ---------------- SERVE STREMIO ADDONS ----------------
app.get('/addon/:type/:playlistId/*', (req, res, next) => {
  const playlist = playlists[req.params.playlistId];
  if (!playlist) return res.status(404).send('Playlist not found');
  const addonInterface = playlist.addon.getInterface();
  addonInterface(req, res, next);
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🚀 Shanny IPTV Addon running on port ${PORT}`));
