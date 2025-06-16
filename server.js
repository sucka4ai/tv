// server.js
const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');
const dayjs = require('dayjs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';

app.use(cors());

let channels = [];
let epgData = {}; // { tvg-id: [programs] }
let catalogsByGroup = {};
let favorites = new Set();

async function loadM3U() {
  try {
    const res = await fetch(M3U_URL);
    if (!res.ok) throw new Error(`Failed to fetch M3U (${res.status})`);
    const text = await res.text();
    const parsed = m3uParser.parse(text);

    channels = parsed.items.map((item, index) => ({
      id: `iptv:${index}`,
      name: item.name || `Channel ${index}`,
      description: item.tvg?.name || '',
      logo: item.tvg?.logo || '',
      tvgId: item.tvg?.id || '',
      country: item.tvg?.country || 'Unknown',
      language: item.tvg?.language || 'Unknown',
      group: item.group?.title || 'Other',
      url: item.url
    }));

    catalogsByGroup = {};
    for (const ch of channels) {
      if (!catalogsByGroup[ch.group]) catalogsByGroup[ch.group] = [];
      catalogsByGroup[ch.group].push(ch);
    }

    console.log(`✅ Loaded ${channels.length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load M3U:', err);
  }
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    if (!res.ok) throw new Error(`Failed to fetch EPG (${res.status})`);
    const xml = await res.text();

    const parsed = await xml2js.parseStringPromise(xml, { mergeAttrs: true });

    epgData = {};
    if (parsed.tv && parsed.tv.programme) {
      for (const prog of parsed.tv.programme) {
        const channelId = prog.channel?.[0];
        if (!channelId) continue;
        if (!epgData[channelId]) epgData[channelId] = [];
        epgData[channelId].push({
          title: prog.title?.[0]?._ || '',
          start: prog.start?.[0] || '',
          stop: prog.stop?.[0] || '',
          desc: prog.desc?.[0]?._ || '',
          category: prog.category?.[0]?._ || ''
        });
      }
    }

    console.log(`✅ Loaded EPG data for ${Object.keys(epgData).length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load EPG:', err);
  }
}

function getNowNext(tvgId) {
  const now = dayjs();
  const programs = epgData[tvgId] || [];
  let current = null, next = null;
  for (let i = 0; i < programs.length; i++) {
    const start = dayjs(programs[i].start, 'YYYYMMDDHHmmss Z');
    const stop = dayjs(programs[i].stop, 'YYYYMMDDHHmmss Z');
    if (now.isAfter(start) && now.isBefore(stop)) {
      current = programs[i];
      next = programs[i + 1];
      break;
    }
  }
  return { current, next };
}

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  const catalogs = Object.keys(catalogsByGroup).map(group => ({
    type: 'tv',
    id: `iptv_${group.replace(/\s+/g, '_')}`,
    name: `IPTV - ${group}`
  }));

  catalogs.push({
    type: 'tv',
    id: 'iptv_all',
    name: 'IPTV - All Channels',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'genre', options: Object.keys(catalogsByGroup), isRequired: false },
      { name: 'country', isRequired: false },
      { name: 'language', isRequired: false }
    ]
  });

  catalogs.push({
    type: 'tv',
    id: 'iptv_favorites',
    name: 'IPTV - Favorites'
  });

  res.json({
    id: "com.iptv.addon",
    version: "4.0.0",
    name: "Full IPTV Addon",
    description: "IPTV with EPG, now/next, search, filters, favorites and proxy",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png",
    resources: ["catalog", "stream"],
    types: ["tv"],
    idPrefixes: ["iptv:"],
    catalogs
  });
});

// Catalog endpoint
app.get('/catalog/tv/:id.json', (req, res) => {
  const { id } = req.params;
  const { search = '', genre, country, language } = req.query;

  let filtered = [];

  if (id === 'iptv_all') {
    filtered = channels;
  } else if (id === 'iptv_favorites') {
    filtered = channels.filter(c => favorites.has(c.id));
  } else if (id.startsWith('iptv_')) {
    const group = id.replace('iptv_', '').replace(/_/g, ' ');
    filtered = catalogsByGroup[group] || [];
  } else {
    return res.status(404).send('Catalog not found');
  }

  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  if (genre) filtered = filtered.filter(c => c.group === genre);
  if (country) filtered = filtered.filter(c => c.country.toLowerCase().includes(country.toLowerCase()));
  if (language) filtered = filtered.filter(c => c.language.toLowerCase().includes(language.toLowerCase()));

  const metas = filtered.map(c => {
    const { current, next } = getNowNext(c.tvgId);
    return {
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.logo,
      description: current ? `${current.title} (Now)\nNext: ${next?.title || 'N/A'}` : c.description,
      genres: [c.group]
    };
  });

  res.json({ metas });
});

// Stream endpoint - returns proxied stream URL
app.get('/stream/tv/:id.json', (req, res) => {
  const id = req.params.id;
  if (!id.startsWith('iptv:')) return res.status(404).send('Invalid stream ID');
  const index = parseInt(id.split(':')[1], 10);

  if (isNaN(index) || !channels[index]) return res.status(404).send('Channel not found');

  const channel = channels[index];

  // Build proxied URL for Samsung TV compatibility
  const proxiedStreamUrl = `${req.protocol}://${req.get('host')}/proxy/${encodeURIComponent(channel.url)}`;

  res.json({
    streams: [{
      title: channel.name,
      url: proxiedStreamUrl
    }]
  });
});

// Favorites endpoints
app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') favorites.add(id);
  else if (action === 'remove') favorites.delete(id);
  else return res.status(400).send('Invalid action');

  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

// Proxy middleware to forward stream requests
app.use('/proxy', createProxyMiddleware({
  changeOrigin: true,
  logLevel: 'debug',
  router: (req) => {
    const targetUrl = decodeURIComponent(req.url.slice(1));
    return targetUrl;
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(500).send('Proxy error');
    }
  },
  timeout: 15000,
  proxyTimeout: 15000,
}));

// Serve simple UI from /ui
app.use('/ui', express.static(path.join(__dirname, 'public')));

// Serve root with redirect to UI
app.get('/', (req, res) => {
  res.redirect('/ui');
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadM3U();
  await loadEPG();
});
