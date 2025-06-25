const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const URL = require('url').URL;

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';
const ADDON_NAME = 'Shanny IPTV';

let channels = [];
let categories = {};
let epgData = {};
let epgLoaded = false;

async function loadPlaylist() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);

    channels = parsed.items.map(item => {
      const id = encodeURIComponent(item.name);
      const group = item.group.title || 'Other';

      // Group channels
      if (!categories[group]) categories[group] = [];
      categories[group].push({
        id,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo || null,
        group
      });

      return {
        id,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo || null,
        group
      };
    });
  } catch (err) {
    console.error('❌ Failed to load playlist:', err);
  }
}

async function loadEPG() {
  if (epgLoaded || !EPG_URL) return;
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);
    if (result.tv && result.tv.programme) {
      result.tv.programme.forEach(p => {
        const channel = p.$.channel;
        const start = p.$.start;
        const stop = p.$.stop;
        const title = p.title?.[0] || '';
        if (!epgData[channel]) epgData[channel] = [];
        epgData[channel].push({ title, start, stop });
      });
    }
    epgLoaded = true;
  } catch (err) {
    console.error('❌ Failed to load EPG:', err);
  }
}

function getNowNext(title) {
  const now = dayjs();
  const list = epgData[title] || [];
  const current = list.find(p => {
    return dayjs(p.start, 'YYYYMMDDHHmmss ZZ') <= now &&
           dayjs(p.stop, 'YYYYMMDDHHmmss ZZ') >= now;
  });
  return current ? `${current.title}` : '';
}

const builder = new addonBuilder({
  id: 'org.shanny.iptv',
  version: '1.0.0',
  name: ADDON_NAME,
  description: 'IPTV with EPG and categories',
  catalogs: Object.keys(categories).map(group => ({
    type: 'tv',
    id: `shanny_${group}`,
    name: group
  })),
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv'],
  idPrefixes: ['shanny_']
});

// Catalog Handler
builder.defineCatalogHandler(async ({ id, type }) => {
  if (!channels.length) await loadPlaylist();
  const group = id.replace('shanny_', '');
  const metas = (categories[group] || []).map(ch => ({
    id: `shanny_${ch.id}`,
    type: 'tv',
    name: ch.name,
    poster: ch.logo,
    posterShape: 'square',
    background: ch.logo
  }));
  return { metas };
});

// Meta Handler
builder.defineMetaHandler(async ({ id }) => {
  const ch = channels.find(c => `shanny_${c.id}` === id);
  if (!ch) throw new Error('Channel not found');
  await loadEPG();
  const nowNext = getNowNext(ch.name);
  return {
    meta: {
      id: `shanny_${ch.id}`,
      type: 'tv',
      name: ch.name,
      logo: ch.logo,
      description: nowNext,
      poster: ch.logo,
      background: ch.logo
    }
  };
});

// Stream Handler
builder.defineStreamHandler(async ({ id }) => {
  const ch = channels.find(c => `shanny_${c.id}` === id);
  if (!ch) return { streams: [] };

  return {
    streams: [{
      title: ch.name,
      url: ch.url,
      externalUrl: true
    }]
  };
});

loadPlaylist();
loadEPG();

module.exports = builder.getInterface();
