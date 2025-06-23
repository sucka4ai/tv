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
let isReady = false;

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

async function loadData() {
    try {
        console.log('🔄 Fetching M3U and EPG data...');
        categories = new Set(); // reset in case of reload
        await fetchM3U();
        await fetchEPG();
        isReady = true;
        console.log(`✅ Loaded ${channels.length} channels in ${categories.size} categories`);
    } catch (err) {
        console.error('❌ Error fetching data:', err.message);
    }
}

// Initial load
loadData();

// Refresh every 30 minutes
setInterval(loadData, 30 * 60 * 1000);

// Addon builder
async function buildAddon() {
    const manifest = {
        id: 'community.iptvaddon',
        version: '1.0.0',
        name: 'IPTV Channels',
        description: 'Watch IPTV channels with EPG and category support',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv'],
        catalogs: [
            { type: 'tv', id: 'all', name: 'All Channels' },
            ...[...categories].map(cat => ({
                type: 'tv',
                id: cat.toLowerCase().replace(/\s+/g, '-'),
                name: cat
            }))
        ],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ id }) => {
        if (!isReady) {
            return Promise.resolve({
                metas: [{
                    id: 'loading',
                    type: 'tv',
                    name: 'Loading channels...',
                    poster: 'https://i.imgur.com/llF5iyg.gif',
                    description: 'Fetching IPTV playlist and EPG. Please wait...'
                }]
            });
        }

        const filtered = id === 'all'
            ? channels
            : channels.filter(ch => ch.category.toLowerCase().replace(/\s+/g, '-') === id);

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
        if (!isReady) return Promise.resolve({ meta: {} });

        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ meta: {} });

        const epg = getNowNext(channel.tvgId);
        return Promise.resolve({
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                logo: channel.logo,
                poster: channel.logo,
                background: getUnsplashImage(channel.category),
                description: `${epg.now?.title || 'No EPG'} — ${epg.next?.title || 'No info'}`
            }
        });
    });

    builder.defineStreamHandler(({ id }) => {
        if (!isReady) return Promise.resolve({ streams: [] });

        const channel = channels.find(ch => ch.id === id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: channel.name
            }]
        });
    });

    return builder.getInterface();
}

// Serve the addon
buildAddon().then(addonInterface => {
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    console.log('✅ IPTV Addon running...');
}).catch(err => {
    console.error('❌ Error starting IPTV addon:', err);
});
