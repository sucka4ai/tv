const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');
const m3uParser = require('iptv-playlist-parser');

const app = express();
const PORT = process.env.PORT || 7000;

// --- Your Config ---
const M3U_URL = 'https://example.com/playlist.m3u'; // Replace with your M3U playlist URL
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';  // UK EPG source

let channels = [];
let epgData = {};

// --- Helper: Load M3U and parse ---
const loadM3U = async () => {
  try {
    const { data } = await axios.get(M3U_URL);
    const parsed = m3uParser.parse(data);
    channels = parsed.items;
    console.log(`Loaded ${channels.length} channels from M3U`);
  } catch (err) {
    console.error('Error loading M3U:', err.message);
  }
};

// --- Helper: Load and parse EPG ---
const loadEPG = async () => {
  try {
    const { data } = await axios.get(EPG_URL);
    const result = await xml2js.parseStringPromise(data, { mergeAttrs: true });
    epgData = {};

    if (result.tv && result.tv.programme) {
      for (const prog of result.tv.programme) {
        const channelId = prog.channel?.[0];
        if (!channelId) continue;

        if (!epgData[channelId]) epgData[channelId] = [];
        epgData[channelId].push({
          title: prog.title?.[0] || '',
          start: prog.start?.[0],
          stop: prog.stop?.[0],
          desc: prog.desc?.[0] || '',
        });
      }
      console.log(`Loaded EPG for ${Object.keys(epgData).length} channels`);
    }
  } catch (err) {
    console.error('Error loading EPG:', err.message);
  }
};

// --- Load M3U + EPG at startup ---
(async () => {
  await loadM3U();
  await loadEPG();
})();

// --- Build manifest ---
const manifest = {
  id: 'community.iptv.custom',
  version: '1.0.0',
  name: 'Custom IPTV',
  description: 'Stremio Addon for custom IPTV playlist',
  resources: ['stream'],
  types: ['tv'],
  catalogs: [],
  idPrefixes: ['iptv:'],
};

// --- Build addon interface ---
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv') return { streams: [] };

  const channel = channels.find(ch => `iptv:${ch.name}` === id);
  if (!channel) return { streams: [] };

  const stream = {
    title: channel.name,
    url: channel.url,
    isFree: true,
    name: 'Live Stream',
  };

  return { streams: [stream] };
});

// --- Express routes ---
const addonInterface = builder.getInterface();

app.get('/manifest.json', (req, res) => {
  res.send(addonInterface.manifest);
});

app.get('/stream/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params;
    const streamResult = await addonInterface.stream({ type, id });
    res.send(streamResult);
  } catch (err) {
    console.error('Stream error:', err.message);
    res.status(500).send({ err: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Addon server running on http://localhost:${PORT}`);
});
