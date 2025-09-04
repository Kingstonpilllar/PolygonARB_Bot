const fs = require('fs');
const axios = require('axios');

// List of tokens to track (for demonstration, this list should contain up to 200 tokens)
const tokens = [
  { symbol: "USDT", coingeckoId: "tether", krakenPair: "USDTUSD" },
  { symbol: "DAI", coingeckoId: "dai", krakenPair: "DAIUSD" },
  { symbol: "MATIC", coingeckoId: "matic-network", krakenPair: "MATICUSD" },
  { symbol: "USDC", coingeckoId: "usd-coin", krakenPair: "USDCUSD" },
  { symbol: "WETH", coingeckoId: "weth", krakenPair: "ETHUSD" },
  // Add more tokens here up to 200 tokens
];

// File to save token list info
const TOKENLIST_FILE = './tokenlist.json';

// Fetch prices from CoinGecko for a list of tokens
async function fetchCoinGeckoPrices() {
  const ids = tokens.map(t => t.coingeckoId).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await axios.get(url);
  return res.data; // { tether: { usd: 1 }, dai: { usd: 1 }, ... }
}

// Fetch Kraken prices for the token pairs
async function fetchKrakenPrices() {
  const pairs = tokens.map(t => t.krakenPair).join(',');
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pairs}`;
  const res = await axios.get(url);
  return res.data.result; // Kraken API returns complex nested objects
}

// Update tokenlist.json with prices
async function updateTokenlist() {
  try {
    const cgPrices = await fetchCoinGeckoPrices();
    const krakenData = await fetchKrakenPrices();

    const tokenList = tokens.map(token => {
      // CoinGecko price
      const cgPrice = cgPrices[token.coingeckoId]?.usd || 0;

      // Kraken price (mid price = (bid + ask)/2)
      const krakenTicker = Object.values(krakenData).find(v => v.a && v.b);
      const krakenPrice = krakenTicker ? (parseFloat(krakenTicker.a[0]) + parseFloat(krakenTicker.b[0])) / 2 : 0;

      return {
        symbol: token.symbol,
        coingeckoPriceUSD: cgPrice,
        krakenPriceUSD: krakenPrice
      };
    });

    // Save to tokenlist.json
    fs.writeFileSync(TOKENLIST_FILE, JSON.stringify(tokenList, null, 2));
    console.log('✅ tokenlist.json updated successfully!');
  } catch (err) {
    console.error('❌ Error updating tokenlist.json:', err);
  }
}

// Run the update
updateTokenlist();

// Optional: Update every 5 minutes
setInterval(updateTokenlist, 5 * 60 * 1000); // Update every 5 minutes
