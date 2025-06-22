const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const { parse } = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");

const M3U_URL = "http://m3u4u.com/m3u/j67zn61w6guq5z8vyd1w"; 
const EPG_URL = "https://epg.pw/xmltv/epg_GB.xml"; 

let channels = [];
let epgData = {};

// Load playlist and EPG
async function loadData() {
  try {
    const m3uRes = await fetch(M3U_URL);
    const m3uText = await m3uRes.text();
    channels = parse(m3uText).items;

    const epgRes = await fetch(EPG_URL);
    const epgText = await epgRes.text();
    epgData = await xml2js.parseStringPromise(epgText);

    console.log(`Loaded ${channels.length} channels and EPG`);
  } catch (e) {
    console.error("Failed to load data", e);
  }
}

loadData();
setInterval(loadData, 15 * 60 * 1000); // refresh every 15 mins

const builder = new addonBuilder({
  id: "org.iptv.custom",
  version: "1.0.0",
  name: "Custom IPTV",
  description: "Live IPTV with M3U and EPG",
  types: ["tv"],
  resources: ["catalog", "stream", "meta"],
  catalogs: [
    {
      type: "tv",
      id: "iptv_catalog",
      name: "IPTV Live TV"
    }
  ]
});

// Catalog
builder.defineCatalogHandler(({ type, id }) => {
  if (type !== "tv" || id !== "iptv_catalog") return Promise.resolve({ metas: [] });

  const metas = channels.map((ch) => ({
    id: Buffer.from(ch.url).toString("base64"),
    type: "tv",
    name: ch.name || "Untitled",
    poster: ch.tvg.logo || null
  }));

  return Promise.resolve({ metas });
});

// Meta
builder.defineMetaHandler(({ id }) => {
  const url = Buffer.from(id, "base64").toString();
  const channel = channels.find((c) => c.url === url);
  if (!channel) return Promise.resolve({ meta: null });

  const meta = {
    id,
    type: "tv",
    name: channel.name,
    poster: channel.tvg.logo || null,
    description: `Live channel: ${channel.name}`
  };

  return Promise.resolve({ meta });
});

// Stream
builder.defineStreamHandler(({ id }) => {
  const url = Buffer.from(id, "base64").toString();
  const stream = channels.find((c) => c.url === url);
  if (!stream) return Promise.resolve({ streams: [] });

  return Promise.resolve({
    streams: [
      {
        title: stream.name,
        url: stream.url
      }
    ]
  });
});

module.exports = builder.getInterface();
