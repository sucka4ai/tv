const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

// Get M3U URL from environment variable (Railway will provide this)
const M3U_URL = process.env.M3U_URL;
const ADDON_NAME = 'My IPTV Channels';
const ADDON_ID = 'com.myiptv.addon';
const PORT = process.env.PORT || 3000;

// Addon manifest
const manifest = {
    id: ADDON_ID,
    version: '1.0.0',
    name: ADDON_NAME,
    description: 'My personal IPTV addon',
    resources: ['catalog', 'stream'],
    types: ['tv', 'channel'],
    catalogs: [{
        type: 'channel',
        id: 'iptv_channels',
        name: 'IPTV Channels'
    }],
    idPrefixes: ['iptv:']
};

const addon = new addonBuilder(manifest);

// Parse M3U playlist
async function parseM3U(url) {
    try {
        const response = await fetch(url);
        const m3uContent = await response.text();
        
        const channels = [];
        const lines = m3uContent.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const nextLine = lines[i + 1];
                if (nextLine && !nextLine.startsWith('#')) {
                    const nameMatch = line.match(/,(.+)$/);
                    const logoMatch = line.match(/tvg-logo="([^"]+)"/);
                    const groupMatch = line.match(/group-title="([^"]+)"/);
                    
                    const channelName = nameMatch ? nameMatch[1].trim() : 'Unknown Channel';
                    const logo = logoMatch ? logoMatch[1] : null;
                    const group = groupMatch ? groupMatch[1] : 'General';
                    
                    channels.push({
                        id: `iptv:${encodeURIComponent(channelName)}`,
                        name: channelName,
                        poster: logo,
                        posterShape: 'square',
                        background: logo,
                        logo: logo,
                        description: `IPTV Channel - ${group}`,
                        genre: [group],
                        type: 'channel',
                        url: nextLine.trim()
                    });
                }
            }
        }
        
        return channels;
    } catch (error) {
        console.error('Error parsing M3U:', error);
        return [];
    }
}

// Cache for channels
let channelsCache = null;
let cacheTime = 0;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function getChannels() {
    const now = Date.now();
    
    if (!channelsCache || (now - cacheTime) > CACHE_DURATION) {
        console.log('Refreshing channels cache...');
        channelsCache = await parseM3U(M3U_URL);
        cacheTime = now;
    }
    
    return channelsCache;
}

// Catalog handler
addon.defineCatalogHandler(async (args) => {
    if (args.type === 'channel' && args.id === 'iptv_channels') {
        const channels = await getChannels();
        
        const skip = parseInt(args.extra.skip) || 0;
        const limit = 100;
        
        const paginatedChannels = channels.slice(skip, skip + limit);
        
        return {
            metas: paginatedChannels.map(channel => ({
                id: channel.id,
                type: 'channel',
                name: channel.name,
                poster: channel.poster,
                posterShape: 'square',
                background: channel.background,
                logo: channel.logo,
                description: channel.description,
                genre: channel.genre
            }))
        };
    }
    
    return { metas: [] };
});

// Stream handler
addon.defineStreamHandler(async (args) => {
    if (args.type === 'channel' && args.id.startsWith('iptv:')) {
        const channels = await getChannels();
        const channel = channels.find(ch => ch.id === args.id);
        
        if (channel) {
            return {
                streams: [{
                    title: channel.name,
                    url: channel.url,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: {},
                            response: {}
                        }
                    }
                }]
            };
        }
    }
    
    return { streams: [] };
});

// Create Express app
const app = express();
app.use(cors());

// Serve addon
app.use('/', addon.getInterface());

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        channels: channelsCache ? channelsCache.length : 0,
        hasM3U: !!M3U_URL 
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`IPTV Addon running on port ${PORT}`);
    if (!M3U_URL) {
        console.log('WARNING: M3U_URL environment variable not set!');
    }
});