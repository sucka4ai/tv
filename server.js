const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch');
const parser = require('iptv-playlist-parser');
const xml2js = require('xml2js');
const dayjs = require('dayjs');

const M3U_URL = 'http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w';
const EPG_URL = 'https://epg.pw/xmltv/epg_GB.xml';
const ADDON_NAME = 'Shanny IPTV';
const LOGO_URL = 'https://upload.wikimedia.org/wikipedia/commons/e/e7/TV_icon_2.svg';

let playlist = [];
let categories = {};
let epg = {};

async function fetchPlaylist() {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parser.parse(text);
    playlist = parsed.items;

    categories = {};
    playlist.forEach(item => {
        const group = item.group || 'Other';
        if (!categories[group]) categories[group] = [];
        categories[group].push(item);
    });
}

async function fetchEPG() {
    try {
        const res = await fetch(EPG_URL);
        const xml = await res.text();
        const result = await xml2js.parseStringPromise(xml);
        result.tv.programme.forEach(prog => {
            const channelId = prog.$.channel;
            const start = dayjs(prog.$.start, 'YYYYMMDDHHmmss Z');
            const stop = dayjs(prog.$.stop, 'YYYYMMDDHHmmss Z');
            const now = dayjs();

            if (!epg[channelId]) epg[channelId] = {};

            if (now.isAfter(start) && now.isBefore(stop)) {
                epg[channelId] = {
                    title: prog.title?.[0] || '',
                    desc: prog.desc?.[0] || ''
                };
            }
        });
    } catch (err) {
        console.error('Failed to load EPG:', err.message);
    }
}

(async () => {
    try {
        await fetchPlaylist();
        await fetchEPG();

        const catalogList = Object.keys(categories).map(cat => ({
            type: 'tv',
            id: `shanny_${cat}`,
            name: cat
        }));

        const builder = new addonBuilder({
            id: 'org.shanny.iptv',
            version: '1.0.0',
            name: ADDON_NAME,
            description: 'IPTV with dynamic categories and EPG',
            logo: LOGO_URL,
            catalogs: catalogList,
            resources: ['catalog', 'stream', 'meta'],
            types: ['tv'],
            idPrefixes: ['shanny'],
            behaviorHints: {
                configurable: false,
                configurationRequired: false
            }
        });

        builder.defineCatalogHandler(({ id }) => {
            const cat = id.replace('shanny_', '');
            const items = categories[cat] || [];

            return Promise.resolve({
                metas: items.map((item, index) => ({
                    id: `shanny_${cat}_${index}`,
                    type: 'tv',
                    name: item.name,
                    logo: item.tvg.logo || LOGO_URL,
                    poster: item.tvg.logo || LOGO_URL,
                    description: item.tvg.name || 'Live TV',
                }))
            });
        });

        builder.defineStreamHandler(({ id }) => {
            const parts = id.split('_');
            const cat = parts[1];
            const index = parseInt(parts[2]);
            const channel = categories[cat]?.[index];

            if (!channel || !channel.url) {
                return Promise.resolve({ streams: [] });
            }

            return Promise.resolve({
                streams: [{
                    title: epg[channel.tvg.id]?.title
                        ? `${epg[channel.tvg.id].title} - ${epg[channel.tvg.id].desc}`
                        : channel.name,
                    url: channel.url,
                    externalUrl: true
                }]
            });
        });

        builder.defineMetaHandler(({ id }) => {
            const parts = id.split('_');
            const cat = parts[1];
            const index = parseInt(parts[2]);
            const channel = categories[cat]?.[index];

            if (!channel) return Promise.resolve({ meta: {} });

            return Promise.resolve({
                meta: {
                    id,
                    type: 'tv',
                    name: channel.name,
                    poster: channel.tvg.logo || LOGO_URL,
                    description: channel.tvg.name || 'Live TV Channel',
                }
            });
        });

        const PORT = process.env.PORT || 3000;
        require('http')
            .createServer((req, res) => builder.getInterface().handle(req, res))
            .listen(PORT, () => {
                console.log(`✅ Shanny IPTV Addon running on port ${PORT}`);
            });

    } catch (err) {
        console.error('Error initializing addon:', err.message);
    }
})();
