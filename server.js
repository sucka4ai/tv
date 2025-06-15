const express = require('express');
const fetch = require('node-fetch');
const m3uParser = require('iptv-playlist-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL || 'https://your-playlist-url-here.m3u';

app.use(cors());

let channels = [];

// Fetch and parse M3U
async function loadM3U() {
    try {
        const res = await fetch(M3U_URL);
        const text = await res.text();
        const parsed = m3uParser.parse(text);
        channels = parsed.items.map((item, index) => ({
            id: `iptv:${index}`,
            name: item.name || `Channel ${index}`,
            description: item.tvg ? item.tvg.name : '',
            logo: item.tvg ? item.tvg.logo : '',
            url: item.url
        }));
        console.log(`Loaded ${channels.length} IPTV channels.`);
    } catch (err) {
        console.error('Failed to load M3U:', err);
    }
}

// Manifest
app.get('/manifest.json', (req, res) => {
    res.json({
        id: "com.iptv.addon",
        version: "1.0.0",
        name: "My IPTV Addon",
        description: "Personal IPTV channels for Stremio",
        logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/TV-icon-2.svg/1024px-TV-icon-2.svg.png",
        resources: ["catalog", "stream"],
        types: ["tv"],
        idPrefixes: ["iptv:"],
        catalogs: [{
            type: "tv",
            id: "iptv_channels",
            name: "IPTV Channels"
        }]
    });
});

// Catalog endpoint
app.get('/catalog/:type/:id.json', (req, res) => {
    if (req.params.type === 'tv' && req.params.id === 'iptv_channels') {
        const metas = channels.map(c => ({
            id: c.id,
            type: 'tv',
            name: c.name,
            poster: c.logo,
            description: c.description
        }));
        res.json({ metas });
    } else {
        res.status(404).send('Catalog not found');
    }
});

// Stream endpoint
app.get('/stream/:type/:id.json', (req, res) => {
    if (req.params.type === 'tv' && req.params.id.startsWith('iptv:')) {
        const index = parseInt(req.params.id.split(':')[1], 10);
        const channel = channels[index];
        if (channel) {
            res.json({
                streams: [{
                    title: channel.name,
                    url: channel.url
                }]
            });
        } else {
            res.status(404).send('Channel not found');
        }
    } else {
        res.status(404).send('Stream not found');
    }
});

// Start server and load M3U
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await loadM3U();
});
