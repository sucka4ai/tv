const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

if (!M3U_URL || !EPG_URL) {
    throw new Error("M3U_URL and/or EPG_URL environment variables are not set");
}

const builder = new addonBuilder({
  id: 'org.shanny.iptv',
  version: '1.0.0',
  name: 'Shanny IPTV',
  description: 'Live TV from Shanny IPTV with categories and EPG',
  catalogs: [],
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv'],
  idPrefixes: ['shannyiptv_'],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
});

let channels = [];
let categories = [];

async function loadPlaylist() {
  const res = await fetch(M3U_URL);
  const text = await res.text();
  const parsed = parser.parse(text);
  const all = [];

  for (const item of parsed.items) {
    if (!item.url || !item.url.includes('http')) continue;

    const name = item.name || 'Untitled';
    const id = `shannyiptv_${Buffer.from(name).toString('base64')}`;
    const logo = item.tvg.logo;
    const group = item.group.title || 'Uncategorized';

    all.push({
      id,
      name,
      type: 'tv',
      poster: logo,
      url: item.url,
      group,
    });
  }

  channels = all;
  categories = [...new Set(channels.map(c => c.group))];
}

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv' || id !== 'shannyiptv') return Promise.resolve({ metas: [] });

  const genre = (extra && extra.genre) || null;

  let filtered = channels;
  if (genre) {
    filtered = channels.filter(c => c.group === genre);
  }

  const metas = filtered.map(ch => ({
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: ch.poster,
    posterShape: 'square'
  }));

  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ id }) => {
  const channel = channels.find(ch => ch.id === id);
  if (!channel) return Promise.resolve({ meta: null });

  return Promise.resolve({
    meta: {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      poster: channel.poster,
      background: channel.poster,
      description: `Live channel: ${channel.name}`,
      genres: [channel.group],
    }
  });
});

builder.defineStreamHandler(({ id }) => {
  const channel = channels.find(ch => ch.id === id);
  if (!channel) return Promise.resolve({ streams: [] });

  const url = channel.url;
  if (!url || (!url.includes('http') && !url.includes('.m3u8'))) {
    return Promise.resolve({ streams: [] });
  }

  console.log('🔗 Stream requested:', id, '→', url);

  return Promise.resolve({
    streams: [{
      title: channel.name,
      url: url,
      externalUrl: true
    }]
  });
});

// Add category filters to manifest
function buildManifest() {
  const genreOptions = categories.map(cat => ({
    name: cat,
    value: cat
  }));

  builder.manifest.catalogs.push({
    type: 'tv',
    id: 'shannyiptv',
    name: 'Shanny IPTV',
    extra: [
      {
        name: 'genre',
        isRequired: false,
        options: genreOptions
      }
    ]
  });
}

// INIT
loadPlaylist()
  .then(() => {
    buildManifest();
    console.log('✅ Loaded channels and categories:', categories.length);
    require('http').createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      builder.getInterface()(req, res);
    }).listen(process.env.PORT || 7000);
    console.log('🚀 Shanny IPTV Addon running...');
  })
  .catch(err => {
    console.error('❌ Failed to load playlist:', err);
  });
