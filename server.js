require('dotenv').config();
const { addonBuilder } = require('stremio-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

// Load environment variables
const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

if (!M3U_URL || !EPG_URL) {
    throw new Error('M3U_URL and EPG_URL must be set in environment variables');
}

let channels = [];
let epgData = {};

// Parse M3U
async function fetchChannels() {
    const res = await fetch(M3U_URL);
    const m3u = await res.text();
    const { items } = parser.parse(m3u);
    channels = items.map(item => ({
        id: item.tvg.id || item.name,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo,
        group: item.group.title || 'Other',
    }));
}

// Parse EPG XML
async function fetchEPG() {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true });
    epgData = {};

    if (!result.tv || !result.tv.programme) return;

    result.tv.programme.forEach(program => {
        const channel = program.channel[0];
        if (!epgData[channel]) epgData[channel] = [];
        epgData[channel].push({
            title: program.title?.[0]._ || '',
            start: dayjs(program.start[0], 'YYYYMMDDHHmmss Z'),
            stop: dayjs(program.stop[0], 'YYYYMMDDHHmmss Z'),
        });
    });
}

// Return current program for a channel
function getNowNext(channelId) {
    const now = dayjs();
    const entries = epgData[channelId] || [];
    const current = entries.find(ep => now.isAfter(ep.start) && now.isBefore(ep.stop));
    const nextIndex = entries.findIndex(ep => ep === current) + 1;
    const next = entries[nextIndex];

    return {
        now: current?.title || 'Live',
        next: next?.title || '',
    };
}

// Build addon
const builder = new addonBuilder({
    id: 'org.ip.tv',
    name: 'Custom IPTV',
    version: '1.0.0',
    description: 'IPTV addon with M3U and EPG support',
    types: ['tv'],
    catalogs: [
        {
            type: 'tv',
            id: 'iptv',
            name: 'IPTV Live Channels',
            extra: [{ name: 'genre', isRequired: false }],
        },
    ],
    resources: ['catalog', 'stream', 'meta'],
    idPrefixes: ['iptv_'],
    logo: 'https://i.imgur.com/V2Z4Tme.png',
});

builder.defineCatalogHandler(({ extra }) => {
    const genre = extra?.genre;
    const metas = channels
        .filter(c => !genre || c.group === genre)
        .map(c => ({
            id: 'iptv_' + c.id,
            type: 'tv',
            name: c.name,
            poster: c.logo,
            posterShape: 'landscape',
            genre: [c.group],
        }));
    return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ id }) => {
    const channelId = id.replace('iptv_', '');
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return Promise.resolve({ meta: null });

    const { now, next } = getNowNext(channelId);
    return Promise.resolve({
        meta: {
            id,
            type: 'tv',
            name: channel.name,
            poster: channel.logo,
            description: `Now: ${now}\nNext: ${next}`,
            background: channel.logo,
        },
    });
});

builder.defineStreamHandler(({ id }) => {
    const channelId = id.replace('iptv_', '');
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return Promise.resolve({ streams: [] });

    return Promise.resolve({
        streams: [
            {
                title: channel.name,
                url: channel.url,
            },
        ],
    });
});

(async () => {
    await fetchChannels();
    await fetchEPG();
    console.log('Channels and EPG loaded.');
})();

module.exports = builder.getInterface();
