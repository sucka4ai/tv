require('dotenv').config();
const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const { parse } = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};

const builder = new addonBuilder({
  id: 'org.stremio.iptvaddon',
  version: '1.0.0',
  name: 'IPTV Addon',
  description: 'Stremio Addon for custom M3U playlist and EPG support',
  catalogs: [
    {
      type: 'tv',
      id: 'iptv',
      name: 'Live TV',
      extra: [{ name: 'genre' }]
    }
  ],
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv']
});

async function loadPlaylist() {
  const res = await fetch(M3U_URL);
  const text = await res.text();
  channels = parse(text).items.filter(item => item.tvg.id || item.name);
}

async function loadEPG() {
  const res = await fetch(EPG_URL);
  const xml = await res.text();
  const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true });

  epgData = {};

  if (result.tv && result.tv.programme) {
    result.tv.programme.forEach(entry => {
      const channel = entry.channel?.[0];
      const start = dayjs(entry.start?.[0], 'YYYYMMDDHHmmss ZZ');
      const stop = dayjs(entry.stop?.[0], 'YYYYMMDDHHmmss ZZ');
      const now = dayjs();

      if (!epgData[channel]) epgData[channel] = [];

      if (now.isBetween(start, stop)) {
        epgData[channel].push({
          title: entry.title?.[0] || 'Now Playing',
          desc: entry.desc?.[0] || '',
          start: start.toISOString(),
          stop: stop.toISOString()
        });
      }
    });
  }
}

builder.defineCatalogHandler(async ({ extra }) => {
  const genreFilter = extra?.genre;
  const items = channels
    .filter(c => !genreFilter || (c.group && c.group.title === genreFilter))
    .map(channel => ({
      id: channel.tvg.id || channel.name,
      type: 'tv',
      name: channel.name,
      poster: channel.tvg.logo || null,
      description: `Live Channel: ${channel.name}`,
    }));
  return { metas: items };
});

builder.defineMetaHandler(async ({ id }) => {
  const channel = channels.find(c => c.tvg.id === id || c.name === id);
  if (!channel) return { meta: {} };

  const epg = epgData[channel.tvg.id] || [];
  const now = epg[0] || {};

  return {
    meta: {
      id: channel.tvg.id || channel.name,
      type: 'tv',
      name: channel.name,
      poster: channel.tvg.logo || null,
      description: `Now: ${now.title || 'Live TV'}\n${now.desc || ''}`
    }
  };
});

builder.defineStreamHandler(async ({ id }) => {
  const channel = channels.find(c => c.tvg.id === id || c.name === id);
  if (!channel) return { streams: [] };

  return {
    streams: [
      {
        title: 'Watch',
        url: channel.url
      }
    ]
  };
});

async function start() {
  try {
    console.log('Loading playlist and EPG...');
    await loadPlaylist();
    await loadEPG();
    console.log('Channels:', channels.length);
    console.log('EPG entries:', Object.keys(epgData).length);
  } catch (err) {
    console.error('Startup Error:', err);
  }

  const app = require('express')();
  const cors = require('cors');

  app.use(cors());
  app.get('/manifest.json', (_, res) => res.json(builder.getInterface().manifest));
  app.get('/:resource/:type/:id/:extra?.json', (req, res) => {
    builder.getInterface().get(req, res);
  });

  const PORT = process.env.PORT || 7000;
  app.listen(PORT, () => {
    console.log(`Addon running at http://localhost:${PORT}`);
  });
}

start();

module.exports = builder.getInterface();
