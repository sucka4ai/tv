const express = require('express');
const fetch = require('node-fetch');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const xml2js = require('xml2js');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
const PORT = process.env.PORT || 7000;

// Configuration
const M3U_URL = process.env.M3U_URL || 'https://iptv-org.github.io/iptv/index.m3u';
const EPG_URL = process.env.EPG_URL || 'https://epg.pw/xmltv/epg_GB.xml';
const PROXY_URL = process.env.PROXY_URL || null;

let channels = [];
let epg = [];

// Helper: create proxy agent (IPv4 enforced)
const createProxyAgent = () => {
    const agentOptions = { family: 4 };
    if (PROXY_URL && PROXY_URL.startsWith('socks')) {
        return new SocksProxyAgent(PROXY_URL, agentOptions);
    } else if (PROXY_URL) {
        return new HttpProxyAgent(PROXY_URL, agentOptions);
    }
    return null;
};

// Parse M3U playlist
const parseM3U = async () => {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const lines = text.split('\n');
    let current = {};
    channels = [];
    for (let line of lines) {
        if (line.startsWith('#EXTINF')) {
            const match = line.match(/tvg-id="([^"]+)"|tvg-name="([^"]+)"|,(.*)/);
            if (match) {
                current = {
                    id: match[1] || match[2] || match[3].trim().replace(/\s+/g, '_').toLowerCase(),
                    name: match[3] || 'Unknown',
                };
            }
        } else if (line && current.name) {
            current.url = line.trim();
            channels.push({ ...current });
            current = {};
        }
    }
};

// Parse XMLTV EPG
const parseEPG = async () => {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);
    epg = result.tv && result.tv.programme ? result.tv.programme : [];
};

// Proxy endpoint
app.get('/proxy', async (req, res) => {
    try {
        const streamUrl = req.query.url;
        if (!streamUrl) return res.status(400).send('Missing URL');

        const headers = {};
        if (req.headers.range) headers.Range = req.headers.range;

        const agent = createProxyAgent();
        const response = await fetch(streamUrl, { headers, agent });

        res.status(response.status);
        response.headers.forEach((val, key) => {
            if (!['connection', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, val);
            }
        });
        response.body.pipe(res);
    } catch (err) {
        res.status(500).send('Proxy error');
    }
});

// Diagnostics
app.get('/diagnostics', (req, res) => {
    res.json({
        totalChannels: channels.length,
        epgEntries: epg.length,
        proxyEnabled: !!PROXY_URL,
        ipv4Forced: true
    });
});

// Stremio Addon Manifest
const manifest = {
    id: 'community.iptv.addon',
    version: '1.0.0',
    name: 'Custom IPTV Addon',
    description: 'Streams live IPTV channels with EPG and proxy support',
    types: ['tv'],
    catalogs: [{
        type: 'tv',
        id: 'iptv_catalog',
        name: 'IPTV Channels'
    }],
    resources: ['stream', 'catalog'],
    idPrefixes: ['iptv_'],
};

const builder = new addonBuilder(manifest);

// Catalog
builder.defineCatalogHandler(() => ({
    metas: channels.map(c => ({
        id: 'iptv_' + c.id,
        type: 'tv',
        name: c.name,
        poster: 'https://dummyimage.com/600x400/000/fff&text=' + encodeURIComponent(c.name)
    }))
}));

// Streams
builder.defineStreamHandler(({ id }) => {
    const channelId = id.replace('iptv_', '');
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return { streams: [] };

    return {
        streams: [{
            title: ch.name,
            url: PROXY_URL ? `/proxy?url=${encodeURIComponent(ch.url)}` : ch.url,
            behaviorHints: {
                notWebReady: false,
                bufferSize: 256 * 1024,
                http: {
                    hlsLiveEdge: { max: 1 },
                    streaming: { aggressive: false }
                }
            }
        }]
    };
});

// Manifest + Routes
app.get('/manifest.json', (req, res) => {
    res.json(builder.getInterface().getManifest());
});

app.get('/catalog/:type/:id/:extra?.json', (req, res) => {
    builder.getInterface().get(req).then(resp => res.json(resp)).catch(e => res.status(500).send(e.message));
});

app.get('/stream/:type/:id/:extra?.json', (req, res) => {
    builder.getInterface().get(req).then(resp => res.json(resp)).catch(e => res.status(500).send(e.message));
});

// Start
(async () => {
    await parseM3U();
    await parseEPG();
    app.listen(PORT, () => {
        console.log('IPTV Addon running on port', PORT);
    });
})();
