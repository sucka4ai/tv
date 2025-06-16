// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const { addonBuilder } = require("stremio-addon-sdk");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// Static UI
app.use('/ui', express.static(path.join(__dirname, 'public')));

// M3U & EPG URL
const M3U_URL = 'https://iptv-org.github.io/iptv/countries/gb.m3u';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';

let channels = [];
let catalogMeta = [];

const loadChannels = async () => {
  try {
    const res = await fetch(M3U_URL);
    const m3uText = await res.text();
    const parsed = m3uParser.parse(m3uText);
    channels = parsed.items.map((item, index) => ({
      id: `iptv:${index}`,
      name: item.name,
      url: item.url,
      logo: item.tvg.logo,
      group: item.group.title || 'Other',
      epgId: item.tvg.id || null
    }));

    catalogMeta = channels.map((c, i) => ({
      id: `iptv:${i}`,
      type: 'tv',
      name: c.name,
      poster: c.logo,
      posterShape: 'square',
      background: c.logo,
    }));

    console.log(`✅ Loaded ${channels.length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load M3U playlist:', err);
  }
};

// Proxy stream
app.use('/proxy/:encodedUrl', async (req, res) => {
  try {
    const targetUrl = decodeURIComponent(req.params.encodedUrl);
    console.log(`🔁 Proxying stream: ${targetUrl}`);

    const proxyReq = await fetch(targetUrl, {
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Referer': targetUrl,
        'Origin': req.headers.origin || '',
        'Range': req.headers.range || 'bytes=0-'
      }
    });

    if (!proxyReq.ok) return res.status(500).send('❌ Could not fetch stream');

    res.set({
      'Content-Type': proxyReq.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': '*',
      'Accept-Ranges': 'bytes',
      'Content-Length': proxyReq.headers.get('content-length') || undefined
    });

    proxyReq.body.pipe(res);
  } catch (err) {
    console.error('❌ Proxy error:', err);
    res.status(500).send('❌ Proxy server failed');
  }
});

// Video test page
app.get('/test/:id', (req, res) => {
  const id = parseInt(req.params.id.replace('iptv:', ''), 10);
  const channel = channels[id];
  if (!channel) return res.status(404).send('Channel not found');
  const streamUrl = `/proxy/${encodeURIComponent(channel.url)}`;
  res.send(`
    <html><head><title>Stream Test</title></head><body style="background:#000;color:#fff;text-align:center;">
      <h2>${channel.name}</h2>
      <video width="90%" height="auto" controls autoplay>
        <source src="${streamUrl}" type="application/x-mpegURL">
        Your browser does not support the video tag.
      </video>
    </body></html>
  `);
});

// Stremio Addon
const builder = new addonBuilder({
  id: 'org.stremio.iptv',
  version: '1.0.0',
  name: 'IPTV Addon',
  description: 'Live TV from M3U playlist',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Internet_television_logo.svg',
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'iptv_catalog', name: 'Live TV' }],
  resources: ['catalog', 'stream', 'meta']
});

builder.defineCatalogHandler(() => {
  return Promise.resolve({ metas: catalogMeta });
});

builder.defineMetaHandler(({ id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ meta: {} });
  return Promise.resolve({
    meta: {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      logo: channel.logo,
      poster: channel.logo,
      background: channel.logo,
      posterShape: 'square'
    }
  });
});

builder.defineStreamHandler(({ id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ streams: [] });
  const encoded = encodeURIComponent(channel.url);
  return Promise.resolve({
    streams: [
      {
        title: channel.name,
        url: `http://localhost:${PORT}/proxy/${encoded}`
      }
    ]
  });
});

app.get('/manifest.json', (req, res) => {
  res.json(builder.getInterface().getManifest());
});

app.get('/catalog/:type/:id/:extra?.json', (req, res) => {
  builder.getInterface().handle(req).then(resp => res.json(resp)).catch(err => {
    console.error('Catalog error', err);
    res.status(500).send('Catalog error');
  });
});

app.get('/meta/:type/:id.json', (req, res) => {
  builder.getInterface().handle(req).then(resp => res.json(resp)).catch(err => {
    console.error('Meta error', err);
    res.status(500).send('Meta error');
  });
});

app.get('/stream/:type/:id.json', (req, res) => {
  builder.getInterface().handle(req).then(resp => res.json(resp)).catch(err => {
    console.error('Stream error', err);
    res.status(500).send('Stream error');
  });
});

loadChannels().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
});
