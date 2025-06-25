const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const http = require('http');

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w'; 
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml'; 

let channels = [];
let categories = {};
let epgData = {};

async function loadPlaylist() {
    const res = await fetch(M3U_URL);
    const m3u = await res.text();
    const parsed = parser.parse(m3u);

    parsed.items.forEach((item, index) => {
        const id = `shannyiptv_${index}`;
        const name = item.name || `Channel ${index}`;
        const logo = item.tvg.logo;
        const group = item.group.title || 'Uncategorized';
        const url = item.url;

        const channel = { id, name, logo, url, group };
        channels.push(channel);

        if (!categories[group]) categories[group] = [];
        categories[group].push(channel);
    });
}

async function loadEPG() {
    try {
        if (!EPG_URL) return;
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const parsed = await xml2js.parseStringPromise(xml);
        if (parsed.tv && parsed.tv.programme) {
            parsed.tv.programme.forEach((p) => {
                const channelId = p.$.channel;
                if (!epgData[channelId]) epgData[channelId] = [];
                epgData[channelId].push({
                    title: p.title?.[0]?._ || '',
                    start: p.$.start,
                    stop: p.$.stop
                });
            });
        }
    } catch (err) {
        console.error('Failed to load EPG:', err.message);
    }
}

function getNowNext(channelId) {
    const programs = epgData[channelId];
    if (!programs) return null;

    const now = dayjs();
    const current = programs.find(p => {
        const start = dayjs(p.start, 'YYYYMMDDHHmmss ZZ');
        const end = dayjs(p.stop, 'YYYYMMDDHHmmss ZZ');
        return now.isAfter(start) && now.isBefore(end);
    });

    const nextIndex = programs.findIndex(p => p === current) + 1;
    const next = programs[nextIndex];

    return {
        now: current ? current.title : '',
        next: next ? next.title : ''
    };
}

// Initialize builder only after loading playlist
async function start() {
    await loadPlaylist();
    await loadEPG();

    const builder = new addonBuilder({
        id: 'org.shanny.iptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Live TV channels with categories and now/next support',
        types: ['tv'],
        resources: ['catalog', 'stream', 'meta'],
        idPrefixes: ['shannyiptv_'],
        behaviorHints: {
            configurable: false,
            configurationRequired: false
        },
        catalogs: [
            {
                type: 'tv',
                id: 'shannyiptv',
                name: 'Shanny IPTV',
                extra: [
                    {
                        name: 'genre',
                        isRequired: false,
                        options: ['All Channels', ...Object.keys(categories)]
                    }
                ]
            }
        ]
    });

    builder.defineCatalogHandler(({ id, extra }) => {
        const genre = extra.genre || 'All Channels';
        const filtered = genre === 'All Channels' ? channels : categories[genre] || [];

        const metas = filtered.map(channel => {
            const nowNext = getNowNext(channel.name) || {};
            return {
                id: channel.id,
                type: 'tv',
                name: `${channel.name}${nowNext.now ? ` | Now: ${nowNext.now}` : ''}`,
                poster: channel.logo,
                background: channel.logo,
                genres: [channel.group]
            };
        });

        return Promise.resolve({ metas });
    });

    builder.defineStreamHandler(({ id }) => {
        const stream = channels.find(c => c.id === id);
        if (!stream) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                title: stream.name,
                url: stream.url,
                externalUrl: true
            }]
        });
    });

    builder.defineMetaHandler(({ id }) => {
        const channel = channels.find(c => c.id === id);
        if (!channel) return Promise.resolve({ meta: {} });

        return Promise.resolve({
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                background: channel.logo,
                genres: [channel.group]
            }
        });
    });

    const PORT = process.env.PORT || 7000;
    http.createServer(serveHTTP(builder.getInterface())).listen(PORT, () => {
        console.log(`✅ Shanny IPTV Addon running on port ${PORT}`);
    });
}

start();
