const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const express = require('express');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');
const dayjs = require('dayjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';
const CACHE_TIME = process.env.CACHE_TIME || 3600;

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Range', 'Accept'],
  exposedHeaders: ['Content-Length', 'Content-Range']
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let channels = [];
let epgData = {};
let catalogsByGroup = {};
let lastUpdated = null;

// Improved M3U loader with validation
async function loadM3U() {
  try {
    console.log('Loading M3U playlist...');
    const res = await fetch(M3U_URL, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const text = await res.text();
    if (!text.includes('#EXTM3U')) throw new Error('Invalid M3U format');
    
    const parsed = m3uParser.parse(text);
    channels = parsed.items.filter(item => item.url).map((item, index) => ({
      id: `iptv_${index}`,
      name: item.name || `Channel ${index}`,
      description: item.tvg?.name || '',
      poster: item.tvg?.logo || 'https://i.imgur.com/x7KjTfW.png',
      logo: item.tvg?.logo || 'https://i.imgur.com/x7KjTfW.png',
      tvgId: item.tvg?.id || `ch${index}`,
      genres: [item.group?.title || 'General'],
      group: item.group?.title || 'General',
      url: item.url
    }));

    catalogsByGroup = {};
    channels.forEach(channel => {
      if (!catalogsByGroup[channel.group]) {
        catalogsByGroup[channel.group] = [];
      }
      catalogsByGroup[channel.group].push(channel);
    });

    lastUpdated = new Date();
    console.log(`Loaded ${channels.length} valid channels`);
  } catch (err) {
    console.error('M3U Error:', err.message);
    setTimeout(loadM3U, 30000);
  }
}

// Enhanced EPG loader
async function loadEPG() {
  try {
    console.log('Loading EPG data...');
    const res = await fetch(EPG_URL, { timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, {
      mergeAttrs: true,
      explicitArray: false
    });

    epgData = {};
    (parsed.tv.programme || []).forEach(prog => {
      const channelId = prog.channel;
      if (!channelId) return;
      
      if (!epgData[channelId]) epgData[channelId] = [];
      
      epgData[channelId].push({
        title: prog.title?._ || prog.title || '',
        start: prog.start,
        stop: prog.stop,
        desc: prog.desc?._ || prog.description || '',
        category: prog.category?._ || prog.category || ''
      });
    });
    console.log(`Loaded EPG for ${Object.keys(epgData).length} channels`);
  } catch (err) {
    console.error('EPG Error:', err.message);
    setTimeout(loadEPG, 300000);
  }
}

// Metadata endpoint - Fixed to match Stremio's expected format
app.get('/stream/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  
  if (type !== 'tv' || !id.startsWith('iptv_')) {
    return res.status(404).json({ error: 'Invalid request' });
  }

  const index = parseInt(id.replace('iptv_', ''), 10);
  const channel = channels[index];
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  // Get now/next program info
  const programs = epgData[channel.tvgId] || [];
  const now = dayjs();
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

  // Response format that Stremio expects
  res.json({
    meta: {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      poster: channel.poster,
      posterShape: 'square',
      background: channel.poster,
      logo: channel.logo,
      description: current ? 
        `Now: ${current.title}\nNext: ${next?.title || 'N/A'}\n${current.desc || ''}` : 
        channel.description,
      genres: channel.genres,
      releaseInfo: channel.group
    },
    streams: [
      {
        title: `Stream: ${channel.name}`,
        url: `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(channel.url)}`,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Accept': '*/*',
              'User-Agent': 'Mozilla/5.0',
              'Referer': new URL(channel.url).origin,
              'Origin': new URL(channel.url).origin
            }
          },
          bufferSize: 512 * 1024
        }
      }
    ]
  });
});

// Fixed proxy endpoint
app.get('/proxy', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': new URL(url).origin,
        'Origin': new URL(url).origin
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Set proper streaming headers
    res.set({
      'Content-Type': response.headers.get('content-type') || 'video/mp4',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    });

    response.body.pipe(res);
  } catch (err) {
    console.error('Proxy Error:', err.message);
    res.status(502).json({ 
      error: 'Stream failed',
      message: err.message
    });
  }
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json({
    id: "com.iptv.fixed",
    version: "4.0.0",
    name: "Fixed IPTV Addon",
    description: "With working metadata and streams",
    logo: "https://i.imgur.com/x7KjTfW.png",
    resources: ["stream"],
    types: ["tv"],
    idPrefixes: ["iptv_"],
    catalogs: [],
    behaviorHints: {
      configurable: false
    }
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await Promise.all([loadM3U(), loadEPG()]);
  setInterval(loadM3U, CACHE_TIME * 1000);
  setInterval(loadEPG, CACHE_TIME * 1000 * 2);
});
