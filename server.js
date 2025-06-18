const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const xml2js = require('xml2js');
const m3uParser = require('iptv-playlist-parser');

const app = express();
const PORT = process.env.PORT || 10000;

const M3U_URL = process.env.M3U_URL || 'https://iptv-org.github.io/iptv/countries/gb.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';

if (!/^https?:\/\//.test(M3U_URL)) throw new Error(`Invalid M3U URL: ${M3U_URL}`);
if (!/^https?:\/\//.test(EPG_URL)) throw new Error(`Invalid EPG URL: ${EPG_URL}`);

let channels = [];
let epgData = {};

const loadEPG = async () => {
  try {
    const { data } = await axios.get(EPG_URL);
    const parsed = await xml2js.parseStringPromise(data, { mergeAttrs: true });
    const programs = parsed.tv.programme || [];

    epgData = programs.reduce((acc, prog) => {
      const channel = prog.channel?.[0];
      if (!channel) return acc;

      if (!acc[channel]) acc[channel] = [];
      acc[channel].push({
        title: prog.title?.[0]?._ || '',
        start: prog.start?.[0],
        stop: prog.stop?.[0],
      });
      return acc;
    }, {});

    console.log(`Loaded EPG for ${Object.keys(epgData).length} channels`);
  } catch (err) {
    console.error('Failed to load EPG:', err.message);
  }
};

const loadM3U = async () => {
  try {
    const { data } = await axios.get(M3U_URL);
    const parsed = m3uParser.parse(data);
    channels = parsed.items.map((item, index) => ({
      id: `ch${index}`,
      name: item.name,
      url: item.url,
      logo: item.tvg.logo || '',
      group: item.group.title || 'Other',
      tvgId: item.tvg.id || '',
    }));
    console.log(`Loaded ${channels.length} channels`);
  } catch (err) {
    console.error('Error loading M3U:', err.message);
  }
};

const getCurrentAndNextProgram = (channelId) => {
  const now = new Date();
  const entries = epgData[channelId] || [];

  const current = entries.find(ep => new Date(ep.start) <= now && new Date(ep.stop) > now);
  const nextIndex = entries.indexOf(current) + 1;
  const next = entries[nextIndex] || null;

  return {
    now: current ? current.title : '',
    next: next ? next.title : '',
  };
};

const builder = new addonBuilder({
  id: 'org.custom.stremio.iptv',
  version: '1.0.0',
  name: 'Custom IPTV Addon',
  description: 'Streams from a custom M3U playlist with EPG',
  types: ['tv'],
  catalogs: [{
    type: 'tv',
    id: 'iptv_channels',
    name: 'IPTV Channels',
    extra: [{ name: 'genre' }],
  }],
  resources: ['catalog', 'stream', 'meta'],
});

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv' || id !== 'iptv_channels') return { metas: [] };

  const genre = extra?.genre;
  const filtered = genre
    ? channels.filter(ch => ch.group.toLowerCase() === genre.toLowerCase())
    : channels;

  const metas = filtered.map(ch => ({
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: ch.logo,
    genres: [ch.group],
  }));

  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ type, id }) => {
  const ch = channels.find(c => c.id === id);
  if (!ch) return Promise.resolve({ meta: {} });

  return Promise.resolve({
    meta: {
      id: ch.id,
      type: 'tv',
      name: ch.name,
      poster: ch.logo,
      description: `Channel: ${ch.name} | Group: ${ch.group}`,
      genres: [ch.group],
    },
  });
});

builder.defineStreamHandler(({ type, id }) => {
  const ch = channels.find(c => c.id === id);
  if (!ch) return Promise.resolve({ streams: [] });

  const epg = getCurrentAndNextProgram(ch.tvgId);

  const title = epg.now
    ? `${ch.name} — Now: ${epg.now}${epg.next ? ` | Next: ${epg.next}` : ''}`
    : ch.name;

  return Promise.resolve({
    streams: [{
      title,
      url: ch.url,
    }],
  });
});

app.get('/manifest.json', (req, res) => {
  res.send(builder.getInterface().getManifest());
});

app.get('/:resource/:type/:id/:extra?.json', (req, res) => {
  builder.getInterface().get(req).then(resp => res.send(resp)).catch(err => {
    console.error(err);
    res.status(500).send({ error: 'Handler failed' });
  });
});

Promise.all([loadM3U(), loadEPG()]).then(() => {
  app.listen(PORT, () => {
    console.log(`Addon server running on http://localhost:${PORT}`);
  });
});
