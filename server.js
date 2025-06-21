// IPTV Addon for Stremio with EPG, Now/Next, and Proxy Support

const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const cors = require('cors');
const dayjs = require('dayjs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist.m3u'; // MAKE SURE THESE ARE SET IN RENDER ENV VARS
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml'; // MAKE SURE THESE ARE SET IN RENDER ENV VARS

app.use(cors());

let channels = [];
let epgData = {}; // { tvg-id: [programs] }
let catalogsByGroup = {}; // { group-title: [channels] } - keys will be safeGroup
let favorites = new Set();

// Function to make strings URL-safe and consistent for IDs
function makeSafeId(str) {
  return str
    .toString()
    .normalize('NFD') // Normalize Unicode characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .toLowerCase() // Convert to lowercase
    .trim() // Trim whitespace from both ends
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/[^\w-]/g, ''); // Remove all non-word chars except hyphens
}

async function loadM3U() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = m3uParser.parse(text);

    console.log('--- loadM3U Start ---');
    console.log('Raw M3U items found:', parsed.items.length);

    if (parsed.items.length === 0) {
      console.warn('M3U playlist is empty or could not be parsed. Check M3U_URL and content.');
      // Optionally, throw an error or return to prevent further processing with empty data
    }

    channels = parsed.items.map((item, index) => {
      const groupTitle = item.group?.title || 'Other';
      const safeGroup = makeSafeId(groupTitle);
      // console.log(`Original Group: "${groupTitle}" -> Safe Group: "${safeGroup}"`); // Uncomment for detailed group debugging

      return {
        id: `iptv:${index}`, // This ID is internal and already safe
        name: item.name || `Channel ${index}`,
        description: item.tvg?.name || '',
        logo: item.tvg?.logo || '',
        tvgId: item.tvg?.id || '',
        country: item.tvg?.country || 'Unknown',
        language: item.tvg?.language || 'Unknown',
        group: groupTitle, // Keep original group title for display if needed
        safeGroup: safeGroup, // Store the safe version for catalog IDs and genre options
        url: item.url
      };
    });

    catalogsByGroup = {};
    for (const channel of channels) {
      if (!catalogsByGroup[channel.safeGroup]) {
        catalogsByGroup[channel.safeGroup] = [];
      }
      catalogsByGroup[channel.safeGroup].push(channel);
    }

    console.log('Catalogs by Group keys after M3U load:', Object.keys(catalogsByGroup));
    console.log(`✅ Loaded ${channels.length} channels.`);
    console.log('--- loadM3U End ---');
  } catch (err) {
    console.error('❌ Failed to load M3U:', err.message); // Log error message for clarity
  }
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    const contentType = res.headers.get('content-type');

    if (!contentType || !contentType.includes('xml')) {
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
    console.error('❌ Failed to load EPG:', err.message); // Log error message for clarity
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
  const catalogs = Object.keys(catalogsByGroup).map(safeGroup => ({
    type: 'tv',
    id: `iptv_${safeGroup}`, // Use the safeGroup for the ID
    name: `IPTV - ${safeGroup.replace(/_/g, ' ').toUpperCase()}` // You can format this for display
  }));

  catalogs.push({
    type: 'tv',
    id: 'iptv_all',
    name: 'IPTV - All Channels',
    extra: [
      { name: 'search', isRequired: false },
      {
        name: 'genre',
        options: Object.keys(catalogsByGroup).map(safeGroup => safeGroup.replace(/_/g, ' ').toUpperCase()), // Use safeGroup for display in options
        isRequired: false
      },
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
    version: "3.0.0", // Increment version for Stremio to pick up changes
    name: "Full IPTV Addon",
    description: "IPTV with EPG, now/next, search, filters, and favorites",
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

  console.log(`--- Catalog Request Start: /catalog/${type}/${id}.json ---`);
  console.log('Query parameters:', { search, genre, country, language });

  if (type !== 'tv') {
    console.log('Invalid type requested:', type);
    return res.status(404).send('Invalid type');
  }

  let filtered = [];
  if (id === 'iptv_all') {
    filtered = channels;
    console.log('Catalog: iptv_all. Total channels:', channels.length);
  } else if (id === 'iptv_favorites') {
    filtered = channels.filter(c => favorites.has(c.id));
    console.log('Catalog: iptv_favorites. Favorite channels:', filtered.length);
  } else if (id.startsWith('iptv_')) {
    const requestedSafeGroup = id.replace('iptv_', '');
    console.log('Attempting to retrieve custom group:', requestedSafeGroup);
    // Check if the requested group actually exists in catalogsByGroup
    if (catalogsByGroup[requestedSafeGroup]) {
      filtered = catalogsByGroup[requestedSafeGroup];
    } else {
      console.warn(`No channels found for requested group "${requestedSafeGroup}" in catalogsByGroup. Check M3U parsing and group titles.`);
      filtered = []; // Ensure filtered is an empty array if group not found
    }
    console.log(`Found ${filtered.length} channels for group "${requestedSafeGroup}".`);
  }

  if (search) filtered = filtered.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  // Filter by genre using the original group, but comparing against the safely transformed genre query param
  if (genre) {
      const safeGenreQuery = makeSafeId(genre); // Convert query param back to safe format for comparison
      filtered = filtered.filter(c => c.safeGroup === safeGenreQuery);
  }
  if (country) filtered = filtered.filter(c => c.country.toLowerCase().includes(country.toLowerCase()));
  if (language) filtered = filtered.filter(c => c.language.toLowerCase().includes(language.toLowerCase()));

  const metas = filtered.map(c => {
    const { current, next } = getNowNext(c.tvgId);
    // Use c.logo if valid, otherwise use a generic placeholder image
    const safePoster = c.logo && c.logo.startsWith('http') && (c.logo.endsWith('.png') || c.logo.endsWith('.jpg') || c.logo.endsWith('.jpeg') || c.logo.endsWith('.gif'))
                       ? c.logo
                       : "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png"; // Fallback generic TV icon

    return {
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: safePoster, // Use the validated/fallback poster
      description: current ? `${current.title} (Now)\nNext: ${next?.title || 'N/A'}` : c.description,
      genres: [c.group] // Keep original group for display in Stremio UI
    };
  });

  console.log(`Returning ${metas.length} metas for /catalog/${type}/${id}.json`);
  console.log('--- Catalog Request End ---');
  res.json({ metas });
});

app.get('/stream/:type/:id.json', (req, res) => {
  if (req.params.type !== 'tv' || !req.params.id.startsWith('iptv:')) {
    console.log('Invalid stream request: type or id mismatch.', req.params);
    return res.status(404).send('Invalid stream');
  }

  const index = parseInt(req.params.id.split(':')[1], 10);
  const channel = channels[index];
  if (!channel) {
    console.log('Stream channel not found for ID:', req.params.id);
    return res.status(404).send('Channel not found');
  }

  const proxyUrl = `/proxy/${encodeURIComponent(channel.url)}`;
  console.log(`Streaming channel ${channel.name} via proxy: ${proxyUrl}`);
  res.json({
    streams: [{
      title: channel.name,
      url: `${req.protocol}://${req.get('host')}${proxyUrl}`,
      // ADDED: behaviorHints from the test addon for better compatibility
      behaviorHints: {
        notWebReady: false
      }
    }]
  });
});

app.get('/favorites/:action/:id', (req, res) => {
  const { action, id } = req.params;
  if (action === 'add') {
    favorites.add(id);
    console.log(`Added to favorites: ${id}. Current favorites: ${Array.from(favorites).length}`);
  } else if (action === 'remove') {
    favorites.delete(id);
    console.log(`Removed from favorites: ${id}. Current favorites: ${Array.from(favorites).length}`);
  }
  res.json({ status: 'ok', favorites: Array.from(favorites) });
});

// Updated Proxy route for Android & Smart TV compatibility
app.use('/proxy', (req, res, next) => {
  const targetUrl = decodeURIComponent(req.url.slice(1));
  if (!/^https?:\/\//.test(targetUrl)) {
    console.warn('Attempted proxy for invalid URL:', targetUrl);
    return res.status(400).send('Invalid target URL');
  }

  console.log('Proxying request to:', targetUrl);
  return createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    selfHandleResponse: false,
    secure: false, // Set to true if target is always HTTPS and you trust its cert
    headers: {
      'User-Agent': req.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36', // Add a common user agent
      'Referer': targetUrl // Set Referer to the target URL
    },
    pathRewrite: () => '',
    logLevel: 'debug', // Changed to debug for more proxy insights
    onProxyReq: (proxyReq, req, res) => {
      // Optional: Log outgoing proxy request headers for debugging
      // console.log('Proxy Request Headers:', proxyReq.getHeaders());
    },
    onProxyRes: (proxyRes, req, res) => {
      // Optional: Log incoming proxy response headers for debugging
      // console.log('Proxy Response Headers:', proxyRes.headers);
    },
    onError: (err, req, res) => {
      console.error('Proxy error:', err);
      res.status(500).send('Proxy error');
    }
  })(req, res, next);
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT} (UTC: ${new Date().toUTCString()})`); // Added UTC time
  await loadM3U(); // This must complete successfully
  await loadEPG(); // This must complete successfully
});
