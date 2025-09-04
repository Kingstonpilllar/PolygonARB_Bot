// updateconfig.js
// Keeps tokenlist.json fresh & capped at 220 entries
// Also updates chainlinkpricefeed.json and routers.json if needed

const fs = require("fs");
const path = require("path");

const TOKENLIST_FILE = path.join(__dirname, "tokenlist.json");
const PRICEFEED_FILE = path.join(__dirname, "chainlinkpricefeed.json");
const ROUTERS_FILE = path.join(__dirname, "routers.json");

// helper: read json
function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`⚠️ Failed to read ${file}, using []`);
    return [];
  }
}

// helper: write json
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`✅ Updated ${path.basename(file)} with ${data.length || Object.keys(data).length} entries`);
}

// main update function
function updateConfig(newTokens = [], newPriceFeeds = {}, newRouters = {}) {
  // --- Update Tokenlist ---
  let tokenlist = loadJSON(TOKENLIST_FILE);

  newTokens.forEach(t => {
    if (!tokenlist.find(x => x.address.toLowerCase() === t.address.toLowerCase())) {
      tokenlist.push(t);
    }
  });

  // cap at 220 tokens (FIFO trimming)
  if (tokenlist.length > 220) {
    tokenlist = tokenlist.slice(tokenlist.length - 220);
    console.log("⚠️ Tokenlist capped at 220, trimming oldest entries");
  }

  saveJSON(TOKENLIST_FILE, tokenlist);

  // --- Update Price Feeds ---
  let feeds = loadJSON(PRICEFEED_FILE);
  feeds = { ...feeds, ...newPriceFeeds };
  saveJSON(PRICEFEED_FILE, feeds);

  // --- Update Routers ---
  let routers = loadJSON(ROUTERS_FILE);
  routers = { ...routers, ...newRouters };
  saveJSON(ROUTERS_FILE, routers);

  console.log("🚀 Config update complete.");
}

// Example usage: simulate update from poolfetcher
if (require.main === module) {
  const sampleNewTokens = [
    {
      name: "Sample Token",
      symbol: "SAMP",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      decimals: 18,
      chainId: 137
    }
  ];

  const sampleFeeds = {
    "0x1234567890abcdef1234567890abcdef12345678": "0xFeedAddressHere"
  };

  const sampleRouters = {
    quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff"
  };

  updateConfig(sampleNewTokens, sampleFeeds, sampleRouters);
}

module.exports = { updateConfig };
