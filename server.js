import pkg from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = pkg;

import fetch from 'node-fetch';
import parser from 'iptv-playlist-parser';
import xml2js from 'xml2js';
import dayjs from 'dayjs';

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};
let categories = new Set();
let epgLoaded = false;

async function fetchM3U() {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);

    channels = parsed.items
        .filter(item => item.url && item.url.includes('.m3u8')) // Only use .m3u8 URLs
        .map((item, index) => {
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
}

async function fetchEPG() {
    if (epgLoaded) return;
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
        id: 'community.shannyiptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Live IPTV channels with EPG and category support',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv'],
        catalogs: [{
            type: 'tv',
            id: 'shannyiptv',
            name: 'Shanny IPTV',
            extra: [{ name: 'genre', isRequired: false }]
        }],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ extra }) => {
        const genre = extra?.genre;
        const filtered = genre
            ? channels.filter(ch => ch.category.toLowerCase().replace(/\s+/g, '-') === genre)
            : channels;

        const metas = filtered.map(ch => ({
            id: ch.id,
            type: 'tv',
            name: ch.name,
            poster: ch.logo,
            background: getUnsplashImage(ch.category),
            description: `Live stream for ${ch.name}`
        }));

        return Promise.resolve({ metas, cacheMaxAge: 3600 });
    });

    builder.defineMetaHandler(async ({ id }) => {
        await fetchEPG(); // lazy load EPG

        const channel = channels.find(ch => ch.id === id);
        if (!channel) return { meta: {} };

        const epg = getNowNext(channel.tvgId);

        return {
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                logo: channel.logo,
                poster: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`
            }
        };
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return { streams: [] };

        return {
            streams: [{
                url: channel.url,
                title: channel.name,
                externalUrl: true // disables proxying
            }]
        };
    });

    return builder.getInterface();
}

buildAddon().then(addonInterface => {
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log('✅ Shanny IPTV Addon running...');
}).catch(err => {
    console.error('❌ Failed to start addon:', err);
});
