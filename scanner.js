// scanner.js тАФ Ethers v6 only (no v5/private fallbacks), logic preserved

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

/* =========================
   Paths & Config
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEV_FILE = path.join(process.cwd(), 'mev_queue.json');

const WS_URLS = (process.env.WS_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!WS_URLS.length) {
  console.warn('тЪая╕П  WS_URLS is empty; scanner will not start.');
  // Do not exit; just no-op so other services can run.
}

/* =========================
   Routers & Gas threshold
========================= */
let routers = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'routers.json'), 'utf8');
  routers = JSON.parse(raw || '{}');
} catch {
  routers = {};
  console.warn('тЪая╕П  routers.json missing/invalid; router-target checks will be reduced.');
}

const ROUTER_SET = new Set(
  Object.values(routers || {})
    .filter(v => typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v))
    .map(v => v.toLowerCase())
);

// Gas threshold (GWEI) for simple MEV signal (v6 returns bigint)
const HIGH_GAS_LIMIT = (() => {
  try { return ethers.parseUnits(String(process.env.HIGH_GAS_GWEI || '300'), 'gwei'); }
  catch { return ethers.parseUnits('300', 'gwei'); }
})();

/* =========================
   Retention (keep last N hours)
========================= */
const SCANNER_MEV_MAX_AGE_HOURS = Number(process.env.SCANNER_MEV_MAX_AGE_HOURS || 24);
const MAX_AGE_MS = Math.max(1, SCANNER_MEV_MAX_AGE_HOURS) * 60 * 60 * 1000;

function safeReadQueue() {
  try {
    if (!fs.existsSync(MEV_FILE)) return [];
    const raw = fs.readFileSync(MEV_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch { return []; }
}

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
      console.log(`ЁЯз╣ Pruned MEV queue: kept ${fresh.length}, removed ${queue.length - fresh.length} (> ${SCANNER_MEV_MAX_AGE_HOURS}h old)`);
      return queue.length - fresh.length;
    }
    return 0;
  } catch (e) {
    console.warn('тЪая╕П  pruneMevQueue failed:', e?.message || e);
    return 0;
  }
}

(function schedulePrune() {
  pruneMevQueue();                   // initial prune on boot
  setInterval(pruneMevQueue, 60 * 60 * 1000); // hourly
})();

/* =========================
   ABIs & Interfaces (v6)
========================= */
const V2_IFACE = new ethers.Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)'
]);

const V3_IFACE = new ethers.Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)',
  'function exactInput(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) returns (uint256 amountOut)',
  'function multicall(bytes[] data) returns (bytes[] results)'
]);

/* =========================
   Utils
========================= */
function logToMevQueue(entry) {
  pruneMevQueue();
  const queue = safeReadQueue();
  if (!queue.some(q => q.hash === entry.hash)) {
    queue.push(entry);
    fs.writeFileSync(MEV_FILE, JSON.stringify(queue, null, 2));
    console.log(`тЬЕ MEV risk logged: ${entry.hash}`);
  }
}

function isRouterTarget(to) {
  if (!to) return false;
  try { return ROUTER_SET.has(to.toLowerCase()); } catch { return false; }
}

function getEffectiveGasPrice(tx) {
  // v6: bigint or null
  return (tx.maxFeePerGas ?? tx.gasPrice) ?? null;
}

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
        tokens: path.map(a => String(a)),
        amountIn: 'NATIVE', // from tx.value
        minOut: amountOutMin.toString(),
        recipient: String(to)
      };
    }

    if (fn === 'swapExactTokensForETH') {
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
  } catch {}
  return null;
}

function decodeV3Path(pathBytes) {
  // V3 path = token(20) [fee(3) token(20)]*
  const tokens = [];
  const hex = String(pathBytes).slice(2);
  let i = 0;
  while (i + 40 <= hex.length) {
    const token = '0x' + hex.slice(i, i + 40);
    tokens.push(ethers.getAddress(token));
    i += 40;
    if (i + 6 > hex.length) break;
    i += 6; // skip fee (3 bytes)
  }
  return tokens;
}

function decodeV3Swap(data) {
  try {
    const parsed = V3_IFACE.parseTransaction({ data });
    const fn = parsed.name;

    if (fn === 'exactInputSingle') {
      const p = parsed.args[0];
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
      const calls = parsed.args[0] || [];
      const inner = [];
      for (const c of calls) {
        const hex = String(c);
        const one = decodeV2Swap(hex) || decodeV3Swap(hex);
        if (one) inner.push(one);
      }
      if (inner.length) return { protocol: 'MULTICALL', method: 'multicall', inner };
    }
  } catch {}
  return null;
}

function decodeSwapCalldata(data) {
  return decodeV2Swap(data) || decodeV3Swap(data);
}

/* =========================
   Scanner (pure v6 WS)
========================= */
function startScanner(url, index, attempt = 0) {
  if (!url) return;

  const label = `[WS ${index}]`;
  const backoffMs = Math.min(30_000, 2000 * Math.max(1, attempt));
  const hbIntervalMs = 15_000;

  let provider;
  try {
    provider = new ethers.WebSocketProvider(url);
  } catch (e) {
    console.warn(`${label} Provider init failed: ${e.message}. Retrying in ${backoffMs} ms`);
    return setTimeout(() => startScanner(url, index, attempt + 1), backoffMs);
  }

  // Helpful connect log (chainId may require an RPC call)
  provider.getNetwork().then(n => {
    console.log(`${label} Connected: ${url} (chainId ${n?.chainId ?? 'unknown'})`);
  }).catch(() => console.log(`${label} Connected: ${url}`));

  // Pending tx stream
  provider.on('pending', async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) return;

      const effGas = getEffectiveGasPrice(tx); // bigint or null
      const gasIsHigh = effGas ? (effGas > HIGH_GAS_LIMIT) : false;
      const hitsRouter = isRouterTarget(tx.to);

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
        if (tx.value) entry.txValue = tx.value.toString();
        logToMevQueue(entry);
      }
    } catch {
      // keep stream alive
    }
  });

  // Public error event тЖТ reconnect
  const onError = (err) => {
    console.warn(`${label} Provider error: ${err?.message || err}. Reconnecting in ${backoffMs} ms...`);
    cleanupAndRetry();
  };
  provider.on('error', onError);

  // Heartbeat to detect silent drops (no private ws access)
  const hb = setInterval(async () => {
    try { await provider.getBlockNumber(); }
    catch {
      console.warn(`${label} Heartbeat failed. Reconnecting in ${backoffMs} ms...`);
      cleanupAndRetry();
    }
  }, hbIntervalMs);

  function cleanupAndRetry() {
    try {
      provider.off('error', onError);
      provider.removeAllListeners?.('pending'); // be tidy
      clearInterval(hb);
      provider.destroy?.(); // v6 WebSocketProvider has destroy()
    } catch {}
    setTimeout(() => startScanner(url, index, attempt + 1), backoffMs);
  }
}

WS_URLS.forEach((url, i) => startScanner(url, i));
