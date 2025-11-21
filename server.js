const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const iptvParser = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const M3U_URL = process.env.M3U_URL || null;
const EPG_URL = process.env.EPG_URL || null;

// ❗ DO NOT EXIT — allow addon to run even with missing URLs
if (!M3U_URL) console.warn("⚠️ WARNING: M3U_URL is NOT set. No live channels will load.");
if (!EPG_URL) console.warn("⚠️ WARNING: EPG_URL is NOT set. No EPG data will load.");

const manifest = {
  id: "org.example.iptv",
  version: "1.0.0",
  name: "Custom IPTV Addon",
  description: "IPTV addon with M3U and EPG support",
  resources: ["catalog", "stream", "meta"],
  types: ["tv"],
  idPrefixes: ["iptv"],
  catalogs: [
    {
      id: "iptv-catalog",
      name: "All IPTV Channels",
      type: "tv"
    }
  ]
};

const builder = new addonBuilder(manifest);

let channels = [];
let epgData = {};

async function loadChannels() {
  if (!M3U_URL) {
    console.warn("⚠️ Skipping channel load — M3U_URL not provided.");
    channels = [];
    return;
  }

  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    channels = iptvParser.parse(text).items || [];
    console.log(`✅ Loaded ${channels.length} channels`);
  } catch (e) {
    console.error("❌ Failed to load or parse M3U:", e.message);
    channels = [];
  }
}

async function loadEPG() {
  if (!EPG_URL) {
    console.warn("⚠️ Skipping EPG load — EPG_URL not provided.");
    epgData = {};
    return;
  }

  try {
    const res = await fetch(EPG_URL);
    const text = await res.text();
    const result = await xml2js.parseStringPromise(text);
    epgData = result || {};
    console.log("✅ EPG loaded");
  } catch (e) {
    console.error("❌ Failed to load or parse EPG XML:", e.message);
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

// ----------------------
// CATALOG HANDLER
// ----------------------
builder.defineCatalogHandler(async () => {

  // If no M3U_URL set → return empty safe catalog
  if (!channels.length) {
    return { metas: [] };
  }

  return {
    metas: channels.map(channel => ({
      id: `iptv:${channel.tvgId || channel.name}`,
      type: "tv",
      name: channel.name,
      poster: channel.tvgLogo || undefined,
      posterShape: "default",
      description: channel.name,
    })),
  };
});

// ----------------------
// META HANDLER
// ----------------------
builder.defineMetaHandler(async ({ id }) => {

  if (!id.startsWith("iptv:")) return null;

  const channelId = id.replace("iptv:", "");
  const channel = channels.find(c => (c.tvgId || c.name) === channelId);

  if (!channel) {
    return { meta: { id, type: "tv", name: "Unknown Channel" } };
  }

  const epgChannel = findChannelEPG(channel.tvgId || channel.name);

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

// ----------------------
// STREAM HANDLER
// ----------------------
builder.defineStreamHandler(async ({ id }) => {

  if (!id.startsWith("iptv:")) return { streams: [] };

  const channelId = id.replace("iptv:", "");
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

// ----------------------
// RUN SERVER SAFELY
// ----------------------
serveHTTP(addonInterface, {
  port: process.env.PORT || 7000,
});

console.log(`🚀 IPTV Addon running on port ${process.env.PORT || 7000}`);
