// updateconfig.js (ESM)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Rebuild __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENLIST_FILE = path.join(__dirname, "tokenlist.json");
const PRICEFEED_FILE = path.join(__dirname, "chainlinkpricefeed.json");
const ROUTERS_FILE   = path.join(__dirname, "routers.json");

// helper: read json with correct fallback type
function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    // Ensure the returned type matches the fallback’s type
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    if (fallback && typeof fallback === "object") return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    return parsed ?? fallback;
  } catch (err) {
    console.error(`⚠️ Failed to read/parse ${path.basename(file)}: ${err.message}. Using fallback.`);
    return fallback;
  }
}

// helper: write json (pretty) + size-aware log
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const size = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
  console.log(`✅ Updated ${path.basename(file)} with ${size} entr${size === 1 ? "y" : "ies"}`);
}

// main update function
export function updateConfig(newTokens = [], newPriceFeeds = {}, newRouters = {}) {
  // --- Update Tokenlist (Array) ---
  let tokenlist = loadJSON(TOKENLIST_FILE, []);
  for (const t of newTokens) {
    // require an address to dedupe; skip unsafe entries
    if (!t || !t.address) continue;
    const addr = String(t.address).toLowerCase();
    if (!tokenlist.find(x => x && x.address && String(x.address).toLowerCase() === addr)) {
      tokenlist.push(t);
    }
  }

  // cap at 220 tokens (FIFO trimming)
  if (tokenlist.length > 220) {
    tokenlist = tokenlist.slice(tokenlist.length - 220);
    console.log("⚠️ Tokenlist capped at 220, trimming oldest entries");
  }
  saveJSON(TOKENLIST_FILE, tokenlist);

  // --- Update Price Feeds (Object map: tokenAddress -> feedAddress) ---
  let feeds = loadJSON(PRICEFEED_FILE, {});
  feeds = { ...feeds, ...newPriceFeeds };
  saveJSON(PRICEFEED_FILE, feeds);

  // --- Update Routers (Object map: dexName -> routerAddress) ---
  let routers = loadJSON(ROUTERS_FILE, {});
  routers = { ...routers, ...newRouters };
  saveJSON(ROUTERS_FILE, routers);

  console.log("🎯 Config update complete.");
}

// Example usage: simulate update from poolfetcher
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sampleNewTokens = [
    {
      name: "Sample Token",
      symbol: "SAMP",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      decimals: 18,
      chainId: 137,
    },
  ];

  const sampleFeeds = {
    "0x1234567890abcdef1234567890abcdef12345678": "0xFeedAddressHere",
  };

  const sampleRouters = {
    quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  };

  updateConfig(sampleNewTokens, sampleFeeds, sampleRouters);
}
