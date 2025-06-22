// server.js
const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { parse } = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
app.use(cors());

const manifest = {
  id: "org.custom.iptv",
  version: "1.0.0",
  name: "Custom IPTV",
  description: "IPTV Addon with M3U and EPG support",
  types: ["tv"],
  catalogs: [{
    type: "tv",
    id: "iptv_catalog",
    name: "IPTV Channels",
    extra: [{ name: "search" }, { name: "genre" }]
  }],
  resources: ["catalog", "stream", "meta"],
  idPrefixes: ["iptv_"],
  logo: "https://stremio.com/website/stremio-logo-small.png",
  background: "https://stremio.com/website/stremio-bg.jpg"
};

const builder = new addonBuilder(manifest);

let channels = [];
let epg = {};

async function loadM3U(url) {
  const res = await fetch(url);
  const text = await res.text();
  const parsed = parse(text);
  channels = parsed.items.map((item, index) => ({
    id: `iptv_${index}`,
    name: item.name,
    url: item.url,
    logo: item.tvg.logo || "",
    group: item.group.title || "",
    epgId: item.tvg.id || ""
  }));
}

async function loadEPG(url) {
  const res = await fetch(url);
  const xml = await res.text();
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(xml);
  epg = {};
  if (result.tv && result.tv.programme) {
    result.tv.programme.forEach(program => {
      const channelId = program.$.channel;
      if (!epg[channelId]) epg[channelId] = [];
      epg[channelId].push({
        start: dayjs(program.$.start, "YYYYMMDDHHmmss Z"),
        stop: dayjs(program.$.stop, "YYYYMMDDHHmmss Z"),
        title: program.title?.[0]?._ || ""
      });
    });
  }
}

builder.defineCatalogHandler(({ type, id, extra }) => {
  if (type !== "tv" || id !== "iptv_catalog") return { metas: [] };

  let filtered = channels;
  if (extra?.genre) filtered = filtered.filter(c => c.group === extra.genre);
  if (extra?.search) filtered = filtered.filter(c => c.name.toLowerCase().includes(extra.search.toLowerCase()));

  return {
    metas: filtered.map(c => ({
      id: c.id,
      type: "tv",
      name: c.name,
      poster: c.logo,
      background: c.logo,
      genre: [c.group]
    }))
  };
});

builder.defineMetaHandler(({ type, id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ meta: {} });
  const now = dayjs();
  const epgData = epg[channel.epgId] || [];
  const current = epgData.find(e => now.isAfter(e.start) && now.isBefore(e.stop));

  return Promise.resolve({
    meta: {
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      background: channel.logo,
      genre: [channel.group],
      description: current ? `Now: ${current.title}` : "No current program info"
    }
  });
});

builder.defineStreamHandler(({ type, id }) => {
  const channel = channels.find(c => c.id === id);
  if (!channel) return Promise.resolve({ streams: [] });
  return Promise.resolve({
    streams: [
      {
        title: "Live Stream",
        url: `/proxy/${encodeURIComponent(channel.url)}`,
        behaviorHints: {
          notWebReady: false // ensures Smart TV compatibility
        }
      }
    ]
  });
});

// Local proxy endpoint to bypass CORS and Smart TV restrictions
app.use("/proxy/:url", (req, res, next) => {
  const targetUrl = decodeURIComponent(req.params.url);
  createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: false,
    selfHandleResponse: false,
    pathRewrite: () => ""
  })(req, res, next);
});

app.get("/manifest.json", (req, res) => {
  res.send(builder.getInterface().getManifest());
});

app.get("/", (req, res) => {
  res.send("IPTV Addon is running.");
});

const M3U_URL = "http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w"; // Replace with your URL
const EPG_URL = "https://epg.pw/xmltv/epg_GB.xml"; // Replace with your EPG

async function init() {
  await loadM3U(M3U_URL);
  await loadEPG(EPG_URL);
  app.use("/stremio/v1", builder.getInterface().getRouter());
  const port = process.env.PORT || 7000;
  app.listen(port, () => console.log(`Addon listening on port ${port}`));
}

init();
