import { addonBuilder, serveHTTP } from 'stremio-addon-sdk';
import fetch from 'node-fetch';
import parser from 'iptv-playlist-parser';
import xml2js from 'xml2js';
import dayjs from 'dayjs';

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;
const PORT = process.env.PORT || 7000;

let channels = [];
let epgData = {};
let categories = new Set();

async function fetchM3U() {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);
    channels = parsed.items
        .filter(item => item.url.endsWith('.m3u8')) // only keep HLS streams
        .map((item, index) => {
            const category = item.group?.title || 'Uncategorized';
            categories.add(category);
            return {
                id: `channel-${index}`,
                name: item.name,
                url: item.url,
                logo: item.tvg?.logo,
                category: category,
                tvgId: item.tvg?.id
            };
        });
}

async function fetchEPG() {
    try {
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml);
        const programs = result.tv?.programme || [];

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
        console.log('✅ EPG loaded');
    } catch (err) {
        console.error('❌ Error loading EPG:', err.message);
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

    const manifest = {
        id: 'shanny.iptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Watch IPTV channels with categories and EPG',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        types: ['tv'],
        resources: ['catalog', 'stream', 'meta'],
        idPrefixes: ['channel-'],
        catalogs: [{
            type: 'tv',
            id: 'shanny-iptv',
            name: 'Shanny IPTV',
            extra: [
                {
                    name: 'genre',
                    isRequired: false,
                    options: Array.from(categories).map(cat => cat.toLowerCase().replace(/\s+/g, '-')),
                    optionsLimit: 100
                }
            ]
        }]
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ id, extra }) => {
        if (id !== 'shanny-iptv') return Promise.resolve({ metas: [] });

        const genre = (extra?.genre || '').toLowerCase();
        const filtered = genre
            ? channels.filter(ch => ch.category.toLowerCase().replace(/\s+/g, '-') === genre)
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
                background: getUnsplashImage(channel.category),
                logo: channel.logo,
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`
            }
        });
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: channel.url,
                externalUrl: true,
                title: channel.name
            }]
        });
    });

    return builder.getInterface();
}

// Start server
buildAddon().then(addon => {
    serveHTTP(addon, { port: PORT });
    console.log(`✅ Shanny IPTV Addon running on port ${PORT}`);
    setTimeout(fetchEPG, 5000); // lazy-load EPG after boot
}).catch(err => {
    console.error('❌ Error starting addon:', err.message);
});
