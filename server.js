const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parse = require('iptv-playlist-parser').parse;
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const URL = require('url').URL;

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';

let channels = [];
let categories = {};
let epg = {};
let builder;

async function loadPlaylist() {
  const res = await fetch(M3U_URL);
  const text = await res.text();
  const parsed = parse(text);

  channels = parsed.items.map((item, index) => {
    const id = `shannyiptv_${index}`;
    const group = item.group.title || 'Other';

    if (!categories[group]) categories[group] = [];
    categories[group].push({ ...item, id });

    return { ...item, id };
  });
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);

    if (result && result.tv && result.tv.programme) {
      for (const prog of result.tv.programme) {
        const channelId = prog.$.channel;
        if (!epg[channelId]) epg[channelId] = [];
        epg[channelId].push({
          title: prog.title?.[0] || '',
          start: prog.$.start,
          stop: prog.$.stop,
        });
      }
    }
  } catch (err) {
    console.error('⚠️ EPG load failed:', err.message);
  }
}

function getNowNext(channel) {
  const programs = epg[channel.tvg?.id] || [];
  const now = dayjs();
  const current = programs.find(p =>
    now.isAfter(dayjs(p.start, 'YYYYMMDDHHmmss Z')) &&
    now.isBefore(dayjs(p.stop, 'YYYYMMDDHHmmss Z'))
  );
  const next = programs.find(p => dayjs(p.start, 'YYYYMMDDHHmmss Z').isAfter(now));
  return { current, next };
}

function buildAddon() {
  const manifest = {
    id: 'org.shanny.iptv',
    version: '1.0.0',
    name: 'Shanny IPTV',
    description: 'Custom IPTV addon with EPG and category layout',
    logo: 'https://i.imgur.com/IpwEKkP.png',
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv'],
    catalogs: Object.keys(categories).map(cat => ({
      type: 'tv',
      id: `shannyiptv_${cat}`,
      name: cat,
    })),
    idPrefixes: ['shannyiptv_'],
  };

  builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(({ id }) => {
    const catName = id.replace('shannyiptv_', '');
    const metas = (categories[catName] || []).map(item => {
      const { id, name, logo, tvg } = item;
      const { current, next } = getNowNext(item);
      const title = current ? `${name} - Now: ${current.title}` : name;

      return {
        id,
        type: 'tv',
        name: title,
        poster: logo || null,
        background: logo || null,
        description: next ? `Next: ${next.title}` : '',
      };
    });
    return Promise.resolve({ metas });
  });

  builder.defineMetaHandler(({ id }) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return Promise.resolve({ meta: {} });

    const { current, next } = getNowNext(channel);
    const meta = {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      poster: channel.logo,
      background: channel.logo,
      description: current ? `Now: ${current.title}` : '',
    };
    return Promise.resolve({ meta });
  });

  builder.defineStreamHandler(({ id }) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return Promise.resolve({ streams: [] });

    try {
      const streamUrl = new URL(channel.url).href;
      return Promise.resolve({
        streams: [{
          title: channel.name,
          url: streamUrl,
          externalUrl: true,
        }],
      });
    } catch (err) {
      console.error('Invalid URL:', channel.url);
      return Promise.resolve({ streams: [] });
    }
  });

  return builder.getInterface();
}

(async () => {
  try {
    await loadPlaylist();
    loadEPG(); // lazy-load, no await
    const addonInterface = buildAddon();
    require('http').createServer((req, res) => {
      addonInterface(req, res);
    }).listen(process.env.PORT || 10000, () => {
      console.log('✅ Shanny IPTV Addon running on port', process.env.PORT || 10000);
    });
  } catch (e) {
    console.error('❌ Error starting addon:', e);
  }
})();
