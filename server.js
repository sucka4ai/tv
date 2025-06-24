const { serveHTTP, addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let categories = new Set();
let epgData = {};
const epgCache = {};

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
            url: item.url.includes('.m3u8') ? item.url : item.url, // conservatively keep as-is
            logo: item.tvg.logo,
            category: category,
            tvgId: item.tvg.id || `tvg-${index}`
        };
    });
}

function getUnsplashImage(category) {
    const encoded = encodeURIComponent(category || 'tv');
    return `https://source.unsplash.com/1600x900/?${encoded}`;
}

async function getNowNext(channelId) {
    const now = dayjs();

    // Lazy load full EPG data once
    if (!Object.keys(epgData).length) {
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml);
        const programs = result.tv?.programme || [];

        for (const program of programs) {
            const cid = program.$.channel;
            if (!epgData[cid]) epgData[cid] = [];
            epgData[cid].push({
                start: program.$.start,
                stop: program.$.stop,
                title: program.title?.[0]?._ || 'No Title',
                desc: program.desc?.[0]?._ || ''
            });
        }
    }

    if (!epgCache[channelId]) {
        epgCache[channelId] = epgData[channelId] || [];
    }

    const programs = epgCache[channelId];
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

async function buildAddon() {
    await fetchM3U();

    const manifest = {
        id: 'community.shannyiptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Live IPTV channels with categories and EPG',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'shannyiptv',
                name: 'Shanny IPTV',
                extra: [{ name: 'genre', options: [...categories], isRequired: false }]
            }
        ],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ type, id, extra }) => {
        let filtered = channels;
        if (extra && extra.genre) {
            filtered = channels.filter(ch => ch.category === extra.genre);
        }
        return Promise.resolve({
            metas: filtered.map(channel => ({
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `Live stream for ${channel.name}`
            }))
        });
    });

    builder.defineMetaHandler(async ({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return { meta: {} };

        const epg = await getNowNext(channel.tvgId);
        return {
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                logo: channel.logo,
                poster: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `${epg.now?.title || 'No program info'} — ${epg.next?.title || 'No next info'}`
            }
        };
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: channel.name,
                externalUrl: true // ✅ stream played directly in Stremio
            }]
        });
    });

    return builder.getInterface();
}

// Start server
buildAddon().then(addonInterface => {
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log('✅ Shanny IPTV Addon running...');
}).catch(err => {
    console.error('❌ Error starting IPTV addon:', err);
});
