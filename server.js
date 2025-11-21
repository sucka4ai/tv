const express = require("express");
const { addonBuilder } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 10000;
const app = express();

// -------------------------------------------------------------------
// MANIFEST
// -------------------------------------------------------------------
const manifest = {
  id: "shanny-iptv-addon",
  version: "1.0.0",
  name: "Shanny IPTV",
  description: "IPTV addon with category filters and EPG",
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "shanny_catalog",
      name: "Shanny IPTV",
      extra: [{ name: "genre", isRequired: false }],
    },
  ],
  resources: ["catalog", "stream", "meta"],
};

// -------------------------------------------------------------------
// ADDON BUILDER
// -------------------------------------------------------------------
const builder = new addonBuilder(manifest);

// ---------------- Catalog ----------------
builder.defineCatalogHandler(async ({ extra }) => {
  return {
    metas: [
      // TEMP Example entry
      {
        id: "example-channel",
        type: "tv",
        name: "Example Channel",
        poster: "https://via.placeholder.com/300x200",
      },
    ],
  };
});

// ---------------- Stream ----------------
builder.defineStreamHandler(async ({ id }) => {
  return {
    streams: [
      {
        url: "https://example.com/test.m3u8",
      },
    ],
  };
});

// ---------------- Meta ----------------
builder.defineMetaHandler(async ({ id }) => {
  return {
    meta: {
      id,
      type: "tv",
      name: "Example Channel",
    },
  };
});

// -------------------------------------------------------------------
// EXPRESS ROUTES
// -------------------------------------------------------------------

// 1) Manifest
app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

// 2) Addon interface (catalog/stream/meta)
app.use("/", builder.getInterface());

// 3) Root route
app.get("/", (req, res) => {
  res.send("Shanny IPTV Addon is running. Use /manifest.json");
});

// -------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Shanny IPTV Addon running on port ${PORT}`);
  console.log(`🔗 Manifest URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME}/manifest.json`);
});
