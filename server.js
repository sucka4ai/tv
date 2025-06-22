// server.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { parse } = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const { addonBuilder } = require("stremio-addon-sdk");
const { createProxyMiddleware } = require("http-proxy-middleware");
const dayjs = require("dayjs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

let channels = [];
let categories = new Set();
let epgData = {};

const M3U_URL = "https://iptv-org.github.io/iptv/countries/gb.m3u";
const EPG_URL = "https://iptv-org.github.io/epg/guides/gb.xml";

// Proxy Setup
app.use("/proxy", createProxyMiddleware({
  target: "http://example.com", // dummy target, gets replaced dynamically
  changeOrigin: true,
  pathRewrite: (path, req) => {
    const url = new URL(req.url.replace(/^\/proxy\//, ""));
    req.url = url.pathname + url.search;
    return req.url;
  },
  router: (req) => {
    const url = req.url.replace(/^\/proxy\//, "");
    return decodeURIComponent(url).split("/")[0] + "//" + decodeURIComponent(url).split("/").slice(2).join("/");
  },
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader("User-Agent", "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko)");
    proxyReq.setHeader("Referer", req.url);
    proxyReq.setHeader("Origin", req.get("origin") || "https://www.strem.io");
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] || "";
    if (!/^video|application/.test(contentType)) {
      console.warn(`⚠️ Unexpected content-type: ${contentType}`);
    }
    res.setHeader("Content-Type", contentType);
  },
  secure: false,
  logLevel: "silent",
}));

const manifest = {
  id: "org.stremio.iptvaddon",
  version: "1.0.0",
  name: "Custom IPTV",
  description: "Streams live TV using M3U and EPG.",
  resources: ["catalog", "stream", "meta"],
  types: ["tv"],
  catalogs: [{
    type: "tv",
    id: "iptv_catalog",
    name: "IPTV Channels",
    extra: [{ name: "genre", isRequired: false }],
  }],
  idPrefixes: ["iptv_"],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(({ type, extra }) => {
  if (type !== "tv") return { metas: [] };
  const genre = extra.genre;
  const metas = channels
    .filter((c) => !genre || (c.groupTitle && c.groupTitle === genre))
    .map((c) => ({
      id: `iptv_${c.id}`,
      type: "tv",
      name: c.name,
      poster: c.logo,
      description: `Live channel: ${c.name}`,
      genre: [c.groupTitle || "Other"],
    }));
  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ id }) => {
  const channel = channels.find((c) => `iptv_${c.id}` === id);
  if (!channel) return Promise.resolve({ meta: {} });
  return Promise.resolve({
    meta: {
      id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      description: `Live channel: ${channel.name}`,
      genre: [channel.groupTitle || "Other"],
    },
  });
});

builder.defineStreamHandler(({ id }) => {
  const channel = channels.find((c) => `iptv_${c.id}` === id);
  if (!channel) return Promise.resolve({ streams: [] });
  const protocol = "https"; // force HTTPS for TV compatibility
  const proxyUrl = `/proxy/${encodeURIComponent(channel.url)}`;
  const fullUrl = `${protocol}://${"your-addon-name.onrender.com"}${proxyUrl}`;

  const epg = epgData[channel.tvgId];
  const now = epg?.[0]?.title || "Live";
  const next = epg?.[1]?.title ? ` → ${epg[1].title}` : "";

  return Promise.resolve({
    streams: [{ title: now + next, url: fullUrl }],
  });
});

app.get("/test-stream/:id", (req, res) => {
  const index = parseInt(req.params.id, 10);
  const channel = channels[index];
  if (!channel) return res.status(404).send("Not found");
  res.send(`<video controls autoplay src="/proxy/${encodeURIComponent(channel.url)}" style="width:100%"></video>`);
});

app.get("/categories.json", (req, res) => {
  res.json(Array.from(categories));
});

app.get("/manifest.json", (_, res) => res.json(builder.getInterface().manifest));
app.get("/:resource/:type/:id\.json", (req, res) => {
  builder.getInterface().get(req, res);
});

const fetchM3U = async () => {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const parsed = parse(text);
    channels = parsed.items
      .filter((item) => /^https?:\/\/.*\.(m3u8|ts|mp4)/i.test(item.url))
      .map((item, index) => {
        if (item.group?.title) categories.add(item.group.title);
        return {
          id: index,
          name: item.name,
          url: item.url,
          logo: item.tvg?.logo || "https://www.stremio.com/press/stremio-logo-small.png",
          tvgId: item.tvg?.id,
          groupTitle: item.group?.title || "Other",
        };
      });
  } catch (err) {
    console.error("Failed to load M3U:", err);
  }
};

const fetchEPG = async () => {
  try {
    const res = await fetch(EPG_URL);
    const xml = await res.text();
    const parsed = await xml2js.parseStringPromise(xml);
    const now = dayjs();

    const channelsMap = {};
    for (const prog of parsed.tv.programme) {
      const start = dayjs(prog.$.start.slice(0, 14), "YYYYMMDDHHmmss");
      const stop = dayjs(prog.$.stop.slice(0, 14), "YYYYMMDDHHmmss");
      if (!prog.title || !prog.title[0]) continue;

      const epgItem = { title: prog.title[0], start, stop };
      const channelId = prog.$.channel;
      if (!channelsMap[channelId]) channelsMap[channelId] = [];
      if (now.isAfter(start) && now.isBefore(stop)) {
        channelsMap[channelId].unshift(epgItem);
      } else if (now.isBefore(start)) {
        channelsMap[channelId].push(epgItem);
      }
    }
    epgData = channelsMap;
  } catch (err) {
    console.error("Failed to load EPG:", err);
  }
};

(async () => {
  await fetchM3U();
  await fetchEPG();
  app.listen(PORT, () => console.log(`✅ Addon running on http://localhost:${PORT}`));
})();
