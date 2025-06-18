const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;

const M3U_URL = 'https://your-working-playlist-url.m3u';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';

let channels = [];
let epgMap = {}; // map[channelId] = [programmes]

async function loadM3U() {
  try {
    const response = await axios.get(M3U_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text',
    });

    const parsed = m3uParser.parse(response.data);
    channels = parsed.items.filter(i => i.url && i.name);
    console.log(`✅ Loaded ${channels.length} channels from M3U`);
  } catch (err) {
    console.error('❌ Error loading M3U:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Headers:', err.response.headers);
      console.error('Body:', err.response.data);
    }
  }
}

async function loadEPG() {
  try {
    const res = await axios.get(EPG_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text',
    });

    const parsed = await xml2js.parseStringPromise(res.data, { mergeAttrs: true });
    const programmes = parsed.tv.programme || [];
    epgMap = {};

    for (const prog of programmes) {
      const channelId = prog.channel?.[0];
      if (!epgMap[channelId]) epgMap[channelId] = [];
      epgMap[channelId].push(prog);
    }

    console.log(`✅ Loaded EPG for ${Object.keys(epgMap).length} channels`);
  } catch (err) {
    console.error('❌ Error loading EPG:', err.message);
  }
}

function getNowNextEpg(channelName) {
  const now = new Date();
  const epgList = epgMap[channelName] || [];

  const nowShow = epgList.find(p => new Date(p.start[0]) <= now && new Date(p.stop[0]) >= now);
  const nextShow = epgList.find(p => new Date(p.start[0]) > now);

  return {
    now: nowShow?.title?.[0] || null,
    next: nextShow?.title?.[0] || null,
  };
}

const manifest = {
  id: 'community.iptv.custom',
  version: '1.0.0',
  name: 'Custom IPTV Addon',
  description: 'Streams IPTV channels with EPG info',
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'iptv', name: 'Live TV' }],
  idPrefixes: ['iptv_'],
  logo: 'https://upload.wikimedia.org/wikipedia/commons/5/5f/Television_icon.png',
  background: 'https://wallpaperaccess.com/full/1567661.jpg',
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(() => {
  return Promise.resolve({
    metas: channels.map((channel, i) => ({
      id: `iptv_${i}`,
      type: 'tv',
      name: channel.name,
      poster: channel.tvg.logo || null,
      description: channel.group || '',
    })),
  });
});

builder.defineMetaHandler(({ id }) => {
  const index = parseInt(id.replace('iptv_', ''));
  const channel = channels[index];
  if (!channel) return Promise.resolve({ meta: {} });

  const epg = getNowNextEpg(channel.name);

  return Promise.resolve({
    meta: {
      id,
      type: 'tv',
      name: channel.name,
      poster: channel.tvg.logo || null,
      background: channel.tvg.logo || null,
      description: `Now: ${epg.now || 'N/A'} | Next: ${epg.next || 'N/A'}`,
    },
  });
});

builder.defineStreamHandler(({ id }) => {
  const index = parseInt(id.replace('iptv_', ''));
  const channel = channels[index];
  if (!channel) return Promise.resolve({ streams: [] });

  return Promise.resolve({
    streams: [{ title: channel.name, url: channel.url }],
  });
});

app.get('/manifest.json', (_, res) => {
  res.json(builder.getInterface().manifest);
});

app.get('/:resource/:type/:id/:extra?.json', async (req, res) => {
  const { resource, type, id } = req.params;
  const extra = req.params.extra ? JSON.parse(req.params.extra) : {};
  try {
    const result = await builder.getInterface().get(resource, type, id, extra);
    res.json(result);
  } catch (e) {
    console.error('Handler error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Addon server running on http://localhost:${PORT}`);
  await loadM3U();
  await loadEPG();
});
