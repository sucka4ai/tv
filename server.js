const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';

let playlistItems = [];
let categories = new Set();
let epgData = {};

async function fetchPlaylist() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);
    playlistItems = parsed.items.map((item, index) => {
      const group = item.group.title || 'Other';
      categories.add(group);
      return {
        id: `${index}`,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo,
        group,
      };
    });
    console.log(`✅ Loaded ${playlistItems.length} channels`);
  } catch (err) {
    console.error('❌ Failed to load playlist:', err);
  }
}

async function fetchEPG() {
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true });
    epgData = {};

    if (result.tv && result.tv.programme) {
      result.tv.programme.forEach(program => {
        const channel = program.channel?.[0];
        if (!epgData[channel]) epgData[channel] = [];
        epgData[channel].push({
          title: program.title?.[0]?._ || '',
          start: dayjs(program.start?.[0], 'YYYYMMDDHHmmss Z'),
          stop: dayjs(program.stop?.[0], 'YYYYMMDDHHmmss Z'),
        });
      });
    }

    console.log(`✅ EPG parsed`);
  } catch (err) {
    console.error('❌ Failed to load EPG:', err);
  }
}

function getCurrentEPG(tvgName) {
  const now = dayjs();
  const entries = epgData[tvgName] || [];
  const current = entries.find(epg => now.isAfter(epg.start) && now.isBefore(epg.stop));
  return current ? `${current.title} (${current.start.format('HH:mm')} - ${current.stop.format('HH:mm')})` : '';
}

const builder = new addonBuilder({
  id: 'org.shanny.iptv',
  version: '1.0.0',
  name: 'Shanny IPTV',
  description: 'Live TV from M3U playlist with categories and EPG',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/7/75/Internet-TV-icon.png',
  resources: ['catalog', 'stream', 'meta'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'shanny',
      name: 'Shanny IPTV',
      extra: [
        { name: 'genre', isRequired: false },
      ],
    }
  ],
  idPrefixes: ['shanny']
});

// Catalog handler
builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv' || id !== 'shanny') return Promise.resolve({ metas: [] });

  const genre = extra.genre;
  const filtered = genre ? playlistItems.filter(i => i.group === genre) : playlistItems;

  const metas = filtered.map(item => ({
    id: `${item.id}:${item.name}`,
    type: 'tv',
    name: item.name,
    genres: [item.group],
    poster: item.logo,
    posterShape: 'square',
    background: item.logo,
    description: getCurrentEPG(item.name),
  }));

  const genreList = Array.from(categories).map(c => ({ name: c }));

  return Promise.resolve({ metas, cacheMaxAge: 3600, cache: true, extra: { genreList } });
});

// Meta handler
builder.defineMetaHandler(({ type, id }) => {
  const [channelId] = id.split(':');
  const item = playlistItems.find(i => i.id === channelId);
  if (!item) return Promise.resolve({});

  return Promise.resolve({
    meta: {
      id: id,
      type: 'tv',
      name: item.name,
      poster: item.logo,
      genres: [item.group],
      description: getCurrentEPG(item.name),
      background: item.logo,
    }
  });
});

// Stream handler
builder.defineStreamHandler(({ type, id }) => {
  const [channelId] = id.split(':');
  const item = playlistItems.find(i => i.id === channelId);
  if (!item) return Promise.resolve({ streams: [] });

  return Promise.resolve({
    streams: [
      {
        title: item.name,
        url: item.url,
        externalUrl: true,
      }
    ]
  });
});

// Init
fetchPlaylist().then(() => fetchEPG());

module.exports = builder.getInterface();
