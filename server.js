const { serveHTTP, addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch'); // For CommonJS + node-fetch@2
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};
let categories = new Set();
let epgLoaded = false;

async function fetchM3U() {
    try {
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
                category,
                tvgId: item.tvg.id
            };
        });
    } catch (err) {
        console.error('❌ Failed to fetch M3U:', err);
    }
}

async function fetchEPG() {
    try {
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

        epgLoaded = true;
        console.log('✅ EPG loaded');
    } catch (err) {
        console.error('❌ Failed to fetch EPG:', err);
    }
}

function getNowNext(channelId) {
    if (!epgLoaded) return {};
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

// Build addon interface
async function buildAddon() {
    await fetchM3U();

    const manifest = {
        id: 'com.shanny.iptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Watch IPTV with category filters and EPG',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [{
            type: 'tv',
            id: 'shanny-iptv',
            name: 'Shanny IPTV',
            extra: [{ name: 'genre', options: [...categories], isRequired: false }]
        }],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ extra }) => {
        const genre = extra?.genre;
        const filtered = genre
            ? channels.filter(ch => ch.category === genre)
            : channels;

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
        if (!epgLoaded) await fetchEPG();

        const channel = channels.find(ch => ch.id === id);
        if (!channel) return { meta: {} };

        const epg = getNowNext(channel.tvgId);
        return {
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                logo: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`
            }
        };
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return { streams: [] };

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: channel.name,
                externalUrl: true // Prevents proxy and reduces freezing
            }]
        });
    });

    return builder.getInterface();
}

buildAddon().then(addonInterface => {
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log('✅ Shanny IPTV Addon running on port 7000...');
}).catch(err => {
    console.error('❌ Error starting addon:', err);
});
