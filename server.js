const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const xml2js = require("xml2js");
const express = require("express");
const http = require("http");
const https = require("https");
const cors = require("cors");
const { URL } = require("url");

const app = express();
app.use(cors());

const manifest = {
    id: "community.iptvaddon",
    version: "1.0.0",
    name: "Custom IPTV Addon",
    description: "Streams IPTV channels with EPG and categories",
    resources: ["stream", "catalog", "meta"],
    types: ["tv"],
    idPrefixes: ["iptv_"],
    catalogs: [],
};

const IPTV_URL = "https://your-m3u-url.m3u"; // Replace with your actual M3U URL
const EPG_URL = "https://your-epg-url.xml";  // Replace with your actual EPG XML URL

let channels = [];
let epg = {};
let categories = new Set();

// Load and parse the M3U playlist
async function loadM3U() {
    try {
        const res = await axios.get(IPTV_URL);
        const lines = res.data.split("\n");
        let currentChannel = {};
        for (const line of lines) {
            if (line.startsWith("#EXTINF")) {
                const nameMatch = line.match(/,(.*)$/);
                const tvgIdMatch = line.match(/tvg-id="(.*?)"/);
                const groupMatch = line.match(/group-title="(.*?)"/);
                currentChannel = {
                    name: nameMatch ? nameMatch[1] : "Unknown",
                    tvg: tvgIdMatch ? tvgIdMatch[1] : "",
                    group: groupMatch ? groupMatch[1] : "Other",
                };
            } else if (line && !line.startsWith("#")) {
                currentChannel.url = line.trim();
                currentChannel.id = "iptv_" + Buffer.from(currentChannel.name).toString("base64");
                channels.push(currentChannel);
                categories.add(currentChannel.group);
            }
        }

        // Update manifest catalogs dynamically
        manifest.catalogs = Array.from(categories).map(group => ({
            type: "tv",
            id: `iptv_cat_${group}`,
            name: group,
        }));

        console.log(`Loaded ${channels.length} channels across ${categories.size} categories.`);
    } catch (err) {
        console.error("Error loading M3U:", err.message);
    }
}

// Load and parse the EPG XML
async function loadEPG() {
    try {
        const res = await axios.get(EPG_URL);
        const result = await xml2js.parseStringPromise(res.data);
        epg = {};
        for (const program of result.tv.programme) {
            const channel = program.$.channel;
            const start = new Date(program.$.start.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:00"));
            const stop = new Date(program.$.stop.slice(0, 14).replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:00"));
            const title = program.title ? program.title[0]._ || program.title[0] : "No title";
            const desc = program.desc ? program.desc[0]._ || program.desc[0] : "";
            if (!epg[channel]) epg[channel] = [];
            epg[channel].push({ start, stop, title, desc });
        }
        console.log(`Loaded EPG data for ${Object.keys(epg).length} channels.`);
    } catch (err) {
        console.error("Error loading EPG:", err.message);
    }
}

// Addon builder
const builder = new addonBuilder(manifest);

// Catalog handler
builder.defineCatalogHandler(({ id }) => {
    const group = id.replace("iptv_cat_", "");
    const metas = channels
        .filter(c => c.group === group)
        .map(c => ({
            id: c.id,
            type: "tv",
            name: c.name,
            poster: `https://picsum.photos/seed/${encodeURIComponent(c.name)}/200/300`,
        }));
    return Promise.resolve({ metas });
});

// Meta handler
builder.defineMetaHandler(({ id }) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return Promise.resolve({ meta: {} });

    const now = new Date();
    const epgData = epg[channel.tvg] || [];
    const currentProgram = epgData.find(p => now >= p.start && now <= p.stop);
    const nextProgram = epgData.find(p => now < p.start);

    const meta = {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: `https://picsum.photos/seed/${encodeURIComponent(channel.name)}/200/300`,
        description: currentProgram
            ? `Now: ${currentProgram.title} - ${currentProgram.desc || ""}`
            : "No EPG data available",
    };

    return Promise.resolve({ meta });
});

// Stream handler
builder.defineStreamHandler(({ id }) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return Promise.resolve({ streams: [] });

    const epgData = epg[channel.tvg] || [];
    const now = new Date();
    const current = epgData.find(p => now >= p.start && now <= p.stop);
    const next = epgData.find(p => now < p.start);

    const title = current ? `Now: ${current.title}` : "Live Stream";

    return Promise.resolve({
        streams: [
            {
                title: next ? `${title} → Next: ${next.title}` : title,
                url: `https://your-domain.com/proxy/${encodeURIComponent(channel.url)}`,
                behaviorHints: { notWebReady: false },
            },
        ],
    });
});

// Smart proxy handler for all devices
app.get("/proxy/*", (req, res) => {
    const target = decodeURIComponent(req.params[0]);
    if (!/^https?:\/\//.test(target)) return res.status(400).send("Invalid stream URL");

    try {
        const targetUrl = new URL(target);
        const httpLib = targetUrl.protocol === "https:" ? https : http;

        const proxyReq = httpLib.get(target, {
            headers: {
                "User-Agent": req.get("User-Agent") || "Mozilla/5.0",
                "Referer": target,
                "Origin": targetUrl.origin,
                "Accept": "*/*",
            },
        }, proxyRes => {
            res.writeHead(proxyRes.statusCode || 200, {
                ...proxyRes.headers,
                "Access-Control-Allow-Origin": "*",
                "Content-Disposition": "inline",
            });
            proxyRes.pipe(res);
        });

        proxyReq.on("error", err => {
            console.error("Stream proxy error:", err.message);
            res.status(500).send("Proxy stream failed");
        });
    } catch (err) {
        console.error("Bad proxy URL:", err.message);
        res.status(400).send("Bad stream URL");
    }
});

// Mount addon
const addonInterface = builder.getInterface();
app.get("/manifest.json", (_, res) => res.json(addonInterface.manifest));
app.get("/catalog/:type/:id/:extra?.json", (req, res) => addonInterface.catalog(req, res));
app.get("/meta/:type/:id.json", (req, res) => addonInterface.meta(req, res));
app.get("/stream/:type/:id.json", (req, res) => addonInterface.stream(req, res));

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, async () => {
    await loadM3U();
    await loadEPG();
    console.log(`IPTV addon running at http://localhost:${PORT}`);
});
