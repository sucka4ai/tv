      const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const parser = require("iptv-playlist-parser");
const xml2js = require("xml2js");
const dayjs = require("dayjs");
const http = require("http");

// ---------------- CONFIG ----------------
const M3U_URL = process.env.M3U_URL;
const EPG_URL = process.env.EPG_URL;

let channels = [];
let epgData = {};
let categories = new Set();

// ---------------- FETCH FUNCTIONS ----------------
async function fetchM3U() {
  try {
    const res = await fetch(M3U_URL, { timeout: 15000 });
    const text = await res.text();
    const parsed = parser.parse(text);

    categories = new Set();
    channels = parsed.items.map((item, index) => {
      const category = item.group?.title || "Uncategorized";
      categories.add(category);
      return {
        id: `channel-${index}`,
        name: item.name,
        url: item.url,
        logo: item.tvg.logo,
        category,
        tvgId: item.tvg.id,
      };
    });

    console.log(`✅ Loaded ${channels.length} channels`);
  } catch (err) {
    console.error("❌ Failed to fetch M3U:", err.message);
  }
}

async function fetchEPG() {
  try {
    if (!EPG_URL) throw new Error("EPG_URL not provided");
    const res = await fetch(EPG_URL, { timeout: 15000 });
    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);

    const programs = result.tv.programme || [];
    epgData = {};

    for (const program of programs) {
      const channelId = program.$.channel;
      if (!epgData[channelId]) epgData[channelId] = [];

      epgData[channelId].push({
        start: program.$.start,
        stop: program.$.stop,
        title: program.title?.[0]?._ || "No Title",
        desc: program.desc?.[0]?._ || "",
      });
    }

    console.log(`✅ Loaded EPG with ${programs.length} programmes`);
  } catch (err) {
    console.warn("⚠️ Skipping EPG load:", err.message);
    epgData = {};
  }
}

// ---------------- HELPERS ----------------
function getNowNext(channelId) {
  const now = dayjs();
  const programs = epgData[channelId] || [];
  let nowProgram = null;
  let nextProgram = null;

  for (let i = 0; i < programs.length; i++) {
    const start = dayjs(programs[i].start, "YYYYMMDDHHmmss ZZ");
    const end = dayjs(programs[i].stop, "YYYYMMDDHHmmss ZZ");
    if (now.isAfter(start) && now.isBefore(end)) {
      nowProgram = programs[i];
      nextProgram = programs[i + 1] || null;
      break;
    }
  }

  return { now: nowProgram, next: nextProgram };
}

function getUnsplashImage(category) {
  const encoded = encodeURIComponent(category || "tv");
  return `https://source.unsplash.com/1600x900/?${encoded}`;
}

// ---------------- MANIFEST ----------------
const manifest = {
  id: "community.shannyiptv",
  version: "1.0.0",
  name: "Shanny IPTV",
  description: "IPTV with category filtering and EPG",
  logo: "https://upload.wikimedia.org/wikipedia/commons/9/99/TV_icon_2.svg",
  resources: ["catalog", "stream", "meta"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "shannyiptv",
      name: "Shanny IPTV",
      extra: [{ name: "genre", options: ["All"] }],
    },
  ],
  idPrefixes: ["channel-"],
};

// ---------------- ADDON BUILDER ----------------
const builder = new addonBuilder(manifest);

// ---------------- HANDLERS ----------------
builder.defineCatalogHandler(({ extra }) => {
  const genre = extra?.genre;
  const filtered =
    genre && genre !== "All"
      ? channels.filter((ch) => ch.category === genre)
      : channels;

  return Promise.resolve({
    metas: filtered.map((ch) => ({
      id: ch.id,
      type: "tv",
      name: ch.name,
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: `Live stream for ${ch.name}`,
    })),
  });
});

builder.defineMetaHandler(({ id }) => {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return Promise.resolve({ meta: {} });

  const epg = getNowNext(ch.tvgId);
  return Promise.resolve({
    meta: {
      id: ch.id,
      type: "tv",
      name: ch.name,
      logo: ch.logo,
      poster: ch.logo,
      background: getUnsplashImage(ch.category),
      description: `${epg.now?.title || "No EPG"} — ${
        epg.next?.title || "No info"
      }`,
    },
  });
});

builder.defineStreamHandler(({ id }) => {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return Promise.resolve({ streams: [] });

  return Promise.resolve({
    streams: [
      {
        url: ch.url,
        title: ch.name,
        externalUrl: true,
      },
    ],
  });
});

// ---------------- SERVER ----------------
(async () => {
  await fetchM3U();
  await fetchEPG();

  if (categories.size > 0) {
    manifest.catalogs[0].extra[0].options = [
      "All",
      ...Array.from(categories).sort(),
    ];
    console.log(
      "✅ Manifest categories updated:",
      manifest.catalogs[0].extra[0].options
    );
  }

  const PORT = process.env.PORT || 7000;

  // Use http.createServer to serve both manifest.json and addon interface
  const addonInterface = builder.getInterface();

  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0]; // ignore query strings

    if (path === "/manifest.json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(manifest));
    } else {
      addonInterface(req, res); // Stremio SDK handles the rest
    }
  });

  server.listen(PORT, () => {
    console.log(`🚀 Shanny IPTV Addon running on port ${PORT}`);
    console.log(`🔗 Manifest available at /manifest.json`);
  });
})();
