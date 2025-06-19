const { addonBuilder, getRouter } = require('stremio-addon-sdk'); // Import getRouter
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
  const regex = /(\S+?)="([^"]*?)"/g;
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
        const attributes = extractExtinfAttributes(line);
        const nameMatch = line.match(/,(.*)$/);

        current = {
          name: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
          group: attributes['group-title'] || 'Other',
          tvgId: attributes['tvg-id'] || null,
          tvgLogo: attributes['tvg-logo'] || null
        };
      } else if (line && !line.startsWith('#')) {
        current.url = line.trim();

        if (current.name && current.url) {
          result.push({ ...current });
        } else {
          console.warn(`[M3U Parser] Skipping incomplete channel (name: ${current.name}, url: ${current.url})`);
        }
        current = {};
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
    return [];
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
      const channelId = prog.$.channel;
      const start = prog.$.start;
      const stop = prog.$.stop;
      const title = prog.title?.[0]?._ || prog.title?.[0] || '';
      const description = prog.desc?.[0]?._ || prog.desc?.[0] || '';

      const now = new Date();
      const startTime = new Date(start.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));
      const endTime = new Date(stop.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'));

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
          console.warn(`[EPG Parser] Invalid date format for program on channel ${channelId}: start=${start}, stop=${stop}`);
          continue;
      }

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
    return {};
  }
};

const getNowAndNextProgram = (channelIdentifier) => {
    const now = new Date();
    const programs = epgData[channelIdentifier];
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
            if (!currentProgram) {
                nextProgram = prog;
            }
            break;
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
    channels = [];
    epgData = {};
  }
};

const builder = new addonBuilder({
  id: 'org.stremio.iptvaddon',
  version: '1.0.1',
  name: 'Custom IPTV with EPG',
  description: 'Live IPTV channels with category filtering and EPG now/next info.',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'iptv_live',
      name: 'Live IPTV Channels',
      extra: [{ name: 'search' }, { name: 'genre' }]
    }
  ],
  resources: ['catalog', 'stream', 'meta']
});

builder.defineCatalogHandler(({ type, id, extra }) => {
  // This log will now correctly show "tv" and "iptv_live" if the router works
  console.log(`[Catalog Handler] defineCatalogHandler invoked. Type: "${type}", ID: "${id}", Extra: ${JSON.stringify(extra)}`);

  if (type !== 'tv' || id !== 'iptv_live') {
      console.log(`[Catalog Handler] Request for unsupported type/id: ${type}/${id}. Skipping.`);
      return Promise.resolve({ metas: [] });
  }

  console.log(`[Catalog Handler] Request received. Extra: ${JSON.stringify(extra)}`);
  console.log(`[Catalog Handler] Total channels available (before filtering): ${channels.length}`);

  let filtered = channels;

  if (extra?.genre) {
    const genre = extra.genre.toLowerCase();
    console.log(`[Catalog Handler] Applying genre filter: "${genre}"`);
    filtered = filtered.filter(c => c.group?.toLowerCase() === genre);
    console.log(`[Catalog Handler] Channels after genre filter: ${filtered.length}`);
  }

  if (extra?.search) {
    const searchTerm = extra.search.toLowerCase();
    console.log(`[Catalog Handler] Applying search filter: "${searchTerm}"`);
    filtered = filtered.filter(c => c.name.toLowerCase().includes(searchTerm));
    console.log(`[Catalog Handler] Channels after search filter: ${filtered.length}`);
  }

  console.log(`[Catalog Handler] Final filtered channels count (before map): ${filtered.length}`);

  const metas = filtered.map((c, i) => {
    const epgIdentifier = c.tvgId || c.name;
    const programInfo = getNowAndNextProgram(epgIdentifier);
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
      id: 'channel_' + i,
      name: name,
      type: 'tv',
      poster: c.tvgLogo || 'https://img.icons8.com/color/96/000000/retro-tv.png',
      genres: [c.group],
      description: description,
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

  const epgIdentifier = ch.tvgId || ch.name;
  const programInfo = getNowAndNextProgram(epgIdentifier);
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
      url: ch.url
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

  const epgIdentifier = ch.tvgId || ch.name;
  const programInfo = getNowAndNextProgram(epgIdentifier);
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
      poster: ch.tvgLogo || 'https://img.icons8.com/color/96/000000/retro-tv.png'
    }
  });
});

// Use the SDK's getRouter to handle all resource endpoints
// This single line replaces all your app.get('/:resource/:type/:id.json', ...) routes
app.use(getRouter(builder)); // This needs to be AFTER builder.define... calls

// Keep the manifest route separate, as it's a direct file request
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  console.log('[Express] Manifest requested.');
  // builder.getInterface().manifest is the correct way to get the manifest object
  res.send(builder.getInterface().manifest);
});


// Initial data load when the server starts
loadData();
// Refresh data every 15 minutes (convert to milliseconds: 15 minutes * 60 seconds/minute * 1000 ms/second)
setInterval(loadData, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Addon server running on http://localhost:${PORT}`);
  console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
  console.log(`Ensure M3U_URL and EPG_URL environment variables are set in Render.com.`);
});
