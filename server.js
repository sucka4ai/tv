require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { parse } = require('iptv-playlist-parser');
const { parseStringPromise } = require('xml2js');
const { serveHTTP } = require('@stremio/sdk');
const dayjs = require('dayjs');

const app = express();
const PORT = process.env.PORT || 7000;

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let playlistItems = [];
let epgData = {};
let categories = new Set();

// --- Fetch M3U Playlist ---
async function fetchPlaylist() {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const { items } = parse(text);
    playlistItems = items.map((item, index) => {
        const name = item.name || `Channel ${index}`;
        const group = item.group.title || 'Uncategorized';
        categories.add(group);
        return {
            id: `channel_${index}`,
            name,
            group,
            url: item.url,
            logo: item.tvg.logo || null,
            epgId: item.tvg.id || null,
        };
    });
}

// --- Fetch and Parse EPG ---
async function fetchEPG() {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await parseStringPromise(xml);
    epgData = {};

    if (result.tv && result.tv.programme) {
        result.tv.programme.forEach(prog => {
            const channel = prog.$.channel;
            const start = dayjs(prog.$.start, 'YYYYMMDDHHmmss Z');
            const stop = dayjs(prog.$.stop, 'YYYYMMDDHHmmss Z');
            const title = prog.title?.[0] || 'Unknown';

            if (!epgData[channel]) epgData[channel] = [];
            epgData[channel].push({ start, stop, title });
        });
    }
}

// --- Get Now/Next Title for a channel ---
function getNowNext(epgId) {
    const now = dayjs();
    const progs = epgData[epgId] || [];
    const current = progs.find(p => now.isAfter(p.start) && now.isBefore(p.stop));
    return current ? current.title : '';
}

// --- Stremio SDK Setup ---
const manifest = {
    id: 'iptv.addon.m3u',
    version: '1.0.0',
    name: 'IPTV M3U Addon',
    description: 'Custom IPTV addon using M3U and EPG',
    types: ['tv'],
    catalogs: [
        {
            type: 'tv',
            id: 'iptv_catalog',
            name: 'IPTV Channels',
            extra: [
                { name: 'search', isRequired: false },
                {
                    name: 'genre',
                    options: Array.from(categories),
                    isRequired: false
                }
            ]
        }
    ],
    resources: ['catalog', 'stream', 'meta'],
    idPrefixes: ['channel_'],
    logo: 'https://upload.wikimedia.org/wikipedia/commons/0/0b/TV_icon_2.svg'
};

const builder = {
    async catalogHandler({ type, id, extra }) {
        if (type !== 'tv' || id !== 'iptv_catalog') return { metas: [] };

        const genre = extra.genre;
        const search = extra.search?.toLowerCase();

        const filtered = playlistItems.filter(item => {
            return (!genre || item.group === genre) &&
                   (!search || item.name.toLowerCase().includes(search));
        });

        const metas = filtered.map(item => ({
            id: item.id,
            type: 'tv',
            name: item.name,
            poster: item.logo,
            genres: [item.group]
        }));

        return { metas };
    },

    async metaHandler({ id }) {
        const channel = playlistItems.find(c => c.id === id);
        if (!channel) return { meta: null };

        return {
            meta: {
                id: channel.id,
                type: 'tv',
                name: channel.name,
                poster: channel.logo,
                description: `Category: ${channel.group}`
            }
        };
    },

    async streamHandler({ id }) {
        const channel = playlistItems.find(c => c.id === id);
        if (!channel) return { streams: [] };

        const title = getNowNext(channel.epgId);
        return {
            streams: [
                {
                    title: title ? `${title} - ${channel.name}` : channel.name,
                    url: channel.url
                }
            ]
        };
    }
};

async function startAddon() {
    await fetchPlaylist();
    await fetchEPG();

    const { getRouter } = await serveHTTP(builder, manifest);
    app.use('/', getRouter());

    app.get('/health', (req, res) => res.send('OK'));
    app.listen(PORT, () => {
        console.log(`IPTV Addon running at http://localhost:${PORT}`);
    });
}

startAddon().catch(console.error);
