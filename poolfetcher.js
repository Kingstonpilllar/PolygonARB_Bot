// ESM + Ethers v6 version
// Dependencies: npm install ethers axios
// (fs, path, child_process are built-in)

import 'dotenv/config';
import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import dexConfig from './dexconfig.json' assert { type: 'json' };
import { FACTORIES } from './factories.js';
import factoryABIs from './factory_ABI.js'; // assumed export of ABIs

// === CONFIG (Polygon-only) ===
const WSS_URLS = process.env.WSS_URLS
  ? process.env.WSS_URLS.split(',').map(s => s.trim())
  : [];

if (WSS_URLS.length === 0) {
  throw new Error('❌ No WSS_URLS found in .env (example: WSS_URLS=wss://alchemy...,wss://quiknode...)');
}

let provider;
let currentIndex = 0;

/** -----------------------------------------------------------------
 *  v6-safe helpers for WebSocket events (no logic changes)
 *  - Prefer public provider events when available
 *  - Still support private _websocket if present (best-effort)
 * ----------------------------------------------------------------*/
function wsAddListener(ws, event, handler) {
  if (!ws) return;
  if (typeof ws.addEventListener === 'function') ws.addEventListener(event, handler);
  else if (typeof ws.on === 'function') ws.on(event, handler);
  else ws[`on${event}`] = handler;
}

function wsRemoveListener(ws, event, handler) {
  if (!ws) return;
  if (typeof ws.removeEventListener === 'function') ws.removeEventListener(event, handler);
  else if (typeof ws.off === 'function') ws.off(event, handler);
  else if (ws[`on${event}`] === handler) ws[`on${event}`] = null;
}

/**
 * Connect to WebSocket provider with failover support
 * (Logic preserved; uses v6 public 'error' + optional private handle if present)
 */
async function connectProvider() {
  const url = WSS_URLS[currentIndex];
  console.log(`🔌 Connecting WebSocket provider: ${url}`);

  // v6-compatible constructor
  provider = new ethers.WebSocketProvider(url);

  // Public error surface (v6)
  const onProvError = (err) => {
    console.error(`❌ WebSocket provider error on ${url}:`, err?.message || err);
    failover();
  };
  provider.on('error', onProvError);

  // If the underlying ws is exposed, wire open/error/close like your original
  const ws = provider._websocket || provider._ws || provider._socket || null;

  if (ws) {
    const onOpen = () => console.log(`✅ WebSocket connected: ${url}`);
    const onErr  = (err) => {
      console.error(`❌ WebSocket error on ${url}:`, err?.message || err);
      failover();
    };
    const onClose = () => {
      console.warn(`⚠️ WebSocket closed: ${url}`);
      failover();
    };

    wsAddListener(ws, 'open', onOpen);
    wsAddListener(ws, 'error', onErr);
    wsAddListener(ws, 'close', onClose);

    // Keep references so GC won’t drop them (optional)
    provider.__wsHandlers = { onOpen, onErr, onClose, onProvError, wsRef: ws };
  } else {
    // Fallback: we can’t get the raw socket; rely on provider events + a small heartbeat
    provider.__wsHandlers = { onProvError, wsRef: null };
  }

  return provider;
}

/**
 * Failover logic for WebSocket provider
 */
function failover() {
  try {
    // best-effort cleanup (v6 has destroy())
    provider?.off?.('error', provider?.__wsHandlers?.onProvError);
    if (provider?.destroy) { try { provider.destroy(); } catch (_) {} }
    const ws = provider?.__wsHandlers?.wsRef;
    if (ws && provider?.__wsHandlers) {
      wsRemoveListener(ws, 'open',  provider.__wsHandlers.onOpen);
      wsRemoveListener(ws, 'error', provider.__wsHandlers.onErr);
      wsRemoveListener(ws, 'close', provider.__wsHandlers.onClose);
    }
  } catch (_) {}

  console.log('♻️ Switching provider...');
  currentIndex = (currentIndex + 1) % WSS_URLS.length; // Rotate to next WSS URL
  connectProvider().then(startListeners).catch((e) => {
    console.error('Failover connect error:', e?.message || e);
    // try next
    setTimeout(failover, 1000);
  });
}

/**
 * --- WebSocket readiness helpers (no logic changes elsewhere) ---
 * v6-safe: prefer provider.getBlockNumber as a heartbeat when private socket is unavailable
 */
function waitForOpen(wsProvider, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ws = wsProvider?._websocket || wsProvider?._ws || wsProvider?._socket || null;

    // If socket is already open
    if (ws && typeof ws.readyState === 'number' && ws.readyState === 1) {
      return resolve();
    }

    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      if (err) reject(err); else resolve();
    };

    // v6-safe active poll (works even when private ws is not exposed)
    const pollInterval = 750;
    const pollTimer = setInterval(async () => {
      try {
        await wsProvider.getBlockNumber();
        finish();
      } catch (_) {}
    }, pollInterval);

    // Private handle path (keep original behavior if present)
    const onOpen = () => finish();
    const onError = (err) => finish(err instanceof Error ? err : new Error(String(err)));

    if (ws) {
      wsAddListener(ws, 'open', onOpen);
      wsAddListener(ws, 'error', onError);
    } else {
      // As a fallback, resolve on first block (same net effect)
      wsProvider.once?.('block', () => finish());
      wsProvider.on?.('error', onError);
    }

    const timer = setTimeout(() => {
      finish(new Error('WebSocket open timeout'));
    }, timeoutMs);
  });
}

async function ready() {
  if (!provider) await connectProvider();
  await waitForOpen(provider);
}

function startListeners() {
  // Example: listen to new blocks (unchanged)
  provider.on('block', (blockNumber) => {
    console.log('⛓️ New block:', blockNumber);
    // ⚡ Add your pool fetch logic here
  });
}

// Start WebSocket connection and listeners
async function start() {
  await connectProvider();
  await waitForOpen(provider);  // ensure WS is actually open (unchanged)
  startListeners();
}
start();

// === PROFIT ESTIMATION HELPERS ===
const DEX_FEE_BPS = {
  'QuickSwap': 30,
  'QuickSwap V2': 30,
  'QuickSwap V3': 5,
  'SushiSwap': 30,
  'SushiSwap V2': 30,
  'SushiSwap V3': 5,
  'Uniswap': 30,
  'Uniswap V3': 5,
  'DODO': 10,
  'KyberSwap Elastic': 10
};

const DEFAULT_FEE_BPS = 30;
const MIN_LIQUIDITY_USD = 50000;
const ARB_THRESHOLD = 0.01; // 1% (still available for edge gating if you want)

const NOTIONAL_USD = Number(process.env.POOLFETCHER_NOTIONAL_USD || 10000);
const MIN_PROFIT_USD = Number(process.env.POOLFETCHER_MIN_PROFIT_USD || 40);

function feeBpsForDex(name) {
  return DEX_FEE_BPS[name] ?? DEFAULT_FEE_BPS;
}

function bpsToFrac(bps) {
  return bps / 10_000;
}

function estimateDirectEdge(priceA, priceB, dexA, dexB) {
  const relDiff = Math.abs(priceA - priceB) / ((priceA + priceB) / 2 || 1);
  const fee = bpsToFrac(feeBpsForDex(dexA)) + bpsToFrac(feeBpsForDex(dexB));
  const edge = relDiff - fee;
  return Number.isFinite(edge) ? Math.max(edge, 0) : 0;
}

function estimateTriEdge(cycleRate, dexs) {
  const gross = (Number(cycleRate) || 0) - 1;
  const totalFees = (dexs || []).reduce((s, d) => s + bpsToFrac(feeBpsForDex(d)), 0);
  const edge = gross - totalFees;
  return Number.isFinite(edge) ? Math.max(edge, 0) : 0;
}

function edgeToProfitUSD(edgeFrac, notionalUSD = NOTIONAL_USD) {
  const e = Number(edgeFrac) || 0;
  return e > 0 ? e * notionalUSD : 0;
}

// === HELPERS ===
async function getTokenPrices(tokenAddresses) {
  if (!tokenAddresses.length) return {};
  const ids = tokenAddresses.map(addr => addr.toLowerCase()).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/token_price/polygon-pos?contract_addresses=${ids}&vs_currencies=usd`;
  const resp = await axios.get(url);
  return resp.data;
}

async function fetchPairs(factoryAddr, abi) {
  const contract = new ethers.Contract(factoryAddr, abi, provider);
  const lengthBn = await contract.allPairsLength();
  const length = Number(lengthBn);
  const pairs = [];
  for (let i = 0; i < length; i++) {
    try {
      const pairAddr = await contract.allPairs(i);
      pairs.push(pairAddr);
    } catch (err) {
      console.error('Error fetching pair index', i, err.message);
    }
  }
  return pairs;
}

async function getPairInfo(pairAddr) {
  const pairABI = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
  ];
  const pairContract = new ethers.Contract(pairAddr, pairABI, provider);
  const [t0, t1, reserves] = await Promise.all([
    pairContract.token0(),
    pairContract.token1(),
    pairContract.getReserves()
  ]);
  return {
    pairAddr,
    token0: t0,
    token1: t1,
    reserve0: reserves[0],
    reserve1: reserves[1]
  };
}

function calcPrice(reserve0, reserve1) {
  const r0 = Number(reserve0 || 0);
  const r1 = Number(reserve1 || 0);
  return (r0 > 0 && r1 > 0) ? (r0 / r1) : 0;
}

/** -----------------------------------------------------------------------
 *  SWAP EVENT WATCH (Uniswap V2-style)
 *  - On each Swap, refresh reserves for that pool
 *  - Reuse your direct arb math; append to both direct_pool.json and event log
 *  - Attempt local triangular arbs around the updated pool and append tri hits
 *  --------------------------------------------------------------------- */

// keccak256("Swap(address,uint256,uint256,uint256,uint256,address)")
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613dacf8b9baed548f383ad7bc38c5f';

// Stable key for pair regardless of token order
function pairKey(a, b) {
  const A = a.toLowerCase(), B = b.toLowerCase();
  return A < B ? `${A}|${B}` : `${B}|${A}`;
}

// Append a single record to JSON file safely
function appendJson(filename, record) {
  try {
    let arr = [];
    if (fs.existsSync(filename)) {
      const prev = fs.readFileSync(filename, 'utf8');
      if (prev) arr = JSON.parse(prev);
    }
    arr.push(record);
    fs.writeFileSync(filename, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error(`Failed to write ${filename}:`, e?.message || e);
  }
}

// Start watching Swap events for provided pools
function startSwapWatch(pairAddrsLower, poolsByAddr, poolsByPairKey, poolsByToken, edgeThreshold = 0) {
  if (!pairAddrsLower.length) {
    console.log('No pools to watch for swaps.');
    return;
  }

  console.log(`👂 Subscribing to Swap events on ${pairAddrsLower.length} pools`);

  const filter = {
    address: pairAddrsLower,   // array of pool addresses (lowercased)
    topics: [SWAP_TOPIC]
  };

  provider.on(filter, async (log) => {
    try {
      const addr = log.address.toLowerCase();
      const pool = poolsByAddr[addr];
      if (!pool) return;

      // Refresh reserves for the swapped pool
      const updated = await getPairInfo(pool.pairAddr);
      pool.reserve0 = updated.reserve0;
      pool.reserve1 = updated.reserve1;

      // ====== DIRECT ARB (same pair) ======
      const key = pairKey(pool.token0, pool.token1);
      const group = poolsByPairKey[key] || [];
      const priceA = calcPrice(pool.reserve0, pool.reserve1);

      for (const other of group) {
        if (other.pairAddr === pool.pairAddr) continue;

        const priceB = calcPrice(other.reserve0, other.reserve1);
        const edge = estimateDirectEdge(priceA, priceB, pool.dex, other.dex);

        if (edge > edgeThreshold) {
          const estProfitUSD = edgeToProfitUSD(edge);
          if (estProfitUSD >= MIN_PROFIT_USD) {
            // Console signal
            console.log(
              `💡 Swap-led DIRECT ${pool.token0}↔${pool.token1} | ${pool.dex} vs ${other.dex} | ` +
              `edge=${(edge*100).toFixed(3)}% est=$${estProfitUSD.toFixed(2)} | ` +
              `A=${pool.pairAddr} B=${other.pairAddr} | tx=${log.transactionHash}`
            );

            // Persist event record
            appendJson('swap_event_arbs.json', {
              type: 'direct',
              timestamp: Date.now(),
              blockNumber: Number(log.blockNumber),
              txHash: log.transactionHash,
              token0: pool.token0,
              token1: pool.token1,
              dexA: pool.dex,
              dexB: other.dex,
              poolAddrA: pool.pairAddr,
              poolAddrB: other.pairAddr,
              priceA,
              priceB,
              edge,
              estProfitUSD
            });

            // ALSO update direct_pool.json with this opportunity
            appendJson('direct_pool.json', {
              token0: pool.token0,
              token1: pool.token1,
              dexA: pool.dex,
              dexB: other.dex,
              priceA,
              priceB,
              poolAddrA: pool.pairAddr,
              poolAddrB: other.pairAddr,
              edge,
              estProfitUSD,
              source: 'swap_event'
            });
          }
        }
      }

      // ====== TRIANGULAR ARB (localized around updated pool) ======
      // Try cycles of form A->B (updated pool), B->C, C->A
      const tokenA = pool.token0;
      const tokenB = pool.token1;

      const poolsFromB = poolsByToken[tokenB] || [];
      for (const pool2 of poolsFromB) {
        if (pool2.pairAddr === pool.pairAddr) continue;
        const tokenC = pool2.token0 === tokenB ? pool2.token1 : pool2.token0;
        if (tokenC === tokenA) continue;

        const poolsFromC = poolsByToken[tokenC] || [];
        for (const pool3 of poolsFromC) {
          const closesLoop =
            (pool3.token0 === tokenC && pool3.token1 === tokenA) ||
            (pool3.token1 === tokenC && pool3.token0 === tokenA);
          if (!closesLoop) continue;

          const rate1 = calcPrice(pool.reserve0, pool.reserve1);
          const rate2 = calcPrice(pool2.reserve0, pool2.reserve1);
          const rate3 = calcPrice(pool3.reserve0, pool3.reserve1);
          const cycleRate = rate1 * rate2 * rate3;

          const dexs = [pool.dex, pool2.dex, pool3.dex];
          const edgeTri = estimateTriEdge(cycleRate, dexs);

          if (edgeTri > 0) {
            const estProfitUSD = edgeToProfitUSD(edgeTri);
            if (estProfitUSD >= MIN_PROFIT_USD) {
              console.log(
                `🔺 Swap-led TRI ${tokenA}->${tokenB}->${tokenC}->${tokenA} | dexs=${dexs.join(' > ')} | ` +
                `edge=${(edgeTri*100).toFixed(3)}% est=$${estProfitUSD.toFixed(2)} | ` +
                `pools=[${pool.pairAddr}, ${pool2.pairAddr}, ${pool3.pairAddr}] | tx=${log.transactionHash}`
              );

              // Persist event record
              appendJson('swap_event_arbs.json', {
                type: 'triangular',
                timestamp: Date.now(),
                blockNumber: Number(log.blockNumber),
                txHash: log.transactionHash,
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool.pairAddr, pool2.pairAddr, pool3.pairAddr],
                dexs,
                cycleRate,
                edge: edgeTri,
                estProfitUSD
              });

              // ALSO update tri_pool.json with this triangle opportunity
              appendJson('tri_pool.json', {
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool.pairAddr, pool2.pairAddr, pool3.pairAddr],
                dexs,
                cycleRate,
                edge: edgeTri,
                estProfitUSD,
                source: 'swap_event'
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Swap handler error:', e?.message || e);
    }
  });
}

// === MAIN LOGIC ===
(async () => {
  await ready(); // ensure WebSocket is open before any contract calls

  const allPools = [];

  // Fetch pools from each DEX
  for (const dex of dexConfig.polygon) {
    const dexName = dex.name;
    if (!dex.factory || dex.factory === '0x...' || !FACTORIES[dexName]) {
      console.log(`Skipping ${dexName} — no valid factory`);
      continue;
    }

    const { address: factoryAddr, abi } = FACTORIES[dexName];

    if (!factoryAddr || !abi || abi.length === 0) {
      console.log(`Skipping ${dexName} — no ABI`);
      continue;
    }

    console.log(`Fetching pairs for ${dexName}...`);
    const pairs = await fetchPairs(factoryAddr, abi);
    console.log(`${dexName}: Found ${pairs.length} pairs`);

    for (const pairAddr of pairs) {
      try {
        const info = await getPairInfo(pairAddr);
        allPools.push({ dex: dexName, ...info });
      } catch (_) {}
    }
  }

  const allTokens = [...new Set(allPools.flatMap(p => [p.token0, p.token1]))];
  console.log(`Total unique tokens: ${allTokens.length}`);

  // Get token prices
  const prices = await getTokenPrices(allTokens);

  // Filter pools based on liquidity
  const filteredPools = allPools.filter(p => {
    const p0 = prices[p.token0.toLowerCase()]?.usd || 0;
    const p1 = prices[p.token1.toLowerCase()]?.usd || 0;
    const liquidityUSD =
      p0 * Number(p.reserve0) / (10 ** 18) +
      p1 * Number(p.reserve1) / (10 ** 18);
    return liquidityUSD >= MIN_LIQUIDITY_USD;
  });

  /** --------------------------------------------------------------
   *  Build indexes for SAME-PAIR matching and start Swap listeners
   *  ------------------------------------------------------------*/
  const poolsByPairKey = {};
  const poolsByAddr = {};
  const poolsByToken = {};
  for (const p of filteredPools) {
    const key = pairKey(p.token0, p.token1);
    (poolsByPairKey[key] ||= []).push(p);
    poolsByAddr[p.pairAddr.toLowerCase()] = p;
    (poolsByToken[p.token0] ||= []).push(p);
    (poolsByToken[p.token1] ||= []).push(p);
  }
  startSwapWatch(
    Object.keys(poolsByAddr),
    poolsByAddr,
    poolsByPairKey,
    poolsByToken,
    ARB_THRESHOLD
  );

  // Calculate direct arbitrage
  const directArbs = [];
  for (let i = 0; i < filteredPools.length; i++) {
    for (let j = i + 1; j < filteredPools.length; j++) {
      const poolA = filteredPools[i];
      const poolB = filteredPools[j];
      const samePair =
        (poolA.token0 === poolB.token0 && poolA.token1 === poolB.token1) ||
        (poolA.token0 === poolB.token1 && poolA.token1 === poolB.token0);

      if (samePair) {
        const priceA = calcPrice(poolA.reserve0, poolA.reserve1);
        const priceB = calcPrice(poolB.reserve0, poolB.reserve1);
        const edge = estimateDirectEdge(priceA, priceB, poolA.dex, poolB.dex);
        if (edge > 0) {
          const estProfitUSD = edgeToProfitUSD(edge);
          if (estProfitUSD >= MIN_PROFIT_USD) {
            const rec = {
              token0: poolA.token0,
              token1: poolA.token1,
              dexA: poolA.dex,
              dexB: poolB.dex,
              priceA,
              priceB,
              poolAddrA: poolA.pairAddr,
              poolAddrB: poolB.pairAddr,
              edge,
              estProfitUSD
            };
            directArbs.push(rec);
          }
        }
      }
    }
  }

  // Calculate triangular arbitrage
  const triArbs = [];
  const poolsByTokenScan = {};

  for (const pool of filteredPools) {
    [pool.token0, pool.token1].forEach(t => {
      poolsByTokenScan[t] = poolsByTokenScan[t] || [];
      poolsByTokenScan[t].push(pool);
    });
  }

  for (const tokenA of Object.keys(poolsByTokenScan)) {
    for (const pool1 of poolsByTokenScan[tokenA]) {
      const tokenB = pool1.token0 === tokenA ? pool1.token1 : pool1.token0;
      for (const pool2 of poolsByTokenScan[tokenB] || []) {
        const tokenC = pool2.token0 === tokenB ? pool2.token1 : pool2.token0;
        if (tokenC === tokenA) continue;
        for (const pool3 of poolsByTokenScan[tokenC] || []) {
          const closesLoop =
            (pool3.token0 === tokenC && pool3.token1 === tokenA) ||
            (pool3.token1 === tokenC && pool3.token0 === tokenA);
          if (!closesLoop) continue;

          const rate1 = calcPrice(pool1.reserve0, pool1.reserve1);
          const rate2 = calcPrice(pool2.reserve0, pool2.reserve1);
          const rate3 = calcPrice(pool3.reserve0, pool3.reserve1);
          const cycleRate = rate1 * rate2 * rate3;

          const dexs = [pool1.dex, pool2.dex, pool3.dex];
          const edge = estimateTriEdge(cycleRate, dexs);

          if (edge > 0) {
            const estProfitUSD = edgeToProfitUSD(edge);
            if (estProfitUSD >= MIN_PROFIT_USD) {
              triArbs.push({
                route: [tokenA, tokenB, tokenC, tokenA],
                pools: [pool1.pairAddr, pool2.pairAddr, pool3.pairAddr],
                dexs,
                cycleRate,
                edge,
                estProfitUSD
              });
            }
          }
        }
      }
    }
  }

  // Sort results by profit
  directArbs.sort((a, b) => (b.estProfitUSD - a.estProfitUSD));
  triArbs.sort((a, b) => (b.estProfitUSD - a.estProfitUSD));

  // Save results to JSON files
  fs.writeFileSync('direct_pool.json', JSON.stringify(directArbs, null, 2));
  fs.writeFileSync('tri_pool.json', JSON.stringify(triArbs, null, 2));

  console.log(`Saved ${directArbs.length} direct and ${triArbs.length} triangular arbs (>= $${MIN_PROFIT_USD})`);
})();
