const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const parser = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");
const { createProxyMiddleware } = require("http-proxy-middleware");
const express = require("express");
const cors = require("cors");

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

const app = express();
app.use(cors());

let channels = [];
let epgData = {};
let categories = new Set();

async function fetchPlaylist() {
  const res = await fetch(M3U_URL);
  const text = await res.text();
  const parsed = parser.parse(text);
  channels = parsed.items;
  categories = new Set(parsed.items.map(c => c.group.title).filter(Boolean));
}

async function fetchEPG() {
  const res = await fetch(EPG_URL);
  const xml = await res.text();
  const json = await xml2js.parseStringPromise(xml);
  epgData = json;
}

function getNowNext(channelId) {
  const now = dayjs();
  const programmes = epgData.tv.programme.filter(p => p.$.channel === channelId);
  const current = programmes.find(p => dayjs(p.$.start, "YYYYMMDDHHmmss Z") <= now && dayjs(p.$.stop, "YYYYMMDDHHmmss Z") >= now);
  const next = programmes.find(p => dayjs(p.$.start, "YYYYMMDDHHmmss Z") > now);
  return {
    now: current ? current.title[0] : "",
    next: next ? next.title[0] : ""
  };
}

function buildMeta(channel) {
  const { now, next } = getNowNext(channel.tvg.id);
  return {
    id: channel.tvg.id || channel.name,
    type: "tv",
    name: channel.name,
    description: `Now: ${now} | Next: ${next}`,
    logo: channel.tvg.logo || "",
  };
}

function buildStream(channel) {
  return {
    url: channel.url
  };
}

const manifest = {
  id: "org.iptv.customaddon",
  version: "1.0.0",
  name: "Custom IPTV Addon",
  description: "Streams IPTV channels with EPG",
  types: ["tv"],
  catalogs: [
    { type: "tv", id: "all", name: "All Channels" },
    ...[...categories].map(cat => ({ type: "tv", id: cat, name: cat }))
  ],
  resources: ["catalog", "stream", "meta"]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(({ type, id }) => {
  const filtered = id === "all" ? channels : channels.filter(c => c.group.title === id);
  const metas = filtered.map(buildMeta);
  return Promise.resolve({ metas });
});

builder.defineStreamHandler(({ type, id }) => {
  const channel = channels.find(c => (c.tvg.id === id || c.name === id));
  if (!channel) return Promise.resolve({ streams: [] });
  return Promise.resolve({ streams: [buildStream(channel)] });
});

builder.defineMetaHandler(({ type, id }) => {
  const channel = channels.find(c => (c.tvg.id === id || c.name === id));
  if (!channel) return Promise.resolve({ meta: {} });
  return Promise.resolve({ meta: buildMeta(channel) });
});

app.use("/addon.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(builder.getInterface()));
});

app.use("/", builder.getInterface().getRouter());

async function startAddon() {
  await fetchPlaylist();
  await fetchEPG();
  app.listen(process.env.PORT || 7000);
}

startAddon();
