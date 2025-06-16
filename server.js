// IPTV Addon for Stremio with EPG, Now/Next, Proxy Support, and Web UI
// Add this at the very top of server.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';
const CACHE_TIME = process.env.CACHE_TIME || 3600; // 1 hour cache

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let channels = [];
let epgData = {};
let catalogsByGroup = {};
let favorites = new Set();
let lastUpdated = null;

// Middleware for logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

async function loadM3U() {
  try {
    console.log('Loading M3U playlist...');
    const res = await fetch(M3U_URL);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    
    const text = await res.text();
    if (!text.includes('#EXTM3U')) throw new Error('Invalid M3U file format');
    
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
    for (const channel of channels) {
      if (!catalogsByGroup[channel.group]) {
        catalogsByGroup[channel.group] = [];
      }
      catalogsByGroup[channel.group].push(channel);
    }

    lastUpdated = new Date();
    console.log(`✅ Loaded ${channels.length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load M3U:', err);
    // Retry after 30 seconds on failure
    setTimeout(loadM3U, 30000);
  }
}

async function loadEPG() {
  try {
    console.log('Loading EPG data...');
    const res = await fetch(EPG_URL);
    const contentType = res.headers.get('content-type') || '';
    
    if (!contentType.includes('xml') && !contentType.includes('text')) {
      throw new Error(`Invalid content-type for EPG: ${contentType}`);
    }
    
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, { 
      mergeAttrs: true,
      explicitArray: false 
    });

    epgData = {};
    const programmes = parsed.tv.programme || [];
    
    for (const prog of programmes) {
      const channelId = prog.channel;
      if (!channelId) continue;
      
      if (!epgData[channelId]) epgData[channelId] = [];
      
      epgData[channelId].push({
        title: prog.title?._ || prog.title || '',
        start: prog.start,
        stop: prog.stop,
        desc: prog.desc?._ || prog.desc || '',
        category: prog.category?._ || prog.category || ''
      });
    }

    console.log(`✅ Loaded EPG data for ${Object.keys(epgData).length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load EPG:', err);
    // Retry after 5 minutes on failure
    setTimeout(loadEPG, 300000);
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
    version: "3.2.0",
    name: "Full IPTV Addon",
    description: "IPTV with EPG, now/next, search, filters, favorites, and web UI",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png",
    resources: ["catalog", "stream"],
    types: ["tv"],
    idPrefixes: ["iptv:"],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    }
  });
});

// Catalog endpoint
app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  const { search = '', genre, country, language } = req.query;
  
  if (type !== 'tv') return res.status(404).send('Invalid type');

  let filtered = [];
  if (id === 'iptv_all') {
    filtered = channels;
  } else if (id === 'iptv_favorites') {
    filtered = channels.filter(c => favorites.has(c.id));
  } else if (id.startsWith('iptv_')) {
    const group = id.replace('iptv_', '').replace(/_/g, ' ');
    filtered = catalogsByGroup[group] || [];
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
      poster: c.logo || 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png',
      description: current 
        ? `Now: ${current.title}\nNext: ${next?.title || 'N/A'}\n${current.desc || ''}` 
        : c.description,
      genres: [c.group],
      releaseInfo: c.country + (c.language ? ` (${c.language})` : '')
    };
  });

  res.json({ metas });
});

// Stream endpoint
app.get('/stream/:type/:id.json', (req, res) => {
  if (req.params.type !== 'tv' || !req.params.id.startsWith('iptv:')) {
    return res.status(404).send('Invalid stream');
  }

  const index = parseInt(req.params.id.split(':')[1], 10);
  const channel = channels[index];
  if (!channel) return res.status(404).send('Channel not found');

  // Determine protocol (support reverse proxy)
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  
  const streamUrl = `${protocol}://${host}/proxy?url=${encodeURIComponent(channel.url)}`;
  
  res.json({
    streams: [{
      title: channel.name,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true, // Important for Smart TV compatibility
        proxyHeaders: {
          request: {
            accept: '*/*',
            'user-agent': 'Mozilla/5.0'
          }
        }
      }
    }]
  });
});

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  const url = decodeURIComponent(req.query.url);
  if (!url) return res.status(400).send('Missing URL');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': new URL(url).origin,
        'Origin': new URL(url).origin
      }
    });
    
    // Set proper streaming headers
    res.set({
      'Content-Type': response.headers.get('content-type') || 'video/mp4',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Pipe the stream
    response.body.pipe(res);
  } catch (err) {
    console.error('Proxy fetch failed:', err);
    res.status(502).send('Stream proxy error');
  }
});

// Favorites management
app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') favorites.add(id);
  else if (action === 'remove') favorites.delete(id);
  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    channels: channels.length,
    epgChannels: Object.keys(epgData).length,
    lastUpdated,
    memoryUsage: process.memoryUsage()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server and load initial data
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadM3U();
  await loadEPG();
  
  // Schedule regular refreshes
  setInterval(loadM3U, CACHE_TIME * 1000);
  setInterval(loadEPG, CACHE_TIME * 1000 * 2); // EPG updates less frequently
});
