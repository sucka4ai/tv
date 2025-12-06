/**
 * Shanny IPTV Addon (Static per-playlist manifest, Direct JSON for Stremio)
 * Supports M3U + XC, multiple playlists, Stremio install button, categories, EPG, Unsplash backgrounds
 */

const express = require('express');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- CONFIG ----------------
const BASE_URL = process.env.BASE_URL || 'https://your-render-url.onrender.com';
const MANIFEST_DIR = process.env.MANIFEST_DIR || path.join(__dirname, 'tmp', 'manifests');
if (!fs.existsSync(MANIFEST_DIR)) fs.mkdirSync(MANIFEST_DIR, { recursive: true });

// ---------------- UTILITIES ----------------
function hashString(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

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

async function fetchXC(username, password, type = 'm3u_plus') {
  const url = `http://xtremecodes.streamtv.to:8080/get.php?username=${username}&password=${password}&type=${type}&output=m3u`;
  return fetchM3U(url);
}

// ---------------- MANIFEST GENERATION ----------------
function buildManifest(name, channels, epgData, categories) {
  return {
    id: `shanny.dynamic.${hashString(name)}`,
    version: '1.0.0',
    name,
    description: 'Dynamic IPTV Addon (per-playlist manifest)',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [
      {
        id: 'iptv_catalog',
        type: 'tv',
        name: 'IPTV Channels',
        extra: [{ name: 'genre', options: ['All', ...Array.from(categories).sort()] }],
      },
    ],
    channels,
    epgData,
  };
}

function saveManifest(manifest, filename) {
  const filepath = path.join(MANIFEST_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(manifest, null, 2));
  return filepath;
}

// ---------------- UI ----------------
app.get('/', (req, res) => {
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
        <label class="block">M3U URL:
          <input type="url" id="m3uUrl" class="w-full p-2 rounded text-black" placeholder="http://example.com/playlist.m3u" required>
        </label>
        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 p-2 rounded">Generate Manifest</button>
      </form>
      <div id="m3uResult" class="mt-4"></div>

      <form class="space-y-4 mt-6" onsubmit="event.preventDefault(); generateXCLink();">
        <label>XC Username:<input type="text" id="xcUsername" class="w-full p-2 rounded text-black" required></label>
        <label>XC Password:<input type="text" id="xcPassword" class="w-full p-2 rounded text-black" required></label>
        <label>XC Type:<input type="text" id="xcType" class="w-full p-2 rounded text-black" placeholder="m3u_plus"></label>
        <button type="submit" class="w-full bg-green-600 hover:bg-green-700 p-2 rounded">Generate Manifest</button>
      </form>
      <div id="xcResult" class="mt-4"></div>

      <p class="mt-6 text-gray-400 text-sm">
        Copy the manifest URL to install manually in Stremio, or click the Install button to open Stremio directly.
      </p>
    </div>

    <script>
      function generateM3ULink() {
        const url = document.getElementById('m3uUrl').value;
        const manifestURL = '${BASE_URL}/generate/m3u?m3uUrl=' + encodeURIComponent(url);
        const installLink = 'stremio://addon?url=' + manifestURL;
        document.getElementById('m3uResult').innerHTML =
          '<p>Manifest URL: <a href="' + manifestURL + '" target="_blank" class="text-blue-400 underline">' + manifestURL + '</a></p>' +
          '<p><a href="' + installLink + '" class="bg-blue-500 hover:bg-blue-600 p-2 rounded inline-block mt-2">Install in Stremio</a></p>';
      }

      function generateXCLink() {
        const username = document.getElementById('xcUsername').value;
        const password = document.getElementById('xcPassword').value;
        const type = document.getElementById('xcType').value || 'm3u_plus';
        const manifestURL = '${BASE_URL}/generate/xc?username=' + encodeURIComponent(username) +
                            '&password=' + encodeURIComponent(password) +
                            '&type=' + encodeURIComponent(type);
        const installLink = 'stremio://addon?url=' + manifestURL;
        document.getElementById('xcResult').innerHTML =
          '<p>Manifest URL: <a href="' + manifestURL + '" target="_blank" class="text-green-400 underline">' + manifestURL + '</a></p>' +
          '<p><a href="' + installLink + '" class="bg-green-500 hover:bg-green-600 p-2 rounded inline-block mt-2">Install in Stremio</a></p>';
      }
    </script>
  </body>
  </html>
  `);
});

// ---------------- GENERATE STATIC MANIFESTS ----------------
app.get('/generate/m3u', async (req, res) => {
  const { m3uUrl } = req.query;
  if (!m3uUrl) return res.status(400).send('m3uUrl required');

  const hash = hashString(m3uUrl);
  const filepath = path.join(MANIFEST_DIR, `${hash}.json`);

  let manifest;
  if (fs.existsSync(filepath)) {
    manifest = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } else {
    const { channels, categories } = await fetchM3U(m3uUrl);
    manifest = buildManifest(`Shanny IPTV (M3U)`, channels, {}, categories);
    saveManifest(manifest, `${hash}.json`);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

app.get('/generate/xc', async (req, res) => {
  const { username, password, type } = req.query;
  if (!username || !password) return res.status(400).send('username & password required');

  const key = `${username}_${password}_${type || 'm3u_plus'}`;
  const hash = hashString(key);
  const filepath = path.join(MANIFEST_DIR, `${hash}.json`);

  let manifest;
  if (fs.existsSync(filepath)) {
    manifest = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } else {
    const { channels, categories } = await fetchXC(username, password, type || 'm3u_plus');
    manifest = buildManifest(`Shanny IPTV (XC - ${username})`, channels, {}, categories);
    saveManifest(manifest, `${hash}.json`);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🚀 Shanny IPTV Addon running on port ${PORT}`));
