// IPTV Addon for Stremio with memory-safe M3U parsing (UK/US only)

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const readline = require('readline');
const stream = require('stream');
const app = express();

const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://iptv-org.github.io/iptv/countries/gb.m3u';

app.use(cors());

let channels = [];
let catalogsByGroup = {}; // { group-title: [channels] }
let favorites = new Set();

async function loadM3U() {
  try {
    const res = await fetch(M3U_URL);
    const body = await res.text();

    const lines = body.split('\n');
    let current = {};

    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const nameMatch = line.match(/,(.*)$/);
        const tvgIdMatch = line.match(/tvg-id="(.*?)"/);
        const logoMatch = line.match(/tvg-logo="(.*?)"/);
        const groupMatch = line.match(/group-title="(.*?)"/);
        const countryMatch = line.match(/tvg-country="(.*?)"/);

        current = {
          name: nameMatch ? nameMatch[1] : 'Unknown',
          tvgId: tvgIdMatch ? tvgIdMatch[1] : '',
          logo: logoMatch ? logoMatch[1] : '',
          group: groupMatch ? groupMatch[1] : 'Other',
          country: countryMatch ? countryMatch[1] : ''
        };
      } else if (line && line.startsWith('http')) {
        // Only allow UK or US channels
        if (/\b(UK|GB|US|USA)\b/i.test(current.country)) {
          const id = `iptv:${channels.length}`;
          const channel = {
            id,
            type: 'tv',
            name: current.name,
            description: '',
            logo: current.logo,
            group: current.group,
            country: current.country,
            url: line
          };
          channels.push(channel);

          if (!catalogsByGroup[channel.group]) {
            catalogsByGroup[channel.group] = [];
          }
          catalogsByGroup[channel.group].push(channel);
        }
      }
    }
    console.log(`✅ Loaded ${channels.length} UK/US channels.`);
  } catch (err) {
    console.error('❌ Failed to load M3U:', err);
  }
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
    id: 'com.iptv.addon',
    version: '4.0.0',
    name: 'Lightweight IPTV (UK/US)',
    description: 'Memory-safe IPTV addon for UK/US channels only',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png',
    resources: ['catalog', 'stream'],
    types: ['tv'],
    idPrefixes: ['iptv:'],
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

  const metas = filtered.map(c => ({
    id: c.id,
    type: 'tv',
    name: c.name,
    poster: c.logo,
    description: c.description,
    genres: [c.group]
  }));

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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  await loadM3U();
});
