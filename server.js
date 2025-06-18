// server.js
const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const m3uParser = require('iptv-playlist-parser');
const xmltv = require('xmltv');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let categories = new Set();
let epgData = {};

async function loadEPG() {
  try {
    const res = await axios.get(EPG_URL);
    xmltv.parse(res.data, (err, data) => {
      if (!err && data.programme) {
        data.programme.forEach(prog => {
          if (!epgData[prog.channel]) epgData[prog.channel] = [];
          epgData[prog.channel].push(prog);
        });
        console.log(`✅ Loaded EPG for ${Object.keys(epgData).length} channels`);
      }
    });
  } catch (err) {
    console.error('❌ Error loading EPG:', err.message || err);
  }
}

async function loadM3U() {
  try {
    const res = await axios.get(M3U_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*'
      },
      timeout: 10000
    });
    const parsed = m3uParser.parse(res.data);
    channels = parsed.items.map((item, index) => {
      const id = `iptv_${index}`;
      if (item.group.title) categories.add(item.group.title);
      return {
        id,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo,
        group: item.group.title || 'Other',
        tvg: item.tvg
      };
    });
    console.log(`✅ Loaded ${channels.length} channels`);
  } catch (err) {
    console.error('❌ Error fetching M3U:', err.message || err);
  }
}

const builder = new addonBuilder({
  id: 'org.ip.addon',
  version: '1.0.0',
  name: 'Custom IPTV',
  description: 'IPTV with EPG and categories',
  types: ['tv'],
  catalogs: Array.from(categories).map(category => ({
    type: 'tv',
    id: category,
    name: category,
    extra: [{ name: 'search' }]
  })),
  resources: ['catalog', 'stream', 'meta'],
  idPrefixes: ['iptv_']
});

builder.defineCatalogHandler(({ id }) => {
  const metas = channels
    .filter(c => c.group === id)
    .map(c => ({
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.logo || '',
      posterShape: 'square'
    }));
  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ meta: {} });
  return Promise.resolve({
    meta: {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      poster: channel.logo || '',
      description: `Live TV Channel (${channel.group})`,
      background: channel.logo || ''
    }
  });
});

builder.defineStreamHandler(({ id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ streams: [] });
  const epgNow = epgData[channel.tvg.id]?.[0];
  const epgNext = epgData[channel.tvg.id]?.[1];
  const title = epgNow?.title[0]._ + (epgNext ? ` → ${epgNext.title[0]._}` : '');
  return Promise.resolve({
    streams: [{
      title: title || channel.name,
      url: channel.url
    }]
  });
});

app.get("/manifest.json", (req, res) => {
  res.send(builder.getInterface().getManifest());
});

app.get("/catalog/:type/:id/:extra?.json", (req, res) => {
  builder.getInterface().getCatalog(req.params).then(catalog => res.send(catalog)).catch(e => res.status(500).send(e));
});

app.get("/meta/:type/:id.json", (req, res) => {
  builder.getInterface().getMeta(req.params).then(meta => res.send(meta)).catch(e => res.status(500).send(e));
});

app.get("/stream/:type/:id.json", (req, res) => {
  builder.getInterface().getStream(req.params).then(stream => res.send(stream)).catch(e => res.status(500).send(e));
});

loadM3U().then(() => loadEPG().then(() => {
  app.listen(PORT, () => console.log(`🚀 Addon server running on http://localhost:${PORT}`));
}));
