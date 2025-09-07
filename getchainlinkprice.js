// getchainlinkPrices.js (ethers v6, ESM, with 2 hardcoded RPCs + fallback)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FEEDS_PATH = path.join(__dirname, "chainlinkpricefeed.json");

// === RPC URLs (hardcoded, fallback order) ===
const RPC_URLS = [
  "https://polygon-rpc.com", // Public
  "https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd" // Alchemy fallback
];

let currentIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);

function rotateProvider() {
  currentIndex = (currentIndex + 1) % RPC_URLS.length;
  provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);
  console.warn(`🔄 Switched provider → ${RPC_URLS[currentIndex]}`);
}

// ABI: support both v2/v3 Chainlink aggregators
const ABI = [
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

// Load feeds as mutable JSON
function loadFeeds() {
  try {
    const raw = fs.readFileSync(FEEDS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveFeeds(obj) {
  fs.writeFileSync(FEEDS_PATH, JSON.stringify(obj, null, 2));
  console.log("💾 chainlinkpricefeed.json updated with latest prices");
}

async function fetchPrice(feedAddress) {
  const c = new ethers.Contract(feedAddress, ABI, provider);

  let dec = 8;
  try { dec = await c.decimals(); } catch {}

  try {
    const { answer } = await c.latestRoundData();
    return Number(ethers.formatUnits(answer, dec));
  } catch {
    const ans = await c.latestAnswer();
    return Number(ethers.formatUnits(ans, dec));
  }
}

export async function updateChainlinkPrices() {
  const feeds = loadFeeds();

  for (const token of Object.keys(feeds)) {
    try {
      const entry = feeds[token];
      const feedAddress = typeof entry === "string" ? entry : entry.feedAddress;
      if (!feedAddress) {
        console.warn(`⚠️ Skipping ${token}: no feedAddress`);
        continue;
      }

      const price = await fetchPrice(feedAddress);

      if (typeof entry === "string") {
        feeds[token] = { feedAddress, latestPrice: price };
      } else {
        feeds[token].latestPrice = price;
      }

      console.log(`✅ ${token}: ${price}`);
    } catch (err) {
      console.error(`❌ Failed to fetch ${token}: ${err.message || err}`);
      rotateProvider(); // switch to fallback RPC
    }
  }

  saveFeeds(feeds);
}

// Run once if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateChainlinkPrices();
  // Optional recurring updates:
  // setInterval(updateChainlinkPrices, 5 * 60 * 1000);
}
