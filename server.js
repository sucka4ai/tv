// IPTV Addon for Stremio with Android/TV Compatibility
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
  methods: ['GET', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range']
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let channels = [];
let epgData = {};
let catalogsByGroup = {};
let favorites = new Set();
let lastUpdated = null;

// Configuration endpoint
app.get('/configure', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>IPTV Addon Configuration</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input { width: 100%; padding: 8px; box-sizing: border-box; }
        button { background: #0066cc; color: white; border: none; padding: 10px 15px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>IPTV Addon Configuration</h1>
      <div id="status"></div>
      <form id="configForm">
        <div class="form-group">
          <label for="m3uUrl">M3U Playlist URL:</label>
          <input type="text" id="m3uUrl" name="m3uUrl" value="${M3U_URL}" required>
        </div>
        <div class="form-group">
          <label for="epgUrl">EPG Guide URL:</label>
          <input type="text" id="epgUrl" name="epgUrl" value="${EPG_URL}">
        </div>
        <button type="submit">Save Configuration</button>
      </form>
      <script>
        document.getElementById('configForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const statusEl = document.getElementById('status');
          statusEl.innerHTML = '<p>Saving configuration...</p>';
          
          try {
            const response = await fetch('/configure/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                m3uUrl: document.getElementById('m3uUrl').value,
                epgUrl: document.getElementById('epgUrl').value
              })
            });
            
            const result = await response.json();
            if (result.success) {
              statusEl.innerHTML = '<p style="color:green">Configuration saved successfully! Restarting addon...</p>';
              setTimeout(() => location.reload(), 2000);
            } else {
              statusEl.innerHTML = '<p style="color:red">Error: ' + result.message + '</p>';
            }
          } catch (err) {
            statusEl.innerHTML = '<p style="color:red">Connection error: ' + err.message + '</p>';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Configuration save endpoint
app.post('/configure/save', (req, res) => {
  // In a real implementation, you would save these to a database or config file
  console.log('New configuration received:', req.body);
  res.json({ 
    success: true,
    message: 'Configuration received (demo only - not persisted)'
  });
});

async function loadM3U() {
  try {
    console.log('Loading M3U playlist...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const res = await fetch(M3U_URL, { signal: controller.signal });
    clearTimeout(timeout);
    
    if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    
    const text = await res.text();
    if (!text.includes('#EXTM3U')) throw new Error('Invalid M3U format');
    
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
    channels.forEach(channel => {
      if (!catalogsByGroup[channel.group]) {
        catalogsByGroup[channel.group] = [];
      }
      catalogsByGroup[channel.group].push(channel);
    });

    lastUpdated = new Date();
    console.log(`✅ Loaded ${channels.length} channels.`);
  } catch (err) {
    console.error('❌ M3U Error:', err.message);
    setTimeout(loadM3U, 30000);
  }
}

async function loadEPG() {
  try {
    console.log('Loading EPG data...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    
    const res = await fetch(EPG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    
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

    console.log(`✅ Loaded EPG for ${Object.keys(epgData).length} channels.`);
  } catch (err) {
    console.error('❌ EPG Error:', err.message);
    setTimeout(loadEPG, 300000);
  }
}

function getNowNext(tvgId) {
  const now = dayjs();
  const programs = epgData[tvgId] || [];
  
  for (let i = 0; i < programs.length; i++) {
    const start = dayjs(programs[i].start, 'YYYYMMDDHHmmss Z');
    const stop = dayjs(programs[i].stop, 'YYYYMMDDHHmmss Z');
    
    if (now.isAfter(start) && now.isBefore(stop)) {
      return {
        current: programs[i],
        next: programs[i + 1]
      };
    }
  }
  return { current: null, next: null };
}

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  const catalogs = Object.keys(catalogsByGroup).map(group => ({
    type: 'tv',
    id: `iptv_${group.replace(/\s+/g, '_')}`,
    name: `IPTV - ${group}`
  }));

  catalogs.push(
    {
      type: 'tv',
      id: 'iptv_all',
      name: 'IPTV - All Channels',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', options: Object.keys(catalogsByGroup), isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'iptv_favorites',
      name: 'IPTV - Favorites'
    }
  );

  res.json({
    id: "com.iptv.addon",
    version: "3.5.0",
    name: "Complete IPTV Addon",
    description: "With configuration and Android/TV fixes",
    logo: "https://i.imgur.com/x7KjTfW.png",
    resources: ["catalog", "stream"],
    types: ["tv"],
    idPrefixes: ["iptv:"],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      configuration: {
        proxy: {
          type: "development",
          useCORS: true,
          path: "/configure"
        }
      }
    }
  });
});

// Catalog endpoint
app.get('/catalog/:type/:id.json', (req, res) => {
  if (req.params.type !== 'tv') return res.status(404).json({ error: 'Invalid type' });

  let filtered = [];
  switch (req.params.id) {
    case 'iptv_all':
      filtered = channels;
      break;
    case 'iptv_favorites':
      filtered = channels.filter(c => favorites.has(c.id));
      break;
    default:
      if (req.params.id.startsWith('iptv_')) {
        const group = req.params.id.replace('iptv_', '').replace(/_/g, ' ');
        filtered = catalogsByGroup[group] || [];
      }
  }

  const { search = '' } = req.query;
  if (search) {
    filtered = filtered.filter(c => 
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.tvgId.toLowerCase().includes(search.toLowerCase())
    );
  }

  res.json({
    metas: filtered.map(c => {
      const { current, next } = getNowNext(c.tvgId);
      return {
        id: c.id,
        type: 'tv',
        name: c.name,
        poster: c.logo || 'https://i.imgur.com/x7KjTfW.png',
        description: current ? 
          `Now: ${current.title}\nNext: ${next?.title || 'N/A'}\n${current.desc || ''}` : 
          c.description,
        genres: [c.group],
        releaseInfo: `${c.country}${c.language ? ` (${c.language})` : ''}`
      };
    })
  });
});

// Stream endpoint
app.get('/stream/:type/:id.json', (req, res) => {
  if (req.params.type !== 'tv' || !req.params.id.startsWith('iptv:')) {
    return res.status(404).json({ error: 'Invalid stream request' });
  }

  const index = parseInt(req.params.id.split(':')[1], 10);
  const channel = channels[index];
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const encodedUrl = encodeURIComponent(channel.url);
  const streamUrl = `${protocol}://${host}/proxy?url=${encodedUrl}`;

  res.json({
    streams: [{
      title: channel.name,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        bufferSize: 512 * 1024,
        proxyHeaders: {
          request: {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0',
            'Referer': new URL(channel.url).origin,
            'Origin': new URL(channel.url).origin
          }
        },
        http: {
          hlsLiveEdge: { max: 3 },
          streaming: { aggressive: true }
        }
      }
    }]
  });
});

// Proxy endpoint
app.get('/proxy', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url);
    if (!url) {
      console.error('Proxy error: Missing URL parameter');
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);
    }

    if ([301, 302, 307, 308].includes(response.status)) {
      return res.redirect(response.headers.get('location'));
    }

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
    console.error('Proxy error:', err.message);
    res.status(502).json({ 
      error: 'Stream unavailable',
      details: err.message,
      solution: 'Check if the stream URL is accessible from your server'
    });
  }
});

// Favorites endpoint
app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') favorites.add(id);
  else if (action === 'remove') favorites.delete(id);
  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    channels: channels.length,
    epgChannels: Object.keys(epgData).length,
    lastUpdated,
    memoryUsage: process.memoryUsage()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server Error:', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await Promise.all([loadM3U(), loadEPG()]);
  setInterval(loadM3U, CACHE_TIME * 1000);
  setInterval(loadEPG, CACHE_TIME * 1000 * 2);
});
