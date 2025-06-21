const { addonBuilder } = require("stremio-addon-sdk");

const manifest = {
  id: "org.example.iptvaddon",
  version: "1.0.0",
  name: "Test IPTV Addon",
  description: "Streams test HLS video that works on all devices including Smart TVs",
  resources: ["catalog", "stream", "meta"],
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "iptv_test"
    }
  ]
};

const builder = new addonBuilder(manifest);

// Sample catalog with 1 item for testing
builder.defineCatalogHandler(({ id, type }) => {
  if (id === "iptv_test" && type === "tv") {
    return Promise.resolve({
      metas: [
        {
          id: "test_bbc_one",
          name: "Test BBC One",
          type: "tv",
          poster: "https://upload.wikimedia.org/wikipedia/en/thumb/e/e5/BBC_One_logo_2021.svg/220px-BBC_One_logo_2021.svg.png"
        }
      ]
    });
  }
  return Promise.resolve({ metas: [] });
});

// 🔥 Stream handler — this MUST be hit when selecting the channel
builder.defineStreamHandler(({ type, id }) => {
  console.log("STREAM REQUEST:", type, id);

  // Only return stream for the known test channel
  if (id === "test_bbc_one") {
    return Promise.resolve({
      streams: [
        {
          title: "Test HLS Stream",
          url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", // universal test stream
          name: "Test",
          behaviorHints: {
            notWebReady: false
          }
        }
      ]
    });
  }

  // For unknown IDs, return empty array
  return Promise.resolve({ streams: [] });
});

// Meta handler — just returns the same info as in the catalog
builder.defineMetaHandler(({ id, type }) => {
  if (id === "test_bbc_one" && type === "tv") {
    return Promise.resolve({
      meta: {
        id: "test_bbc_one",
        name: "Test BBC One",
        type: "tv",
        poster: "https://upload.wikimedia.org/wikipedia/en/thumb/e/e5/BBC_One_logo_2021.svg/220px-BBC_One_logo_2021.svg.png",
        description: "This is a test stream that works on all devices"
      }
    });
  }

  return Promise.resolve({ meta: {} });
});

module.exports = builder.getInterface();
