// IPTV Addon for Stremio with EPG, Now/Next, Proxy Support, and Web UI

const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

let channels = [];
let epgData = {};
let catalogsByGroup = {};
let favorites = new Set();

async function loadM3U() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = m3uParser.parse(text);

    channels = parsed.items.map((item, index) => ({
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

    console.log(`✅ Loaded ${channels.length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load M3U:', err);
  }
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    const contentType = res.headers.get('content-type');
    if (!contentType.includes('xml') && !contentType.includes('text')) {
      throw new Error(`Invalid content-type for EPG: ${contentType}`);
    }
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml, { mergeAttrs: true });

    epgData = {};
    for (const prog of parsed.tv.programme || []) {
      const channelId = prog.channel[0];
      if (!epgData[channelId]) epgData[channelId] = [];
      epgData[channelId].push({
        title: prog.title?.[0]._ || '',
        start: prog.start[0],
        stop: prog.stop[0],
        desc: prog.desc?.[0]._ || '',
        category: prog.category?.[0]._ || ''
      });
    }

    console.log(`✅ Loaded EPG data for ${Object.keys(epgData).length} channels.`);
  } catch (err) {
    console.error('❌ Failed to load EPG:', err);
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
    name: 'IPTV - All Channels',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'genre', options: Object.keys(catalogsByGroup), isRequired: false },
      { name: 'country', isRequired: false },
      { name: 'language', isRequired: false }
    ]
  });

  catalogs.push({
    type: 'tv',
    id: 'iptv_favorites',
    name: 'IPTV - Favorites'
  });

  res.json({
    id: "com.iptv.addon",
    version: "3.1.0",
    name: "Full IPTV Addon",
    description: "IPTV with EPG, now/next, search, filters, favorites, and web UI",
    logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png",
    resources: ["catalog", "stream"],
    types: ["tv"],
    idPrefixes: ["iptv:"],
    catalogs
  });
});

app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  const { search = '', genre, country, language } = req.query;
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

  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  if (genre) filtered = filtered.filter(c => c.group === genre);
  if (country) filtered = filtered.filter(c => c.country.toLowerCase().includes(country.toLowerCase()));
  if (language) filtered = filtered.filter(c => c.language.toLowerCase().includes(language.toLowerCase()));

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

  const streamUrl = `/proxy?url=${encodeURIComponent(channel.url)}`;
  res.json({
    streams: [{ title: channel.name, url: `${req.protocol}://${req.get('host')}${streamUrl}` }]
  });
});

app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing URL');

  try {
    const response = await fetch(url);
    res.set('Content-Type', response.headers.get('content-type'));
    pipeline(response.body, res, err => {
      if (err) console.error('Proxy stream error:', err);
    });
  } catch (err) {
    console.error('Proxy fetch failed:', err);
    res.status(502).send('Stream proxy error');
  }
});

app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') favorites.add(id);
  else if (action === 'remove') favorites.delete(id);
  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadM3U();
  await loadEPG();
});
