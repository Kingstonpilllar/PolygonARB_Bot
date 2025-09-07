import fs from "fs";
import axios from "axios";

// List of tokens to track (expand to 200 if you want)
const tokens = [
  { symbol: "USDT", coingeckoId: "tether", krakenPair: "USDTZUSD" }, // correct Kraken code
  { symbol: "DAI", coingeckoId: "dai", krakenPair: "DAIUSD" },
  { symbol: "MATIC", coingeckoId: "matic-network", krakenPair: "MATICUSD" },
  { symbol: "USDC", coingeckoId: "usd-coin", krakenPair: "USDCUSD" },
  { symbol: "WETH", coingeckoId: "weth", krakenPair: "ETHUSD" },
];

// File to save token list info
const TOKENLIST_FILE = "./tokenlist.json";

// Fetch CoinGecko prices
async function fetchCoinGeckoPrices() {
  const ids = tokens.map(t => t.coingeckoId).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await axios.get(url);
  return res.data; // { tether: { usd: 1 }, dai: { usd: 1 }, ... }
}

// Fetch Kraken prices
async function fetchKrakenPrices() {
  const pairs = tokens.map(t => t.krakenPair).join(",");
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;
  const res = await axios.get(url);
  return res.data.result; // { USDTZUSD: {...}, DAIUSD: {...}, ... }
}

// Update tokenlist.json
async function updateTokenlist() {
  try {
    const cgPrices = await fetchCoinGeckoPrices();
    const krakenData = await fetchKrakenPrices();

    const tokenList = tokens.map(token => {
      // --- CoinGecko price ---
      const cgPrice = cgPrices[token.coingeckoId]?.usd || 0;

      // --- Kraken price ---
      const krakenTicker = krakenData[token.krakenPair];
      let krakenPrice = 0;
      if (krakenTicker?.a && krakenTicker?.b) {
        const ask = parseFloat(krakenTicker.a[0]); // best ask
        const bid = parseFloat(krakenTicker.b[0]); // best bid
        krakenPrice = (ask + bid) / 2; // mid price
      }

      return {
        symbol: token.symbol,
        coingeckoPriceUSD: cgPrice,
        krakenPriceUSD: krakenPrice,
      };
    });

    // Save results
    fs.writeFileSync(TOKENLIST_FILE, JSON.stringify(tokenList, null, 2));
    console.log("✅ tokenlist.json updated successfully!");
  } catch (err) {
    console.error("❌ Error updating tokenlist.json:", err.message || err);
  }
}

// Run once
updateTokenlist();

// Auto-update every 5 minutes
setInterval(updateTokenlist, 5 * 60 * 1000);
