const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const xml2js = require('xml2js');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
app.use(cors());

// IMPORTANT: Ensure these are set in your environment or in a .env file
// Example .env file:
// M3U_URL="http://your-iptv-provider.com/playlist.m3u"
// EPG_URL="http://your-iptv-provider.com/epg.xml"
const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;
const PORT = process.env.PORT || 10000;

let channels = [];
let epgData = {};

// Helper to extract attributes from EXTINF line
const extractExtinfAttributes = (line) => {
  const attributes = {};
  const regex = /(\S+?)="([^"]*?)"/g; // Matches key="value" pairs
  let match;
  while ((match = regex.exec(line)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
};

const parseM3U = async (url) => {
  console.log(`[M3U Parser] Loading M3U from: ${url}`);
  try {
    const response = await axios.get(url);
    console.log(`[M3U Parser] M3U Response Status: ${response.status}`);
    if (response.data.length > 0) {
      console.log(`[M3U Parser] M3U Raw Data (first 500 chars):\n${response.data.substring(0, 500)}...`);
    } else {
      console.log('[M3U Parser] M3U Response data is empty.');
      return [];
    }

    const lines = response.data.split('\n');
    const result = [];

    let current = {};
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      if (line.startsWith('#EXTINF')) {
        console.log(`[M3U Parser] Processing EXTINF line (${i+1}): ${line}`);

        const attributes = extractExtinfAttributes(line);
        const nameMatch = line.match(/,(.*)$/); // Get everything after the last comma

        current = {
          name: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
          group: attributes['group-title'] || 'Other',
          tvgId: attributes['tvg-id'] || null, // Capture tvg-id for potential EPG linking
          tvgLogo: attributes['tvg-logo'] || null // Capture tvg-logo for poster
        };
        console.log(`[M3U Parser] Extracted: Name="${current.name}", Group="${current.group}", tvgId="${current.tvgId}"`);
      } else if (line && !line.startsWith('#')) {
        // This line is expected to be the URL
        current.url = line.trim();
        console.log(`[M3U Parser] Found URL for current channel (${current.name}): ${current.url}`);

        if (current.name && current.url) {
          result.push({ ...current });
          console.log(`[M3U Parser] Added channel: ${current.name}`);
        } else {
          console.warn(`[M3U Parser] Skipping incomplete channel (name: ${current.name}, url: ${current.url})`);
        }
        current = {}; // Reset for the next channel
      } else {
        // console.log(`[M3U Parser] Skipping line (${i+1}): ${line}`); // Uncomment for very verbose logging
      }
    }

    console.log(`[M3U Parser] Finished parsing. Found ${result.length} channels.`);
    return result;
  } catch (err) {
    console.error(`[M3U Parser] ❌ Error loading or parsing M3U: ${err.message}`);
    if (err.response) {
      console.error(`[M3U Parser] Axios Error Status: ${err.response.status}`);
      console.error(`[M3U Parser] Axios Error Data: ${err.response.data?.substring(0, 200)}...`);
    }
    return []; // Return empty array on error
  }
};

const parseEPG = async (url) => {
  console.log(`[EPG Parser] Loading EPG from: ${url}`);
  try {
    const response = await axios.get(url);
    console.log(`[EPG Parser] EPG Response Status: ${response.status}`);
    if (response.data.length > 0) {
      console.log(`[EPG Parser] EPG Raw Data (first 500 chars):\n${response.data.substring(0, 500)}...`);
    } else {
      console.log('[EPG Parser] EPG Response data is empty.');
      return {};
    }

    const parser = new xml2js.Parser();
    const parsed = await parser.parseStringPromise(response.data);
    const epg = {};

    for (const prog of parsed.tv.programme || []) {
      const channelId = prog.$.channel; // This is often the tvg-id from M3U
      const start = prog.$.start;
      const stop = prog.$.stop;
      const title = prog.title?.[0]?._ || prog.title?.[0] || ''; // Handle text nodes or direct string
      const description = prog.desc?.[0]?._ || prog.desc?.[0] || ''; // Handle text nodes or direct string

      const now = new Date();
      // EPG times are often in YYYYMMDDHHmmss [+/- offset] format, slice to get just the numbers
      const startTime = new Date(start.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
      const endTime = new Date(stop.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
          console.warn(`[EPG Parser] Invalid date format for program on channel ${channelId}: start=${start}, stop=${stop}`);
          continue;
      }

      // We'll store an array of programs for each channel for future 'next' functionality
      if (!epg[channelId]) {
        epg[channelId] = [];
      }
      epg[channelId].push({
        start: startTime,
        stop: endTime,
        title: title,
        description: description
      });
    }

    // Sort programs by start time for easier lookup
    for (const id in epg) {
        epg[id].sort((a, b) => a.start.getTime() - b.start.getTime());
    }

    console.log(`[EPG Parser] Loaded EPG for ${Object.keys(epg).length} channels with programs.`);
    return epg;
  } catch (err) {
    console.error(`[EPG Parser] ❌ Error loading or parsing EPG: ${err.message}`);
    if (err.response) {
      console.error(`[EPG Parser] Axios Error Status: ${err.response.status}`);
      console.error(`[EPG Parser] Axios Error Data: ${err.response.data?.substring(0, 200)}...`);
    }
    return {}; // Return empty object on error
  }
};

const getNowAndNextProgram = (channelId) => {
    const now = new Date();
    const programs = epgData[channelId];
    if (!programs || programs.length === 0) {
        return { now: null, next: null };
    }

    let currentProgram = null;
    let nextProgram = null;

    for (let i = 0; i < programs.length; i++) {
        const prog = programs[i];
        if (now >= prog.start && now < prog.stop) {
            currentProgram = prog;
            if (i + 1 < programs.length) {
                nextProgram = programs[i + 1];
            }
            break;
        } else if (now < prog.start) {
            // If we are before this program, and haven't found a current one,
            // this is the next upcoming program.
            if (!currentProgram) {
                nextProgram = prog;
            }
            break; // Stop looking as programs are sorted
        }
    }
    return { now: currentProgram, next: nextProgram };
};


const loadData = async () => {
  console.log('\n--- Initiating Data Load ---');
  if (!M3U_URL) {
    console.error('❌ M3U_URL is not set. Please set the M3U_URL environment variable.');
    return;
  }
  if (!EPG_URL) {
    console.warn('⚠️ EPG_URL is not set. EPG data will not be available.');
    // Allow continued operation without EPG if desired, or make it critical: return;
  }

  try {
    channels = await parseM3U(M3U_URL);
    if (EPG_URL) {
      epgData = await parseEPG(EPG_URL);
    } else {
      epgData = {};
    }
    console.log(`--- Data Load Complete: Loaded ${channels.length} channels and ${Object.keys(epgData).length} EPG entries ---`);
  } catch (err) {
    console.error('❌ Critical Error during data loading:', err.message);
    // On critical error, clear channels to avoid serving stale/bad data
    channels = [];
    epgData = {};
  }
};

const builder = new addonBuilder({
  id: 'org.stremio.iptvaddon', // Use a more standard ID format
  version: '1.0.1', // Increment version when making changes
  name: 'Custom IPTV with EPG',
  description: 'Live IPTV channels with category filtering and EPG now/next info.',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'iptv_live',
      name: 'Live IPTV Channels',
      extra: [{ name: 'search' }, { name: 'genre' }],
      // If your M3U has common genres, you can pre-define them for easier discovery
      // genres: ['News', 'Sports', 'Movies', 'Entertainment', 'Kids']
    }
  ],
  resources: ['catalog', 'stream', 'meta']
});

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== 'tv' || id !== 'iptv_live') {
      console.log(`[Catalog Handler] Request for unsupported type/id: ${type}/${id}`);
      return Promise.resolve({ metas: [] });
  }

  console.log(`[Catalog Handler] Request received. Extra: ${JSON.stringify(extra)}`);
  console.log(`[Catalog Handler] Total channels available: ${channels.length}`);

  let filtered = channels;

  if (extra?.genre) {
    const genre = extra.genre.toLowerCase();
    filtered = filtered.filter(c => c.group?.toLowerCase() === genre);
    console.log(`[Catalog Handler] Filtered by genre "${genre}": ${filtered.length} channels`);
  }

  if (extra?.search) {
    const searchTerm = extra.search.toLowerCase();
    filtered = filtered.filter(c => c.name.toLowerCase().includes(searchTerm));
    console.log(`[Catalog Handler] Filtered by search "${searchTerm}": ${filtered.length} channels`);
  }

  const metas = filtered.map((c, i) => {
    const programInfo = getNowAndNextProgram(c.tvgId || c.name); // Try tvgId first, then name
    let description = `Live stream from group: ${c.group}`;
    let name = c.name;

    if (programInfo.now) {
        name = `${c.name} - Now: ${programInfo.now.title}`;
        description = `Currently: ${programInfo.now.title}\n${programInfo.now.description || ''}\n${description}`;
    }
    if (programInfo.next) {
        const nextStartTime = programInfo.next.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        description += `\nNext (${nextStartTime}): ${programInfo.next.title}`;
    }

    return {
      id: 'channel_' + i, // Use index as ID, ensures uniqueness for this session
      name: name,
      type: 'tv',
      poster: c.tvgLogo || 'https://img.icons8.com/color/96/000000/retro-tv.png', // Use tvg-logo if available
      genres: [c.group],
      description: description,
      // background: c.tvgLogo, // Can also use for background image
      // logo: c.tvgLogo // Can also use for logo
    };
  });

  console.log(`[Catalog Handler] Returning ${metas.length} items to Stremio.`);
  return Promise.resolve({ metas });
});

builder.defineStreamHandler(({ type, id }) => {
  console.log(`[Stream Handler] Request for ID: ${id}, Type: ${type}`);
  const index = parseInt(id.replace('channel_', ''));
  const ch = channels[index];

  if (!ch) {
    console.warn(`[Stream Handler] Channel not found for ID: ${id}`);
    return Promise.resolve({ streams: [] });
  }

  const programInfo = getNowAndNextProgram(ch.tvgId || ch.name);
  let streamTitle = ch.name;
  if (programInfo.now) {
      streamTitle = `${ch.name} - Now: ${programInfo.now.title}`;
  } else if (programInfo.next) {
      streamTitle = `${ch.name} - Next: ${programInfo.next.title}`;
  }


  console.log(`[Stream Handler] Providing stream for "${ch.name}" from URL: ${ch.url}`);
  return Promise.resolve({
    streams: [{
      title: streamTitle,
      url: ch.url,
      // You can also add more info here like:
      // name: ch.name,
      // description: 'Live stream'
    }]
  });
});

builder.defineMetaHandler(({ type, id }) => {
  console.log(`[Meta Handler] Request for ID: ${id}, Type: ${type}`);
  const index = parseInt(id.replace('channel_', ''));
  const ch = channels[index];

  if (!ch) {
    console.warn(`[Meta Handler] Meta not found for ID: ${id}`);
    return Promise.resolve({ meta: null });
  }

  const programInfo = getNowAndNextProgram(ch.tvgId || ch.name);
  let description = `Live stream from group: ${ch.group}`;
  if (programInfo.now) {
    description = `Currently: ${programInfo.now.title}\n${programInfo.now.description || ''}\n${description}`;
  }
  if (programInfo.next) {
    const nextStartTime = programInfo.next.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    description += `\nNext (${nextStartTime}): ${programInfo.next.title}`;
  }


  console.log(`[Meta Handler] Providing meta for "${ch.name}".`);
  return Promise.resolve({
    meta: {
      id: id,
      type: 'tv',
      name: ch.name,
      description: description,
      genres: [ch.group],
      poster: ch.tvgLogo || 'https://img.icons8.com/color/96/000000/retro-tv.png',
      // background: ch.tvgLogo, // Can add a larger image
      // logo: ch.tvgLogo // Can add a smaller logo
    }
  });
});

const stremioInterface = builder.getInterface();

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  console.log('[Express] Manifest requested.');
  res.send(stremioInterface.manifest);
});

// Generic handler for Stremio resources
app.get('/:resource/:type/:id.json', async (req, res) => {
    try {
        const { resource, type, id } = req.params;
        const args = { type, id, extra: req.query };
        console.log(`[Express] Request for /${resource}/${type}/${id}.json with args: ${JSON.stringify(args)}`);

        // Check if the resource handler exists
        if (stremioInterface[resource]) {
            const result = await stremioInterface[resource](args);
            res.setHeader('Content-Type', 'application/json');
            res.send(result);
        } else {
            console.warn(`[Express] No handler found for resource: ${resource}`);
            res.status(404).send({ err: `Resource ${resource} not found.` });
        }
    } catch (err) {
        console.error('❌ [Express] Error in generic handler:', err.message);
        res.status(500).send({ err: err.message });
    }
});

// Handle requests with extra parameters (like genre/search)
app.get('/:resource/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { resource, type, id } = req.params;
        const args = { type, id, extra: req.query }; // Query parameters are in req.query
        console.log(`[Express] Request for /${resource}/${type}/${id}/:extra.json with args: ${JSON.stringify(args)}`);

        if (stremioInterface[resource]) {
            const result = await stremioInterface[resource](args);
            res.setHeader('Content-Type', 'application/json');
            res.send(result);
        } else {
            console.warn(`[Express] No handler found for resource: ${resource}`);
            res.status(404).send({ err: `Resource ${resource} not found.` });
        }
    } catch (err) {
        console.error('❌ [Express] Error in generic handler with extra:', err.message);
        res.status(500).send({ err: err.message });
    }
});


// Initial data load when the server starts
loadData();
// Refresh data every 15 minutes
setInterval(loadData, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Addon server running on http://localhost:${PORT}`);
  console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
  console.log(`Ensure M3U_URL and EPG_URL environment variables are set.`);
});
