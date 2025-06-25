import sdk from 'stremio-addon-sdk';
import fetch from 'node-fetch';
import parser from 'iptv-playlist-parser';
import xml2js from 'xml2js';
import dayjs from 'dayjs';

const { serveHTTP, addonBuilder } = sdk;


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
    console.log(`✅ Fetched ${channels.length} channels from M3U`);
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
        console.log(`✅ EPG loaded with ${Object.keys(epgData).length} channels`);
    } catch (err) {
        console.warn('⚠️ Failed to fetch or parse EPG:', err.message);
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

// Category Catalog Mapping
const CATEGORY_CATALOG_ID = 'shannyiptv';
const categoryCatalogs = [...categories].map(cat => ({
    type: 'tv',
    id: `${CATEGORY_CATALOG_ID}:${cat.toLowerCase().replace(/\s+/g, '-')}`,
    name: cat
}));

// Build Addon
async function buildAddon() {
    await fetchM3U();

    const manifest = {
        id: 'community.shannyiptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Live IPTV channels with EPG and categories',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: CATEGORY_CATALOG_ID,
                name: 'Shanny IPTV',
                extra: [{ name: 'genre', isRequired: false }]
            }
        ],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    // Master category list
    builder.defineCatalogHandler(({ id, extra }) => {
        if (id === CATEGORY_CATALOG_ID) {
            // Genre filter
            const genre = extra?.genre;
            const filtered = genre
                ? channels.filter(ch => ch.category.toLowerCase().replace(/\s+/g, '-') === genre)
                : channels;

            const metas = filtered.map(channel => ({
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `Live stream for ${channel.name}`,
                genre: channel.category
            }));

            return Promise.resolve({ metas });
        }

        return Promise.resolve({ metas: [] });
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
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`,
                genre: channel.category
            }
        });
    });

    builder.defineStreamHandler(({ id }) => {
        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ streams: [] });

        if (!channel.url.endsWith('.m3u8')) {
            console.warn(`⚠️ Non-m3u8 stream allowed: ${channel.url}`);
        }

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: channel.name,
                externalUrl: true
            }]
        });
    });

    // Lazy-load EPG in background
    fetchEPG().catch(() => console.warn('❌ Failed to load EPG'));

    return builder.getInterface();
}

// Start server
buildAddon()
    .then(addonInterface => {
        serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
        console.log('🚀 Shanny IPTV Addon running...');
    })
    .catch(err => {
        console.error('❌ Error starting addon:', err);
    });
