import fs from "fs";
import axios from "axios";

// List of tokens to track (expand up to 200)
const tokens = [
  { symbol: "USDT", coingeckoId: "tether",           krakenPair: "USDTZUSD" },
  { symbol: "DAI",  coingeckoId: "dai",              krakenPair: "DAIUSD"   },
  { symbol: "MATIC",coingeckoId: "matic-network",    krakenPair: "MATICUSD" },
  { symbol: "USDC", coingeckoId: "usd-coin",         krakenPair: "USDCUSD"  },
  // Kraken doesn’t use WETHUSD; use ETH if you want a Kraken cross:
  { symbol: "WETH", coingeckoId: "weth",             krakenPair: "ETHUSD"   },
  // Add more tokens here
];

const TOKENLIST_FILE = "./tokenlist.json";
const MAX_TOKENS = 220;
const MAX_SPREAD_PERCENT = 1; // Max allowed spread between bid & ask
const MIN_VOLUME = 1000;      // USD (optional)

// Axios instances with light hardening
const http = axios.create({
  timeout: 12_000,
  headers: { "User-Agent": "tokenlist-updater/1.0" }
});

// --- CoinGecko ---
async function fetchCoinGeckoPrices() {
  const ids = tokens.map(t => t.coingeckoId).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const { data } = await http.get(url);
  if (!data || typeof data !== "object") {
    throw new Error("CoinGecko: empty/invalid response");
  }
  return data; // { id: { usd: number } }
}

// --- Kraken ---
async function fetchKrakenPrices() {
  const pairs = tokens.map(t => t.krakenPair).join(",");
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;
  const { data } = await http.get(url);

  if (!data) throw new Error("Kraken: empty response");
  if (Array.isArray(data.error) && data.error.length) {
    throw new Error(`Kraken API error: ${data.error.join("; ")}`);
  }
  if (!data.result || typeof data.result !== "object") {
    throw new Error("Kraken: missing result");
  }
  return data.result; // map of pairKey -> ticker
}

// Find a ticker even if Kraken changed the key name
function findKrakenTicker(krakenResult, desiredPair) {
  if (krakenResult[desiredPair]) return krakenResult[desiredPair];
  // fallback: try to match by suffix or exact altname-like
  const keys = Object.keys(krakenResult);
  // exact case-insensitive
  let key = keys.find(k => k.toUpperCase() === desiredPair.toUpperCase());
  if (key) return krakenResult[key];
  // endsWith heuristic (e.g., “XETHZUSD” ends with “USD” etc.)
  key = keys.find(k => k.toUpperCase().includes(desiredPair.toUpperCase()));
  return key ? krakenResult[key] : undefined;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

// Update tokenlist.json with only liquid tokens
async function updateTokenlist() {
  try {
    const [cgPrices, krakenData] = await Promise.all([
      fetchCoinGeckoPrices(),
      fetchKrakenPrices()
    ]);

    const tokenList = [];

    for (const token of tokens) {
      const cgPrice = toNum(cgPrices[token.coingeckoId]?.usd);
      // If CG missing, keep 0 rather than NaN
      const coingeckoPriceUSD = Number.isFinite(cgPrice) ? cgPrice : 0;

      const ticker = findKrakenTicker(krakenData, token.krakenPair);
      if (!ticker || !Array.isArray(ticker.a) || !Array.isArray(ticker.b)) {
        // no valid ask/bid → skip
        continue;
      }

      const ask = toNum(ticker.a[0]);
      const bid = toNum(ticker.b[0]);
      if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) {
        continue;
      }

      const mid = (ask + bid) / 2;
      const spreadPercent = ((ask - bid) / mid) * 100;

      if (!Number.isFinite(spreadPercent) || spreadPercent > MAX_SPREAD_PERCENT) {
        continue;
      }

      // Optional volume filter (Kraken “v” = [today, last24h])
      // Ensure we have v[1]; compute USD volume approx = price * baseVolume
      let passVolume = true;
      if (Array.isArray(ticker.v) && ticker.v[1] != null) {
        const baseVol = toNum(ticker.v[1]);
        if (Number.isFinite(baseVol) && baseVol >= 0) {
          const volumeUSD = baseVol * mid;
          if (volumeUSD < MIN_VOLUME) passVolume = false;
        }
      }
      if (!passVolume) continue;

      tokenList.push({
        symbol: token.symbol,
        coingeckoPriceUSD,
        krakenPriceUSD: Number(mid.toFixed(6)),
        spreadPercent: Number(spreadPercent.toFixed(3))
      });

      if (tokenList.length >= MAX_TOKENS) break;
    }

    fs.writeFileSync(TOKENLIST_FILE, JSON.stringify(tokenList, null, 2));
    console.log(`✅ tokenlist.json updated with ${tokenList.length} high-liquidity tokens!`);
  } catch (err) {
    console.error("❌ Error updating tokenlist.json:", err?.message || err);
  }
}

// Run once
updateTokenlist();

// Auto-update every 5 minutes
setInterval(updateTokenlist, 5 * 60 * 1000);

