// dataProvider.js
const { ethers } = require("ethers");

// For live data (use WSS, multiple fallback if needed)
const WSS_URLS = process.env.WSS_URLS
  ? process.env.WSS_URLS.split(",").map(s => s.trim())
  : [];

if (WSS_URLS.length === 0) {
  throw new Error("❌ No WSS_URLS found in .env (example: WSS_URLS=wss://alchemy...,wss://quiknode...)");
}

let provider;
let currentIndex = 0;

async function connectProvider() {
  const url = WSS_URLS[currentIndex];
  console.log(`🔌 Connecting WebSocket provider: ${url}`);
  provider = new ethers.WebSocketProvider(url);

  // Connection success
  provider._websocket.on("open", () => {
    console.log(`✅ WebSocket connected: ${url}`);
  });

  // Error handling
  provider._websocket.on("error", (err) => {
    console.error(`❌ WebSocket error on ${url}:`, err.message);
    failover();
  });

  provider._websocket.on("close", () => {
    console.warn(`⚠️ WebSocket closed: ${url}`);
    failover();
  });

  return provider;
}

function failover() {
  console.log("♻️ Switching provider...");
  currentIndex = (currentIndex + 1) % WSS_URLS.length;
  connectProvider().then(startListeners);
}

function startListeners() {
  // Example: listen to new blocks
  provider.on("block", (blockNumber) => {
    console.log("⛓️ New block:", blockNumber);
    // ⚡ Add your pool fetch logic here
  });
}

async function start() {
  await connectProvider();
  startListeners();
}

start();

module.exports = provider;
