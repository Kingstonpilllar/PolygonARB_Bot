// scanner.js

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

/* =========================
   Config & boot
========================= */
const MEV_FILE = path.join(process.cwd(), 'mev_queue.json');

const WS_URLS = (process.env.WS_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!WS_URLS.length) {
  console.warn('тЪая╕П  WS_URLS is empty; scanner will not start.');
  return;
}

let routers = {};
try { routers = require('./routers.json'); }
catch { routers = {}; console.warn('тЪая╕П  routers.json missing/invalid; router-target checks will be reduced.'); }

const ROUTER_SET = new Set(
  Object.values(routers || {})
    .filter(v => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v))
    .map(v => v.toLowerCase())
);

// Gas threshold (GWEI) for simple MEV signal
const HIGH_GAS_LIMIT = (() => {
  try { return (ethers.utils || ethers).parseUnits(String(process.env.HIGH_GAS_GWEI || '300'), 'gwei'); }
  catch { return (ethers.utils || ethers).parseUnits('300', 'gwei'); }
})();

/* =========================
   Retention (NEW)
   - keep only last N hours (default 24)
========================= */
const SCANNER_MEV_MAX_AGE_HOURS = Number(process.env.SCANNER_MEV_MAX_AGE_HOURS || 24);
const MAX_AGE_MS = Math.max(1, SCANNER_MEV_MAX_AGE_HOURS) * 60 * 60 * 1000;

/** Read queue safely */
function safeReadQueue() {
  try {
    if (!fs.existsSync(MEV_FILE)) return [];
    const raw = fs.readFileSync(MEV_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch { return []; }
}

/** NEW: prune entries older than MAX_AGE_MS */
function pruneMevQueue(now = Date.now()) {
  try {
    const queue = safeReadQueue();
    if (!Array.isArray(queue) || queue.length === 0) return 0;
    const cutoff = now - MAX_AGE_MS;
    const fresh = queue.filter(e => {
      const ts = Number(e?.timestamp || 0);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    if (fresh.length !== queue.length) {
      fs.writeFileSync(MEV_FILE, JSON.stringify(fresh, null, 2));
      console.log(`🧹 Pruned MEV queue: kept ${fresh.length}, removed ${queue.length - fresh.length} (>${SCANNER_MEV_MAX_AGE_HOURS}h old)`);
      return queue.length - fresh.length;
    }
    return 0;
  } catch (e) {
    console.warn('⚠️  pruneMevQueue failed:', e?.message || e);
    return 0;
  }
}

/** Schedule periodic prune (hourly is fine; keeps file fresh daily) */
function schedulePrune() {
  // initial prune on boot
  pruneMevQueue();
  // prune every hour
  setInterval(() => pruneMevQueue(), 60 * 60 * 1000);
}
schedulePrune();

/* =========================
   ABIs & Interface helpers
========================= */
// ethers v5: ethers.utils.Interface; v6: ethers.Interface
const InterfaceCtor = ethers.Interface || (ethers.utils && ethers.utils.Interface);

// Uniswap V2 Router (fragments we care about)
const V2_IFACE = new InterfaceCtor([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)'
]);

// Uniswap V3 SwapRouter (fragments we care about)
// exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
const V3_IFACE = new InterfaceCtor([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)',
  // Optional: many routers expose multicall(bytes[]) – we decode inner calls if present
  'function multicall(bytes[] data) returns (bytes[] results)'
]);

/* =========================
   Utils
========================= */

/** (UPDATED) Log with pre-prune to ensure file stays within window */
function logToMevQueue(entry) {
  // prune first so we never grow beyond the retention window
  pruneMevQueue();

  const queue = safeReadQueue();
  if (!queue.some(q => q.hash === entry.hash)) {
    queue.push(entry);
    fs.writeFileSync(MEV_FILE, JSON.stringify(queue, null, 2));
    console.log(`ЁЯЪи MEV risk logged: ${entry.hash}`);
  }
}

function isRouterTarget(to) {
  if (!to) return false;
  try { return ROUTER_SET.has(to.toLowerCase()); } catch { return false; }
}

function getEffectiveGasPrice(tx) {
  return tx.maxFeePerGas || tx.gasPrice || null;
}

// v5/v6 compatible WebSocketProvider
function makeWsProvider(url) {
  const Ctor = (ethers.providers && ethers.providers.WebSocketProvider)
    ? ethers.providers.WebSocketProvider
    : ethers.WebSocketProvider;
  return new Ctor(url);
}

/* =========================
   Decoders
========================= */
function decodeV2Swap(data) {
  try {
    const parsed = V2_IFACE.parseTransaction({ data });
    const fn = parsed.name;

    if (fn === 'swapExactTokensForTokens') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)),
        amountIn: amountIn.toString(),
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }

    if (fn === 'swapExactETHForTokens') {
      const [amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)), // input is native; first token is the out token
        amountIn: 'NATIVE',               // cannot know exact from calldata (comes from tx.value)
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }

    if (fn === 'swapExactTokensForETH') {
      const [amountIn, amountOutMin, path, to] = parsed.args;
      return {
        protocol: 'V2',
        method: fn,
        tokens: path.map(a => String(a)), // last hop out is native
        amountIn: amountIn.toString(),
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }
  } catch (_) {}
  return null;
}

function decodeV3Path(pathBytes) {
  // V3 path = token(20) [fee(3) token(20)]*
  const tokens = [];
  const hex = pathBytes.slice(2); // strip 0x
  let i = 0;
  while (i + 40 <= hex.length) {
    const token = '0x' + hex.slice(i, i + 40);
    tokens.push(ethers.utils ? ethers.utils.getAddress(token) : ethers.getAddress(token));
    i += 40;
    if (i + 6 > hex.length) break; // no room for fee => end
    i += 6; // skip fee (3 bytes)
  }
  return tokens;
}

function decodeV3Swap(data) {
  try {
    const parsed = V3_IFACE.parseTransaction({ data });
    const fn = parsed.name;

    if (fn === 'exactInputSingle') {
      const p = parsed.args[0]; // tuple
      return {
        protocol: 'V3',
        method: fn,
        tokens: [String(p.tokenIn), String(p.tokenOut)],
        amountIn: p.amountIn.toString(),
        minOut: p.amountOutMinimum.toString(),
        recipient: String(p.recipient),
        fee: Number(p.fee)
      };
    }

    if (fn === 'exactInput') {
      const [pathBytes, recipient, /*deadline*/, amountIn, amountOutMinimum] = parsed.args;
      const tokens = decodeV3Path(String(pathBytes));
      return {
        protocol: 'V3',
        method: fn,
        tokens,
        amountIn: amountIn.toString(),
        minOut: amountOutMinimum.toString(),
        recipient: String(recipient)
      };
    }

    if (fn === 'multicall') {
      // Try to decode inner calls; collect all swap-like items
      const calls = parsed.args[0] || [];
      const inner = [];
      for (const c of calls) {
        const hex = String(c);
        const one = decodeV2Swap(hex) || decodeV3Swap(hex);
        if (one) inner.push(one);
      }
      if (inner.length) {
        return { protocol: 'MULTICALL', method: 'multicall', inner };
      }
    }
  } catch (_) {}
  return null;
}

function decodeSwapCalldata(data) {
  // Try V2 first, then V3
  return decodeV2Swap(data) || decodeV3Swap(data);
}

/* =========================
   Scanner
========================= */
function startScanner(url, index, attempt = 0) {
  const label = `[WS ${index}]`;
  const backoffMs = Math.min(30_000, 2000 * Math.max(1, attempt));

  let provider;
  try { provider = makeWsProvider(url); }
  catch (e) {
    console.warn(`${label} Provider init failed: ${e.message}. Retrying in ${backoffMs} ms`);
    return setTimeout(() => startScanner(url, index, attempt + 1), backoffMs);
  }

  provider.getNetwork?.().then(n => {
    console.log(`${label} Connected: ${url} (chainId ${n?.chainId ?? 'unknown'})`);
  }).catch(() => console.log(`${label} Connected: ${url}`));

  provider.on('pending', async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) return;

      const effGas = getEffectiveGasPrice(tx);
      const gasIsHigh = effGas ? effGas.gt(HIGH_GAS_LIMIT) : false;
      const hitsRouter = isRouterTarget(tx.to);

      // Try to decode tokens/amounts only when it looks relevant (router or high gas)
      let decoded = null;
      if (hitsRouter || gasIsHigh) {
        if (tx.data && tx.data !== '0x') {
          decoded = decodeSwapCalldata(tx.data);
        }
      }

      if (gasIsHigh || hitsRouter || decoded) {
        const entry = {
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          gasPrice: effGas ? effGas.toString() : null,
          timestamp: Date.now()
        };

        if (decoded) entry.decoded = decoded;
        // tx.value is important for swapExactETHForTokens etc.
        if (tx.value) entry.txValue = tx.value.toString();

        logToMevQueue(entry);
      }
    } catch (_) {
      // Keep stream alive
    }
  });

  // v5 raw ws hooks (if present)
  const ws = provider._websocket;
  if (ws && typeof ws.on === 'function') {
    ws.on('close', () => {
      console.warn(`${label} Closed. Reconnecting in ${backoffMs} ms...`);
      try { provider.destroy?.(); } catch {}
      setTimeout(() => startScanner(url, index, attempt + 1), backoffMs);
    });
    ws.on('error', (e) => {
      console.warn(`${label} Socket error: ${e?.message || e}`);
    });
  } else {
    // v6 fallback: periodic ping to detect drop
    const ping = setInterval(async () => {
      try { await provider.getBlockNumber(); }
      catch {
        clearInterval(ping);
        console.warn(`${label} Lost connection. Reconnecting in ${backoffMs} ms...`);
        try { provider.destroy?.(); } catch {}
        setTimeout(() => startScanner(url, index, attempt + 1), backoffMs);
      }
    }, 15_000);
  }
}

WS_URLS.forEach((url, i) => startScanner(url, i));
