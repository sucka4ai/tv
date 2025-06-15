const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const M3U_URL = process.env.M3U_URL;

// Simple manifest
const manifest = {
    id: 'com.iptv.addon',
    version: '1.0.0',
    name: 'My IPTV Addon',
    description: 'Personal IPTV channels for Stremio',
    resources: ['catalog', 'stream'],
    types: ['tv', 'channel'],
    catalogs: [{
        type: 'channel',
        id: 'iptv_channels',
        name: 'IPTV Channels'
    }],
    idPrefixes: ['iptv:']
};

// Cache for channels
let channelsCache = [];
let lastUpdate = 0;

// Parse M3U function
async function parseM3U() {
    if (!M3U_URL) {
        console.error('M3U_URL environment variable not set');
        return [];
    }

    try {
        console.log('Fetching M3U playlist...');
        const response = await fetch(M3U_URL);
        const content = await response.text();
        
        const channels = [];
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const nextLine = lines[i + 1];
                if (nextLine && !nextLine.startsWith('#')) {
                    // Extract channel name
                    const nameMatch = line.match(/,(.+)$/);
                    const channelName = nameMatch ? nameMatch[1].trim() : `Channel ${channels.length + 1}`;
                    
                    // Extract logo if available
                    const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                    const logo = logoMatch ? logoMatch[1] : null;
                    
                    // Extract group
                    const groupMatch = line.match(/group-title="([^"]+)"/);
                    const group = groupMatch ? groupMatch[1] : 'General';
                    
                    channels.push({
                        id: `iptv:${encodeURIComponent(channelName)}`,
                        name: channelName,
                        poster: logo,
                        background: logo,
                        description: `IPTV Channel - ${group}`,
                        genre: [group],
                        url: nextLine.trim()
                    });
                }
            }
        }
        
        console.log(`Found ${channels.length} channels`);
        return channels;
    } catch (error) {
        console.error('Error parsing M3U:', error);
        return [];
    }
}

// Get channels with caching
async function getChannels() {
    const now = Date.now();
    if (channelsCache.length === 0 || (now - lastUpdate) > 1800000) { // 30 minutes
        channelsCache = await parseM3U();
        lastUpdate = now;
    }
    return channelsCache;
}

// Routes
app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    if (req.params.type === 'channel' && req.params.id === 'iptv_channels') {
        const channels = await getChannels();
        const metas = channels.map(channel => ({
            id: channel.id,
            type: 'channel',
            name: channel.name,
            poster: channel.poster,
            background: channel.background,
            description: channel.description,
            genre: channel.genre
        }));
        
        res.json({ metas });
    } else {
        res.json({ metas: [] });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    if (req.params.type === 'channel' && req.params.id.startsWith('iptv:')) {
        const channels = await getChannels();
        const channel = channels.find(ch => ch.id === req.params.id);
        
        if (channel) {
            res.json({
                streams: [{
                    title: channel.name,
                    url: channel.url
                }]
            });
        } else {
            res.json({ streams: [] });
        }
    } else {
        res.json({ streams: [] });
    }
});

// Health check
app.get('/health', async (req, res) => {
    const channels = await getChannels();
    res.json({
        status: 'OK',
        channels: channels.length,
        hasM3U: !!M3U_URL,
        lastUpdate: new Date(lastUpdate).toISOString()
    });
});

// Root route
app.get('/', (req, res) => {
    res.json({
        name: 'IPTV Stremio Addon',
        version: '1.0.0',
        description: 'Add /manifest.json to install in Stremio'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
    
    if (!M3U_URL) {
        console.log('⚠️  WARNING: M3U_URL environment variable not set!');
        console.log('Please add your M3U playlist URL in the environment variables.');
    }
});
