const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const parser = require('iptv-playlist-parser');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const playlistUrl = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w';
const epgUrl = 'https://epg.pw/xmltv/epg_GB.xml';
const addonName = 'Shanny IPTV';

const builder = new addonBuilder({
    id: 'org.shanny.iptv',
    version: '1.0.0',
    name: addonName,
    description: 'IPTV addon for Stremio with category filtering, EPG, and performance enhancements.',
    catalogs: [],
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv'],
    idPrefixes: ['shannyiptv_'],
    logo: 'https://i.imgur.com/nD3I6Zd.png',
    background: 'https://i.imgur.com/xFPLt6A.jpeg',
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
});

let playlist = [];
let categories = {};
let epg = {};

// 🔄 Load M3U Playlist
const loadPlaylist = async () => {
    const res = await fetch(playlistUrl);
    const text = await res.text();
    const parsed = parser.parse(text);
    playlist = parsed.items;

    categories = {};
    for (const item of playlist) {
        const group = item.group.title || 'Other';
        if (!categories[group]) categories[group] = [];
        categories[group].push(item);
    }

    // Add category-based catalogs
    builder.manifest.catalogs = Object.keys(categories).map(cat => ({
        type: 'tv',
        id: `shannyiptv_${cat}`,
        name: addonName,
        extra: [],
        genres: [cat]
    }));
};

// 🔄 Lazy-load EPG
const loadEPG = async () => {
    try {
        const res = await fetch(epgUrl);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true });
        epg = {};
        for (const prog of result.tv.programme || []) {
            const channelId = prog.channel[0];
            if (!epg[channelId]) epg[channelId] = [];
            epg[channelId].push({
                title: prog.title?.[0] || '',
                start: dayjs(prog.start[0], 'YYYYMMDDHHmmss ZZ'),
                stop: dayjs(prog.stop[0], 'YYYYMMDDHHmmss ZZ')
            });
        }
    } catch (err) {
        console.error('Failed to load EPG:', err.message);
    }
};

// 🎬 Meta
builder.defineMetaHandler(({ id }) => {
    const item = playlist.find(i => `shannyiptv_${i.tvg.id}` === id || `shannyiptv_${i.name}` === id);
    if (!item) return Promise.resolve({ meta: {} });

    const epgNow = epg?.[item.tvg.id]?.find(p =>
        dayjs().isAfter(p.start) && dayjs().isBefore(p.stop)
    );

    return Promise.resolve({
        meta: {
            id: `shannyiptv_${item.tvg.id || item.name}`,
            type: 'tv',
            name: item.name,
            poster: item.tvg.logo || null,
            description: epgNow ? `Now: ${epgNow.title}` : 'Live stream',
            background: item.tvg.logo || null
        }
    });
});

// 📺 Catalog
builder.defineCatalogHandler(({ id }) => {
    const catName = id.replace('shannyiptv_', '');
    const items = categories[catName] || [];

    const metas = items.map(item => ({
        id: `shannyiptv_${item.tvg.id || item.name}`,
        type: 'tv',
        name: item.name,
        poster: item.tvg.logo || null
    }));

    return Promise.resolve({ metas });
});

// 📡 Stream
builder.defineStreamHandler(({ id }) => {
    const item = playlist.find(i => `shannyiptv_${i.tvg.id}` === id || `shannyiptv_${i.name}` === id);
    if (!item) return Promise.resolve({ streams: [] });

    return Promise.resolve({
        streams: [
            {
                title: item.name,
                url: item.url,
                externalUrl: true  // Avoid proxy for performance
            }
        ]
    });
});

// 🟢 Startup
(async () => {
    await loadPlaylist();
    loadEPG(); // Lazy loading

    serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
})();
