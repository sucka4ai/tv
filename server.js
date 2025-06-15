// IPTV Addon for Stremio with EPG, Now/Next, Favorites & Filters

const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const sax = require('sax'); // Streaming XML parser
const cors = require('cors');
const dayjs = require('dayjs');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u';
const EPG_URL = process.env.EPG_URL || 'https://iptv-org.github.io/epg/guides/gb.xml';

app.use(cors());

let channels = [];
let epgData = {}; // { tvg-id: [programs] }
let catalogsByGroup = {}; // { group-title: [channels] }
let favorites = new Set();

async function loadM3U() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = m3uParser.parse(text);

    channels = parsed.items
      .filter(item => {
        const country = item.tvg?.country?.toLowerCase();
        return country === 'gb' || country === 'uk' || country === 'us';
      })
      .map((item, index) => ({
        id: `iptv:${index}`,
        name: item.name || `Channel ${index}`,
        description: item.tvg?.name || '',
        logo: item.tvg?.logo || '',
        tvgId: item.tvg?.id || '',
        country: item.tvg?.country || 'Unknown',
        language: item.tvg?.language || 'Unknown',
        group: item.group?.title || 'Other',
        url: item.url
      }));

    catalogsByGroup = {};
    for (const channel of channels) {
      if (!catalogsByGroup[channel.group]) {
        catalogsByGroup[channel.group] = [];
      }
      catalogsByGroup[channel.group].push(channel);
    }

    console.log(`Loaded ${channels.length} UK/US channels.`);
  } catch (err) {
    console.error('Failed to load M3U:', err);
  }
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const parser = sax.parser(true);

    let currentChannelId = '';
    let currentProgram = {};
    let currentTag = '';

    parser.onopentag = node => {
      if (node.name === 'programme') {
        currentChannelId = node.attributes.channel;
        currentProgram = {
          start: node.attributes.start,
          stop: node.attributes.stop,
          title: '',
          desc: '',
          category: ''
        };
      }
      currentTag = node.name;
    };

    parser.ontext = text => {
      if (!currentProgram || !currentTag) return;
      if (currentTag === 'title') currentProgram.title += text;
      else if (currentTag === 'desc') currentProgram.desc += text;
      else if (currentTag === 'category') currentProgram.category += text;
    };

    parser.onclosetag = tag => {
      if (tag === 'programme') {
        if (!epgData[currentChannelId]) epgData[currentChannelId] = [];
        epgData[currentChannelId].push(currentProgram);
        currentProgram = {};
        currentChannelId = '';
      }
      currentTag = '';
    };

    parser.write(xml).close();
    console.log(`EPG loaded with data for ${Object.keys(epgData).length} channels.`);
  } catch (err) {
    console.error('Failed to load EPG:', err);
  }
}

function getNowNext(tvgId) {
  const now = dayjs();
  const programs = epgData[tvgId] || [];
  let current = null, next = null;
  for (let i = 0; i < programs.length; i++) {
    const start = dayjs(programs[i].start, 'YYYYMMDDHHmmss Z');
    const stop = dayjs(programs[i].stop, 'YYYYMMDDHHmmss Z');
    if (now.isAfter(start) && now.isBefore(stop)) {
      current = programs[i];
      next = programs[i + 1];
      break;
    }
  }
  return { current, next };
}

app.get('/manifest.json', (req, res) => {
  const catalogs = Object.keys(catalogsByGroup).map(group => ({
    type: 'tv',
    id: `iptv_${group.replace(/\s+/g, '_')}`,
    name: `IPTV - ${group}`
  }));

  catalogs.push({
    type: 'tv',
    id: 'iptv_all',
    name: 'IPTV - All Channels'
  });

  catalogs.push({
    type: 'tv',
    id: 'iptv_favorites',
    name: 'IPTV - Favorites'
  });

  res.json({
    id: "com.iptv.addon",
    version: "3.0.0",
    name: "Full IPTV Addon",
    description: "IPTV with EPG, now/next, favorites, and UK/US filter",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png",
    resources: ["catalog", "stream"],
    types: ["tv"],
    idPrefixes: ["iptv:"],
    catalogs
  });
});

app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv') return res.status(404).send('Invalid type');

  let filtered = [];
  if (id === 'iptv_all') {
    filtered = channels;
  } else if (id === 'iptv_favorites') {
    filtered = channels.filter(c => favorites.has(c.id));
  } else if (id.startsWith('iptv_')) {
    const group = id.replace('iptv_', '').replace(/_/g, ' ');
    filtered = catalogsByGroup[group] || [];
  }

  const metas = filtered.map(c => {
    const { current, next } = getNowNext(c.tvgId);
    return {
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.logo,
      description: current ? `${current.title} (Now)\nNext: ${next?.title || 'N/A'}` : c.description,
      genres: [c.group]
    };
  });

  res.json({ metas });
});

app.get('/stream/:type/:id.json', (req, res) => {
  if (req.params.type !== 'tv' || !req.params.id.startsWith('iptv:')) {
    return res.status(404).send('Invalid stream');
  }

  const index = parseInt(req.params.id.split(':')[1], 10);
  const channel = channels[index];

  if (!channel) return res.status(404).send('Channel not found');

  res.json({
    streams: [{ title: channel.name, url: channel.url }]
  });
});

app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') favorites.add(id);
  else if (action === 'remove') favorites.delete(id);
  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await loadM3U();
  await loadEPG();
});
