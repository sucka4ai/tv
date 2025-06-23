const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

const app = express();
app.use(cors());

let playlist = [];
let epg = {};
let catalogs = [];

async function fetchPlaylist() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);
    playlist = parsed.items || [];

    const categories = Array.from(new Set(
      playlist.map(i => i.group?.title || 'Uncategorized')
    ));
    categories.sort();
    categories.unshift('All Channels');

    catalogs = categories.map(cat => ({
      type: 'tv',
      id: `iptv_${cat.toLowerCase().replace(/\s+/g, '_')}`,
      name: cat
    }));

    console.log(`[M3U] Loaded ${playlist.length} channels in ${categories.length} categories.`);
  } catch (err) {
    console.error('[M3U] Error loading playlist:', err.message);
    catalogs = [{
      type: 'tv',
      id: 'iptv_all_channels',
      name: 'All Channels'
    }];
  }
}

async function fetchEPG() {
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);
    const programs = result.tv?.programme || [];

    const now = dayjs();
    epg = {};

    for (const prog of programs) {
      const channel = prog.$.channel;
      const start = dayjs(prog.$.start, 'YYYYMMDDHHmmss Z');
      const stop = dayjs(prog.$.stop, 'YYYYMMDDHHmmss Z');

      if (now.isAfter(start) && now.isBefore(stop)) {
        epg[channel] = {
          title: prog.title?.[0] || '',
          desc: prog.desc?.[0] || '',
          start: start.format('HH:mm'),
          stop: stop.format('HH:mm')
        };
      }
    }

    console.log(`[EPG] Loaded current data for ${Object.keys(epg).length} channels.`);
  } catch (err) {
    console.error('[EPG] Error loading EPG:', err.message);
  }
}

(async () => {
  await fetchPlaylist();
  await fetchEPG();

  const builder = new addonBuilder({
    id: 'iptv-addon',
    version: '1.0.0',
    name: 'IPTV Addon',
    description: 'Custom IPTV Addon with M3U and EPG support',
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv'],
    catalogs: catalogs,
    idPrefixes: ['iptv_']
  });

  builder.defineCatalogHandler(({ id }) => {
    const category = id.replace(/^iptv_/, '').replace(/_/g, ' ');
    const filtered = playlist.filter(ch =>
      category === 'All Channels' || ch.group?.title === category
    );

    const metas = filtered.map(ch => {
      const current = epg[ch.tvg.id];
      return {
        id: `iptv_${encodeURIComponent(ch.tvg.id || ch.name)}`,
        type: 'tv',
        name: ch.name,
        poster: ch.tvg.logo || null,
        description: current ? `${current.title} (${current.start} - ${current.stop})` : 'Live Channel'
      };
    });

    return Promise.resolve({ metas });
  });

  builder.defineMetaHandler(({ id }) => {
    const decodedId = decodeURIComponent(id.replace(/^iptv_/, ''));
    const item = playlist.find(ch =>
      ch.tvg.id === decodedId || ch.name === decodedId
    );

    const current = epg[item?.tvg.id];
    return Promise.resolve({
      meta: {
        id,
        type: 'tv',
        name: item?.name || 'Unknown Channel',
        poster: item?.tvg.logo || null,
        description: current ? `${current.title}\n${current.desc}` : 'Live Channel'
      }
    });
  });

  builder.defineStreamHandler(({ id }) => {
    const decodedId = decodeURIComponent(id.replace(/^iptv_/, ''));
    const item = playlist.find(ch =>
      ch.tvg.id === decodedId || ch.name === decodedId
    );
    if (!item) return Promise.resolve({ streams: [] });

    return Promise.resolve({
      streams: [{ title: item.name, url: item.url }]
    });
  });

  const addonInterface = builder.getInterface();
  app.use('/stremio/v1', getRouter(addonInterface));

  const PORT = process.env.PORT || 7000;
  app.listen(PORT, () => {
    console.log(`Addon is running on http://localhost:${PORT}/stremio/v1`);
  });
})();
