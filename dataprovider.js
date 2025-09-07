// dataProvider.js (Ethers v6 compatible, ESM)
// Requires: package.json -> { "type": "module" }

import 'dotenv/config';
import { ethers } from 'ethers';

const WSS_URLS = process.env.WSS_URLS
  ? process.env.WSS_URLS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

if (WSS_URLS.length === 0) {
  throw new Error('❌ No WSS_URLS found in .env (example: WSS_URLS=wss://alchemy...,wss://quiknode...)');
}

let provider;
let currentIndex = 0;
let blockHandler = null;
let errorHandler = null;
let heartbeatId = null;

function attachProviderEvents() {
  // v6 surfaces provider-level 'error'
  errorHandler = (err) => {
    console.error(`❌ WebSocket provider error on ${WSS_URLS[currentIndex]}:`, err?.message || err);
    failover();
  };
  provider.on('error', errorHandler);

  // best-effort: if underlying socket is exposed, add open/close logs
  const ws = provider._websocket || provider._ws || provider._socket || null;
  if (ws) {
    const onOpen = () => console.log(`✅ WebSocket connected: ${WSS_URLS[currentIndex]}`);
    const onClose = () => {
      console.warn(`⚠️ WebSocket closed: ${WSS_URLS[currentIndex]}`);
      failover();
    };
    ws.addEventListener?.('open', onOpen);
    ws.addEventListener?.('close', onClose);
    // keep refs to detach later
    provider.__wsExtra = { ws, onOpen, onClose };
  }

  // heartbeat to detect silent drops
  heartbeatId = setInterval(async () => {
    try { await provider.getBlockNumber(); } catch { failover(); }
  }, 15000);
}

function detachProviderEvents() {
  try {
    if (blockHandler) provider.off('block', blockHandler);
    if (errorHandler) provider.off('error', errorHandler);
    blockHandler = null;
    errorHandler = null;
  } catch {}
  if (heartbeatId) { clearInterval(heartbeatId); heartbeatId = null; }
  const extra = provider?.__wsExtra;
  if (extra?.ws) {
    extra.ws.removeEventListener?.('open', extra.onOpen);
    extra.ws.removeEventListener?.('close', extra.onClose);
  }
  provider.__wsExtra = undefined;
}

async function connectProvider() {
  const url = WSS_URLS[currentIndex];
  console.log(`🔌 Connecting WebSocket provider: ${url}`);
  provider = new ethers.WebSocketProvider(url);
  attachProviderEvents();
  return provider;
}

function failover() {
  detachProviderEvents();
  try { provider?.destroy?.(); } catch {}
  console.log('♻️ Switching provider...');
  currentIndex = (currentIndex + 1) % WSS_URLS.length;
  connectProvider().then(startListeners).catch((e) => {
    console.error('Failover connect error:', e?.message || e);
    setTimeout(failover, 1000);
  });
}

function startListeners() {
  // block listener (same logic spot as your original)
  blockHandler = (blockNumber) => {
    console.log('⛓️ New block:', blockNumber);
    // ⚡ Add your pool fetch logic here
  };
  provider.on('block', blockHandler);
}

async function waitForOpen(timeoutMs = 12000) {
  // Resolve on first successful RPC or timeout
  const start = Date.now();
  // Try quick poll first
  while (Date.now() - start < timeoutMs) {
    try { await provider.getBlockNumber(); return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('WebSocket open timeout');
}

async function start() {
  await connectProvider();
  await waitForOpen();
  startListeners();
}

// auto-start
start();

// Exports (so other modules can access the live provider)
export { provider, start };
export default provider;
