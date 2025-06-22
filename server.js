const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const iptvParser = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

if (!M3U_URL || !EPG_URL) {
  console.error("ERROR: Please set M3U_URL and EPG_URL environment variables");
  process.exit(1);
}

const manifest = {
  id: "org.example.iptv",
  version: "1.0.0",
  name: "Custom IPTV Addon",
  description: "IPTV addon with M3U and EPG support",
  resources: ["catalog", "stream", "meta"],
  types: ["tv"],
  idPrefixes: ["iptv"],
  catalogExtra: [
    { id: "iptv-catalog", name: "All IPTV Channels" }
  ]
};

const builder = new addonBuilder(manifest);

let channels = [];
let epgData = {};

async function loadChannels() {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    channels = iptvParser.parse(text).items;
  } catch (e) {
    console.error("Failed to load or parse M3U:", e);
    channels = [];
  }
}

async function loadEPG() {
  try {
    const res = await fetch(EPG_URL);
    const text = await res.text();
    const result = await xml2js.parseStringPromise(text);
    epgData = result;
  } catch (e) {
    console.error("Failed to load or parse EPG XML:", e);
    epgData = {};
  }
}

function findChannelEPG(channelId) {
  if (!epgData.tv || !epgData.tv.channel) return null;
  return epgData.tv.channel.find(c => c.$.id === channelId);
}

function findProgramsForChannel(channelId) {
  if (!epgData.tv || !epgData.tv.programme) return [];
  return epgData.tv.programme.filter(p => p.$.channel === channelId);
}

// Load data on start
(async () => {
  await loadChannels();
  await loadEPG();
})();

// Refresh data every 10 minutes
setInterval(async () => {
  await loadChannels();
  await loadEPG();
}, 10 * 60 * 1000);

builder.defineCatalogHandler(async ({ id, extra, skip, limit }) => {
  // Return all channels as metas with IPTV prefix + channel id
  return {
    metas: channels.map(channel => ({
      id: `iptv:${channel.tvgId || channel.name}`, // unique id for meta
      type: "tv",
      name: channel.name,
      poster: channel.tvgLogo || undefined,
      posterShape: "default",
      releaseInfo: undefined,
      description: channel.name,
    })),
  };
});

builder.defineMetaHandler(async ({ id }) => {
  // id format: iptv:<channelId>
  if (!id.startsWith("iptv:")) return null;
  const channelId = id.slice(5);
  const channel = channels.find(c => (c.tvgId || c.name) === channelId);
  if (!channel) return null;

  // Find EPG channel info (optional)
  const epgChannel = findChannelEPG(channel.tvgId || channel.name);

  // Add EPG details if available
  return {
    meta: {
      id,
      type: "tv",
      name: channel.name,
      description: channel.name,
      poster: channel.tvgLogo,
      releaseInfo: epgChannel ? epgChannel["display-name"]?.[0] : undefined,
    },
  };
});

builder.defineStreamHandler(async ({ id }) => {
  if (!id.startsWith("iptv:")) return { streams: [] };
  const channelId = id.slice(5);
  const channel = channels.find(c => (c.tvgId || c.name) === channelId);
  if (!channel) return { streams: [] };

  return {
    streams: [
      {
        title: channel.name,
        url: channel.url,
        description: channel.name,
        subtitles: [],
        isFree: true,
      },
    ],
  };
});

const addonInterface = builder.getInterface();

serveHTTP(addonInterface, {
  port: process.env.PORT || 7000,
});
