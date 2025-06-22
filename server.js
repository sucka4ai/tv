const { addonBuilder } = require('@stremio/sdk');
const fetch = require('node-fetch');
const { parse } = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w'; // Replace with your real M3U
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';  // Replace with your real EPG

let channels = [];
let epgData = {};

// Load playlist and EPG
async function loadPlaylistAndEPG() {
    try {
        const m3uRes = await fetch(M3U_URL);
        const m3uText = await m3uRes.text();
        channels = parse(m3uText).items;

        const epgRes = await fetch(EPG_URL);
        const epgText = await epgRes.text();
        const epgParsed = await xml2js.parseStringPromise(epgText);
        epgData = epgParsed.tv;
        console.log('Loaded M3U and EPG');
    } catch (err) {
        console.error('Error loading playlist or EPG:', err);
    }
}

loadPlaylistAndEPG();
setInterval(loadPlaylistAndEPG, 15 * 60 * 1000); // refresh every 15 mins

// Create the addon
const builder = new addonBuilder({
    id: 'org.ip.tv',
    version: '1.0.0',
    name: 'My IPTV Addon',
    description: 'Live TV from M3U playlist with EPG',
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv'],
    catalogs: [{ type: 'tv', id: 'iptv_catalog', name: 'IPTV' }],
});

// Catalog handler
builder.defineCatalogHandler(({ type, id }) => {
    if (type !== 'tv' || id !== 'iptv_catalog') return { metas: [] };

    const metas = channels.map(ch => ({
        id: Buffer.from(ch.url).toString('base64'),
        type: 'tv',
        name: ch.name || 'Unnamed Channel',
        poster: ch.tvg.logo || null,
    }));

    return { metas };
});

// Meta handler
builder.defineMetaHandler(({ id }) => {
    const url = Buffer.from(id, 'base64').toString();
    const channel = channels.find(c => c.url === url);
    if (!channel) return { meta: null };

    const epgEntry = epgData?.programme?.find(p => p.$.channel === channel.tvg.id);
    const now = dayjs();
    const title = epgEntry?.title?.[0] || channel.name;
    const description = epgEntry?.desc?.[0] || 'No description available';

    return {
        meta: {
            id,
            type: 'tv',
            name: title,
            description,
            poster: channel.tvg.logo || null,
        }
    };
});

// Stream handler
builder.defineStreamHandler(({ id }) => {
    const url = Buffer.from(id, 'base64').toString();
    const stream = channels.find(c => c.url === url);
    if (!stream) return { streams: [] };

    return {
        streams: [{
            title: stream.name,
            url: stream.url
        }]
    };
});

// Export addon interface
module.exports = builder.getInterface();
