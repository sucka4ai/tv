// server.js
const { serveHTTP, addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const parser = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};

async function fetchPlaylist() {
  const res = await fetch(M3U_URL);
  const m3u = await res.text();
  const parsed = parser.parse(m3u);
  channels = parsed.items;
}

async function fetchEPG() {
  const res = await fetch(EPG_URL);
  const xml = await res.text();
  const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true });
  epgData = {};
  for (const prog of result.tv.programme) {
    const channel = prog.channel[0];
    if (!epgData[channel]) epgData[channel] = [];
    epgData[channel].push({
      title: prog.title?.[0]?._ || "",
      start: prog.start[0],
      stop: prog.stop[0]
    });
  }
}

function getNowNext(channelId) {
  const now = dayjs();
  const entries = epgData[channelId] || [];
  for (let i = 0; i < entries.length; i++) {
    const start = dayjs(entries[i].start, "YYYYMMDDHHmmss Z");
    const stop = dayjs(entries[i].stop, "YYYYMMDDHHmmss Z");
    if (now.isAfter(start) && now.isBefore(stop)) {
      return {
        now: entries[i].title,
        next: entries[i + 1]?.title || ""
      };
    }
  }
  return { now: "", next: "" };
}

function getBackground(category) {
  const keywords = encodeURIComponent(category.toLowerCase());
  const hash = Buffer.from(category).toString("hex").slice(0, 6);
  return `https://source.unsplash.com/featured/?${keywords}&sig=${hash}`;
}

function buildAddon() {
  const builder = new addonBuilder({
    id: "org.custom.iptv",
    version: "1.0.0",
    name: "IPTV Addon",
    description: "Live TV channels with EPG support",
    logo: "https://upload.wikimedia.org/wikipedia/commons/7/75/TV_icon_3.svg",
    catalogs: [],
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    idPrefixes: ["iptv"]
  });

  const categories = Array.from(new Set(channels.map(c => c.group?.title || "Other")));

  // Add "All Channels" category
  categories.unshift("All Channels");

  builder.defineCatalogHandler(({ id }) => {
    const filtered = id === "All Channels" ? channels : channels.filter(c => c.group?.title === id);
    return Promise.resolve({ metas: filtered.map(channel => {
      const epg = getNowNext(channel.tvg.id);
      return {
        id: `iptv_${Buffer.from(channel.name).toString("base64")}`,
        type: "tv",
        name: channel.name,
        poster: channel.tvg.logo || "",
        description: `Now: ${epg.now} | Next: ${epg.next}`,
        background: getBackground(id)
      };
    }) });
  });

  builder.defineMetaHandler(({ id }) => {
    const name = Buffer.from(id.split("_")[1], "base64").toString();
    const channel = channels.find(c => c.name === name);
    const epg = getNowNext(channel.tvg.id);
    return Promise.resolve({ meta: {
      id,
      type: "tv",
      name: channel.name,
      poster: channel.tvg.logo || "",
      background: getBackground(channel.group?.title || "Other"),
      description: `Now: ${epg.now} | Next: ${epg.next}`
    } });
  });

  builder.defineStreamHandler(({ id }) => {
    const name = Buffer.from(id.split("_")[1], "base64").toString();
    const channel = channels.find(c => c.name === name);
    return Promise.resolve({ streams: [
      { title: channel.name, url: channel.url }
    ] });
  });

  for (const cat of categories) {
    builder.manifest.catalogs.push({
      type: "tv",
      id: cat,
      name: cat
    });
  }

  return builder.getInterface();
}

async function startAddon() {
  await fetchPlaylist();
  await fetchEPG();
  const addonInterface = buildAddon();
  serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
}

startAddon();
