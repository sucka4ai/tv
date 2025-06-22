const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const { parse } = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
app.use(cors());

// === CONFIGURATION ===
const M3U_URL = 'https://example.com/playlist.m3u';
const EPG_URL = 'https://example.com/epg.xml';
const PROXY_PREFIX = '/proxy/';
const ADDON_ID = 'org.myaddon.iptv';
const ADDON_NAME = 'My IPTV Addon';

let channels = [];
let epg = {};

async function loadM3U() {
    try {
        const res = await fetch(M3U_URL);
        const text = await res.text();
        const parsed = parse(text);
        channels = parsed.items.map((item, index) => ({
            id: `iptv_${index}`,
            name: item.name,
            url: item.url,
            logo: item.tvg.logo || null,
            group: item.group.title || 'Other'
        }));
        console.log(`Loaded ${channels.length} channels`);
    } catch (err) {
        console.error('Error loading M3U:', err);
    }
}

async function loadEPG() {
    try {
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml);
        const guide = result.tv.programme;
        epg = {};

        guide.forEach(prog => {
            const channelId = prog.$.channel;
            if (!epg[channelId]) epg[channelId] = [];
            epg[channelId].push({
                title: prog.title?.[0]?._ || '',
                desc: prog.desc?.[0]?._ || '',
                start: prog.$.start,
                stop: prog.$.stop
            });
        });

        console.log(`Loaded EPG for ${Object.keys(epg).length} channels`);
    } catch (err) {
        console.error('Error loading EPG:', err);
    }
}

function getNowNext(channelName) {
    const now = dayjs();
    const channelEPG = epg[channelName] || [];

    let current = null;
    let next = null;

    for (let i = 0; i < channelEPG.length; i++) {
        const prog = channelEPG[i];
        const start = dayjs(prog.start, 'YYYYMMDDHHmmss Z');
        const stop = dayjs(prog.stop, 'YYYYMMDDHHmmss Z');

        if (now.isAfter(start) && now.isBefore(stop)) {
            current = prog;
            next = channelEPG[i + 1] || null;
            break;
        }
    }

    return { current, next };
}

// === ADDON BUILDER ===
const builder = new addonBuilder({
    id: ADDON_ID,
    version: '1.0.0',
    name: ADDON_NAME,
    description: 'Streams IPTV with EPG support',
    catalogs: [{
        type: 'tv',
        id: 'iptv_catalog',
        name: 'Live TV',
        extra: [{ name: 'search' }, { name: 'genre' }]
    }],
    resources: ['catalog', 'stream', 'meta'],
    types: ['tv']
});

builder.defineCatalogHandler(({ extra }) => {
    let filtered = channels;
    if (extra.genre) {
        filtered = channels.filter(ch => ch.group === extra.genre);
    }

    const metas = filtered.map(ch => {
        const { current, next } = getNowNext(ch.name);
        return {
            id: ch.id,
            type: 'tv',
            name: ch.name,
            poster: ch.logo,
            background: ch.logo,
            description: current ? `Now: ${current.title} - Next: ${next?.title || 'N/A'}` : 'Live Channel',
            genres: [ch.group]
        };
    });

    return Promise.resolve({ metas });
});

builder.defineStreamHandler(({ id }) => {
    const channel = channels.find(ch => ch.id === id);
    if (!channel) return Promise.resolve({ streams: [] });

    const streamUrl = `${PROXY_PREFIX}${encodeURIComponent(channel.url)}`;

    return Promise.resolve({
        streams: [{
            title: channel.name,
            url: streamUrl
        }]
    });
});

builder.defineMetaHandler(({ id }) => {
    const channel = channels.find(ch => ch.id === id);
    if (!channel) return Promise.resolve({ meta: {} });

    const { current, next } = getNowNext(channel.name);

    return Promise.resolve({
        meta: {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            poster: channel.logo,
            description: current ? `Now: ${current.title} - Next: ${next?.title || 'N/A'}` : 'Live Channel',
            genres: [channel.group]
        }
    });
});

// === EXPRESS ROUTING ===
app.use(builder.getInterface());

app.use(PROXY_PREFIX, (req, res, next) => {
    const target = decodeURIComponent(req.path.slice(1));
    return createProxyMiddleware({
        target,
        changeOrigin: true,
        secure: false,
        headers: {
            referer: target,
            origin: target
        }
    })(req, res, next);
});

// === START ===
(async () => {
    await loadM3U();
    await loadEPG();

    const port = process.env.PORT || 7000;
    app.listen(port, () => {
        console.log(`Addon running on port ${port}`);
    });
})();
