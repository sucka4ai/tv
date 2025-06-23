const { serveHTTP, addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};
let categories = new Set();

async function fetchM3U() {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);
    channels = parsed.items.map((item, index) => {
        const category = item.group.title || 'Uncategorized';
        categories.add(category);
        return {
            id: `channel-${index}`,
            name: item.name,
            url: item.url,
            logo: item.tvg.logo,
            category: category,
            tvgId: item.tvg.id
        };
    });
}

async function fetchEPG() {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);
    const programs = result.tv.programme || [];
    epgData = {};

    for (const program of programs) {
        const channelId = program.$.channel;
        if (!epgData[channelId]) epgData[channelId] = [];
        epgData[channelId].push({
            start: program.$.start,
            stop: program.$.stop,
            title: program.title?.[0]?._ || 'No Title',
            desc: program.desc?.[0]?._ || ''
        });
    }
}

function getNowNext(channelId) {
    const now = dayjs();
    const programs = epgData[channelId] || [];
    let nowProgram = null;
    let nextProgram = null;

    for (let i = 0; i < programs.length; i++) {
        const start = dayjs(programs[i].start, 'YYYYMMDDHHmmss ZZ');
        const end = dayjs(programs[i].stop, 'YYYYMMDDHHmmss ZZ');
        if (now.isAfter(start) && now.isBefore(end)) {
            nowProgram = programs[i];
            nextProgram = programs[i + 1] || null;
            break;
        }
    }

    return { now: nowProgram, next: nextProgram };
}

// Build addon
async function buildAddon() {
    await fetchM3U();
    await fetchEPG();

    const manifest = {
        id: 'community.myiptv',
        version: '1.0.0',
        name: 'My IPTV',
        description: 'Watch IPTV channels by category with EPG',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv'],
        catalogs: [{ type: 'tv', id: 'iptv-root', name: 'My IPTV' }],
        idPrefixes: ['channel-', 'cat-']
    };

    const builder = new addonBuilder(manifest);

    // First level: categories shown under root catalog
    builder.defineCatalogHandler(({ id }) => {
        if (id === 'iptv-root') {
            const catMetas = [...categories].map(cat => ({
                id: `cat-${cat.toLowerCase().replace(/\s+/g, '-')}`,
                type: 'tv',
                name: cat,
                poster: 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Television_static.png',
                description: `Browse ${cat} channels`
            }));
            return Promise.resolve({ metas: catMetas });
        }

        // Category catalog
        const catName = id.replace(/^cat-/, '').replace(/-/g, ' ').toLowerCase();
        const filtered = channels.filter(ch => ch.category.toLowerCase() === catName);
        const metas = filtered.map(channel => {
            const epg = getNowNext(channel.tvgId);
            return {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                description: `${epg.now?.title || 'Live Channel'} — ${epg.next?.title || 'Up next'}`
            };
        });
        return Promise.resolve({ metas });
    });

    builder.defineMetaHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ meta: {} });

        const epg = getNowNext(channel.tvgId);
        return Promise.resolve({
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                description: `${epg.now?.title || 'Live'}\n${epg.now?.desc || ''}`
            }
        });
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ streams: [] });
        return Promise.resolve({
            streams: [{ title: channel.name, url: channel.url }]
        });
    });

    return builder.getInterface();
}

// Start
buildAddon().then(addonInterface => {
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log('✅ IPTV Addon running on port', process.env.PORT || 7000);
}).catch(err => {
    console.error('❌ Error starting IPTV addon:', err);
});
