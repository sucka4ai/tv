const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const xml2js = require('xml2js');

const M3U_URL = 'YOUR_M3U_URL_HERE'; // Replace with your working M3U URL
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';

const app = express();
const port = process.env.PORT || 10000;

let channels = [];
let epgData = {};
let categories = new Set();

// Parse M3U
async function parseM3U(url) {
    const { data } = await axios.get(url);
    const lines = data.split('\n');
    let result = [];

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF')) {
            const infoLine = lines[i];
            const urlLine = lines[i + 1];

            const nameMatch = infoLine.match(/,(.*)$/);
            const tvgIdMatch = infoLine.match(/tvg-id="([^"]*)"/);
            const groupMatch = infoLine.match(/group-title="([^"]*)"/);

            const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
            const tvgId = tvgIdMatch ? tvgIdMatch[1].trim() : name;
            const group = groupMatch ? groupMatch[1].trim() : 'Other';

            categories.add(group);

            result.push({
                name,
                url: urlLine.trim(),
                tvgId,
                group
            });
        }
    }

    return result;
}

// Parse EPG XML
async function parseEPG(url) {
    const { data } = await axios.get(url);
    const parsed = await xml2js.parseStringPromise(data);
    const epg = {};

    if (parsed.tv && parsed.tv.programme) {
        for (const prog of parsed.tv.programme) {
            const channel = prog.$.channel;
            const start = new Date(prog.$.start.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5'));
            const stop = new Date(prog.$.stop.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5'));

            if (!epg[channel]) epg[channel] = [];

            epg[channel].push({
                title: prog.title ? prog.title[0] : '',
                start,
                stop
            });
        }
    }

    return epg;
}

// Get now/next EPG for a channel
function getNowNext(tvgId) {
    const now = new Date();
    const epgList = epgData[tvgId] || [];
    let current = '', next = '';

    for (let i = 0; i < epgList.length; i++) {
        const show = epgList[i];
        if (now >= show.start && now < show.stop) {
            current = show.title;
            next = epgList[i + 1] ? epgList[i + 1].title : '';
            break;
        }
    }

    return { current, next };
}

// Main builder
const builder = new addonBuilder({
    id: 'org.custom.iptv',
    version: '1.0.0',
    name: 'Custom IPTV Addon',
    description: 'Streams IPTV channels with EPG and category filtering',
    catalogs: [{
        type: 'tv',
        id: 'iptv',
        name: 'IPTV Channels',
        extra: [{ name: 'genre' }]
    }],
    resources: ['catalog', 'stream'],
    types: ['tv'],
    idPrefixes: ['iptv_']
});

// Catalog handler
builder.defineCatalogHandler(({ extra }) => {
    const genre = extra?.genre;
    const metas = channels
        .filter(c => !genre || c.group === genre)
        .map(c => ({
            id: 'iptv_' + encodeURIComponent(c.name),
            name: c.name,
            type: 'tv',
            genres: [c.group],
            poster: 'https://dummyimage.com/600x400/000/fff&text=' + encodeURIComponent(c.name),
        }));

    return Promise.resolve({ metas });
});

// Stream handler
builder.defineStreamHandler(({ id }) => {
    const name = decodeURIComponent(id.replace('iptv_', ''));
    const channel = channels.find(c => c.name === name);

    if (!channel) return { streams: [] };

    const epg = getNowNext(channel.tvgId);
    const title = epg.current ? `${channel.name} - Now: ${epg.current} | Next: ${epg.next}` : channel.name;

    return Promise.resolve({
        streams: [{
            title,
            url: channel.url
        }]
    });
});

// Load data and start server
async function start() {
    try {
        channels = await parseM3U(M3U_URL);
        epgData = await parseEPG(EPG_URL);
        console.log(`Loaded ${channels.length} channels with ${Object.keys(epgData).length} EPG entries.`);
    } catch (err) {
        console.error('Startup error:', err);
    }

    app.get('/manifest.json', (_, res) => {
        const manifest = builder.getInterface().getManifest();
        manifest.catalogs[0].genres = Array.from(categories);
        res.json(manifest);
    });

    app.use('/', builder.getInterface());
    app.listen(port, () => {
        console.log(`Addon server running on http://localhost:${port}`);
    });
}

start();
