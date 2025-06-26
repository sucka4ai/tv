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

function getUnsplashImage(category) {
    const encoded = encodeURIComponent(category || 'tv');
    return `https://source.unsplash.com/1600x900/?${encoded}`;
}

async function buildAddon() {
    await fetchM3U();
    await fetchEPG();

    const categoryList = Array.from(categories).sort();
    const manifest = {
        id: 'community.shannyiptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'IPTV with EPG and category filtering',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv'],
        catalogs: [{
            type: 'tv',
            id: 'shannyiptv',
            name: 'Shanny IPTV',
            extra: [{
                name: 'genre',
                isRequired: false,
                options: ['All', ...categoryList]
            }]
        }],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ id, extra }) => {
        let filtered = channels;
        const genre = extra?.genre;

        if (genre && genre !== 'All') {
            filtered = filtered.filter(ch => ch.category === genre);
        }

        return Promise.resolve({
            metas: filtered.map(ch => ({
                id: ch.id,
                type: 'tv',
                name: ch.name,
                poster: ch.logo,
                background: getUnsplashImage(ch.category),
                description: `Live stream for ${ch.name}`
            }))
        });
    });

    builder.defineMetaHandler(({ id }) => {
        const ch = channels.find(ch => ch.id === id);
        if (!ch) return Promise.resolve({ meta: {} });

        const epg = getNowNext(ch.tvgId);
        return Promise.resolve({
            meta: {
                id: ch.id,
                type: 'tv',
                name: ch.name,
                logo: ch.logo,
                poster: ch.logo,
                background: getUnsplashImage(ch.category),
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`
            }
        });
    });

    builder.defineStreamHandler(({ id }) => {
        const ch = channels.find(ch => ch.id === id);
        if (!ch) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: ch.url,
                title: ch.name,
                behaviorHints: {
                    notWebReady: true // prevents freezing and forces direct stream handling
                }
            }]
        });
    });

    return builder.getInterface();
}

buildAddon().then(addon => {
    serveHTTP(addon, { port: process.env.PORT || 7000 });
    console.log('✅ Shanny IPTV Addon running with optimized streaming...');
}).catch(err => {
    console.error('❌ Failed to start addon:', err);
});
