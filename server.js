const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};
let categories = new Set();

async function fetchM3U() {
    if (!M3U_URL || !M3U_URL.startsWith('http')) throw new Error('Invalid M3U_URL');

    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);

    channels = parsed.items
        .filter(item => item.url && item.url.includes('.m3u8')) // ensure .m3u8
        .map((item, index) => {
            const category = item.group?.title || 'Uncategorized';
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
    if (!EPG_URL || !EPG_URL.startsWith('http')) return;

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
    } catch (e) {
        console.warn('⚠️ Failed to load EPG:', e.message);
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
    await fetchM3U(); // fetch channels immediately
    fetchEPG(); // fetch EPG in background

    const manifest = {
        id: 'community.shannyiptv',
        version: '1.0.0',
        name: 'Shanny IPTV',
        description: 'Watch IPTV channels by category with EPG support',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg',
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv'],
        catalogs: [
            {
                type: 'tv',
                id: 'shannyiptv',
                name: 'Shanny IPTV',
                extra: [{ name: 'genre', options: [...categories], isRequired: false }]
            }
        ],
        idPrefixes: ['channel-']
    };

    const builder = new addonBuilder(manifest);

    builder.defineCatalogHandler(({ type, id, extra }) => {
        if (type !== 'tv' || id !== 'shannyiptv') return Promise.resolve({ metas: [] });

        const genre = extra?.genre;
        const filtered = genre
            ? channels.filter(c => c.category === genre)
            : channels;

        const metas = filtered.map(c => ({
            id: c.id,
            type: 'tv',
            name: c.name,
            poster: c.logo,
            background: getUnsplashImage(c.category),
            description: `Live stream for ${c.name}`
        }));

        return Promise.resolve({ metas });
    });

    builder.defineMetaHandler(({ id }) => {
        const channel = channels.find(c => c.id === id);
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
        const channel = channels.find(c => c.id === id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [
                {
                    url: channel.url,
                    title: channel.name,
                    externalUrl: true // avoid proxying
                }
            ]
        });
    });

    return builder.getInterface();
}

buildAddon().then(addon => {
    serveHTTP(addon, { port: process.env.PORT || 7000 });
    console.log('✅ IPTV Addon running...');
}).catch(err => {
    console.error('❌ Error starting addon:', err);
});
