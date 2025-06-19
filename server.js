const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;
const PORT = process.env.PORT || 10000;

let channels = [];
let epgData = {};

const parseM3U = async (url) => {
  const response = await axios.get(url);
  const lines = response.data.split('\n');
  const result = [];

  let current = {};
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#EXTINF')) {
      const nameMatch = line.match(/,(.*)$/);
      const groupMatch = line.match(/group-title="(.*?)"/);
      current = {
        name: nameMatch ? nameMatch[1].trim() : 'Unknown',
        group: groupMatch ? groupMatch[1] : 'Other'
      };
    } else if (line && !line.startsWith('#')) {
      current.url = line.trim();
      result.push({ ...current });
    }
  }
  return result;
};

const parseEPG = async (url) => {
  const response = await axios.get(url);
  const parsed = await xml2js.parseStringPromise(response.data);
  const epg = {};

  for (const prog of parsed.tv.programme || []) {
    const channel = prog.$.channel;
    const start = prog.$.start;
    const stop = prog.$.stop;
    const title = prog.title?.[0] || '';
    const now = new Date();
    const startTime = new Date(start.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
    const endTime = new Date(stop.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));

    if (now >= startTime && now < endTime) {
      epg[channel] = title;
    }
  }

  return epg;
};

const loadData = async () => {
  try {
    channels = await parseM3U(M3U_URL);
    epgData = await parseEPG(EPG_URL);
    console.log(`Loaded ${channels.length} channels and EPG for ${Object.keys(epgData).length} entries`);
  } catch (err) {
    console.error('Error loading data:', err.message);
  }
};

const builder = new addonBuilder({
  id: 'org.custom.iptv',
  version: '1.0.0',
  name: 'Custom IPTV with EPG',
  description: 'Live IPTV channels with category filtering and EPG now/next',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'iptv_live',
      name: 'Live IPTV Channels',
      extra: [{ name: 'search' }, { name: 'genre' }]
    }
  ],
  resources: ['catalog', 'stream', 'meta']
});

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv' || id !== 'iptv_live') return { metas: [] };

  let filtered = channels;

  if (extra?.genre) {
    filtered = filtered.filter(c => c.group?.toLowerCase() === extra.genre.toLowerCase());
  }

  if (extra?.search) {
    filtered = filtered.filter(c => c.name.toLowerCase().includes(extra.search.toLowerCase()));
  }

  const metas = filtered.map((c, i) => ({
    id: 'channel_' + i,
    name: c.name,
    type: 'tv',
    poster: 'https://img.icons8.com/color/96/000000/retro-tv.png',
    genre: [c.group]
  }));

  return Promise.resolve({ metas });
});

console.log('Catalog request received:', { type, id, extra });
console.log('Number of channels loaded:', channels.length);

builder.defineStreamHandler(({ type, id }) => {
  const index = parseInt(id.replace('channel_', ''));
  const ch = channels[index];
  if (!ch) return Promise.resolve({ streams: [] });

  const epgTitle = epgData[ch.name] || '';
  const streamTitle = epgTitle ? `${ch.name} - Now: ${epgTitle}` : ch.name;

  return Promise.resolve({
    streams: [{
      title: streamTitle,
      url: ch.url
    }]
  });
});

builder.defineMetaHandler(({ type, id }) => {
  const index = parseInt(id.replace('channel_', ''));
  const ch = channels[index];
  if (!ch) return Promise.resolve({ meta: {} });

  return Promise.resolve({
    meta: {
      id,
      type: 'tv',
      name: ch.name,
      description: `Live stream from group: ${ch.group}`,
      genres: [ch.group],
      poster: 'https://img.icons8.com/color/96/000000/retro-tv.png'
    }
  });
});

const stremioInterface = builder.getInterface();

// ✅ Manual route setup
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(stremioInterface.manifest);
});

app.get('/:resource/:type/:id.json', async (req, res) => {
  try {
    const { resource, type, id } = req.params;
    const args = { type, id, extra: req.query };

    const result = await stremioInterface.get(resource, args);
    res.setHeader('Content-Type', 'application/json');
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ err: err.message });
  }
});

setInterval(loadData, 15 * 60 * 1000);
loadData();

app.listen(PORT, () => {
  console.log(`Addon server running on http://localhost:${PORT}`);
});
