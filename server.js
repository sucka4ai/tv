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

    channels = parsed.items.map((item, index) => {
        const id = `shannyiptv_${index}`;
        const name = item.name || `Channel ${index}`;
        const logo = item.tvg.logo;
        const group = item.group.title || 'Uncategorized';
        const url = item.url;

        if (!categories[group]) categories[group] = [];
        categories[group].push({ id, name, logo, url, group });

        return { id, name, logo, url, group };
    });
}

async function loadEPG() {
    try {
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml);
        const epg = {};

        if (result.tv && result.tv.programme) {
            result.tv.programme.forEach((program) => {
                const channel = program.$.channel;
                const title = program.title?.[0]?._ || '';
                const start = program.$.start;
                const stop = program.$.stop;

                if (!epg[channel]) epg[channel] = [];
                epg[channel].push({ title, start, stop });
            });
        }

        epgData = epg;
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

const builder = new addonBuilder({
    id: 'org.shanny.iptv',
    version: '1.0.0',
    name: 'Shanny IPTV',
    description: 'Watch live TV channels with category filtering',
    types: ['tv'],
    catalogs: [],
    resources: ['catalog', 'stream', 'meta'],
    idPrefixes: ['shannyiptv_'],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
});

builder.defineCatalogHandler(({ id, extra }) => {
    const genre = extra.genre || 'All Channels';

    let items = [];
    if (genre === 'All Channels') {
        items = channels;
    } else {
        items = categories[genre] || [];
    }

    return Promise.resolve({
        metas: items.map(c => {
            const nowNext = getNowNext(c.name) || {};
            return {
                id: c.id,
                type: 'tv',
                name: `${c.name}${nowNext.now ? ` | Now: ${nowNext.now}` : ''}`,
                poster: c.logo || '',
                background: c.logo || '',
                genres: [c.group]
            };
        })
    });
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
            poster: channel.logo || '',
            background: channel.logo || '',
            genres: [channel.group]
        }
    });
});

async function start() {
    await loadPlaylist();
    await loadEPG();

    // Add "All Channels" as the main catalog and each group as a genre filter
    builder.manifest.catalogs = [
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
    ];

    const PORT = process.env.PORT || 7000;
    http.createServer(serveHTTP(builder.getInterface())).listen(PORT, () => {
        console.log(`🚀 Shanny IPTV addon running on port ${PORT}`);
    });
}

start();
