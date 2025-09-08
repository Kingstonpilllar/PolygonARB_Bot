// hybridsimulationbot.js — Ethers v6, 15 logics intact (NO WebSockets)

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import sendAlert from './telegramalert.js';
import protection from './protectionutilities.js';
import aaveABI from './aaveABI.json';
import balancerABI from './balancerABI.json';
import { startBlockFeed } from './dataprovider.js'; // NEW (replaces websocket listener)

dotenv.config();
console.log('[ETHERS]', ethers.version);

// ===========================================================
// 0) Run updateconfig.js safely
// ===========================================================
async function runUpdateConfig() {
  try {
    const updater = await import('./updateconfig.js');
    if (typeof updater.default === 'function') {
      console.log('[INIT] Running updateconfig.js...');
      await updater.default();
      console.log('[INIT] updateconfig.js finished.');
    } else {
      console.log('[INIT] updateconfig.js found but no default export. Skipping.');
    }
  } catch (e) {
    console.warn('[INIT] No updateconfig.js or failed to run. Reason:', e.message);
  }
}
runUpdateConfig();

// ===========================================================
// 1) Constants & Env
// ===========================================================
const CHAIN_ID         = Number(process.env.CHAIN_ID || '137');
const PROFIT_USD       = Number(process.env.PROFIT_THRESHOLD_USD || '40');
const BOT_INTERVAL_MS  = Number(process.env.BOT_INTERVAL_MS || '5000');
const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || '50');

const RPC_URLS = (process.env.RPC_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!RPC_URLS.length) throw new Error('RPC_URLS is empty');

// ===========================================================
// 2) Providers (HTTP base + private TX endpoint)
// ===========================================================
const rpcProviders = RPC_URLS.map(u => new ethers.JsonRpcProvider(u, { name: 'polygon', chainId: CHAIN_ID }));
const baseProvider = rpcProviders[0];

const RUBIC_RPC_URL    = process.env.RUBIC_RPC_URL    || 'https://rubic-polygon.rpc.blxrbdn.com';
const MERKLE_RPC_URL   = process.env.MERKLE_RPC_URL   || 'https://polygon.merkle.io/';
const GETBLOCK_RPC_URL = process.env.GETBLOCK_RPC_URL || 'https://go.getblock.us/...';

let txProvider = new ethers.JsonRpcProvider(RUBIC_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });
// In v6, HTTP providers don’t have socket/error lifecycle; rely on send-time fallback.
function setPrivateTransactionProvider() {
  txProvider = new ethers.JsonRpcProvider(RUBIC_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });
}
setPrivateTransactionProvider();

// ===========================================================
// 3) Data provider (HTTP polling; NO WebSockets)
// ===========================================================
function listenForBlocks() {
  // Poll every 15s for new blocks and invoke pipeline
  return startBlockFeed(baseProvider, 15_000, async (blockNumber) => {
    console.log('⛓️ New block (HTTP):', blockNumber);
    try {
      await processTransactions(); // Logic 1–7 + 10–15 fire within
    } catch (e) {
      console.error('❌ processTransactions error from HTTP feed:', e.message);
    }
  });
}

// ===========================================================
// 4) Wallet & Contracts
// ===========================================================
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
let wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, baseProvider) : null;
if (wallet) console.log(`[BOT] Wallet loaded: ${wallet.address}`);

const aaveContract = new ethers.Contract(process.env.AAVE_FLASHLOAN_CONTRACT, aaveABI, wallet || txProvider);
const balancerContract = new ethers.Contract(process.env.BALANCER_FLASHLOAN_CONTRACT, balancerABI, wallet || txProvider);

// ===========================================================
// 5) Decimals helper
// ===========================================================
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
async function getTokenDecimals(provider, tokenAddress) {
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return 18;
  try {
    const erc = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, provider);
    return await erc.decimals();
  } catch {
    return 18;
  }
}

// ===========================================================
// 6) Process Transactions
// ===========================================================
async function processTransactions() {
  try {
    // Logic 1: Load configs fresh
    const { routers, tokenList, priceFeeds, directPools, triPools } = loadAllConfigsFresh();
    const allPools = [...directPools, ...triPools];

    for (const pool of allPools) {
      // Logic 2: Run all protection checks
      const passed = await protection.runAllChecks(pool, { routers, tokenList, priceFeeds });
      if (!passed) {
        await sendAlert(`⛔ Trade skipped (failed protections) Pool: ${pool.token0} → ${pool.token1}`);
        continue;
      }

      // Logic 3: Estimate profit (pre-trade)
      const estProfit = await protection.estimateProfitUSD(pool, { routers, tokenList, priceFeeds });

      // Logic 4: Skip if below profit threshold
      if (estProfit < PROFIT_USD) {
        await sendAlert(`⚠️ Trade skipped (low profit) Pool: ${pool.token0} → ${pool.token1} | Est: $${estProfit.toFixed(2)} < $${PROFIT_USD}`);
        continue;
      }

      // Logic 5: Use real decimals for loanAmount
      const loanDec = await getTokenDecimals(baseProvider, pool.loanAsset);

      // Logic 6: Build steps (routes & paths)
      const params = {
        loanAsset: pool.loanAsset,
        loanAmount: ethers.parseUnits(pool.amount.toString(), loanDec),
        steps: buildSteps(pool, routers, tokenList, priceFeeds)
      };

      // Logic 7: Slippage is embedded in buildSteps via calcMinOut()

      // Logic 8–15 happen in executor
      await executeWithFallback(params, pool, estProfit);
    }
  } catch (e) {
    console.error('❌ processTransactions error:', e.message);
  }
}

// ===========================================================
// 7) Load configs
// ===========================================================
function loadAllConfigsFresh() {
  const routers     = safeRequireJson('./routers.json') || {};
  const tokenList   = safeRequireJson('./tokenlist.json') || [];
  const priceFeeds  = safeRequireJson('./chainlinkpricefeed.json') || {};
  const directPools = safeRequireJson('./direct_pool.json') || [];
  const triPools    = safeRequireJson('./tri_pool.json') || [];
  return { routers, tokenList, priceFeeds, directPools, triPools };
}

function safeRequireJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf-8')); }
  catch (_) { return null; }
}

// ===========================================================
// 8) Build Steps  (Logic 6 & 7)
// ===========================================================
function buildSteps(pool, routers, _tokenList, _priceFeeds) {
  const steps = [];
  const minOut = calcMinOut(pool.amount);
  if (pool._type === 0) {
    steps.push({
      kind: 0,
      router: routers[pool.router] || pool.router,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerBack] || pool.router,
      path: [pool.token1, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut
    });
  } else {
    steps.push({
      kind: 0,
      router: routers[pool.routerA] || pool.routerA,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerB] || pool.routerB,
      path: [pool.token1, pool.token2],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerC] || pool.routerA,
      path: [pool.token2, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: '0x',
      minAmountOut: minOut
    });
  }
  return steps;
}

// ===========================================================
// 9) Slippage calculation (Logic 7)
// ===========================================================
function calcMinOut(amount) {
  const amt = ethers.parseUnits(amount.toString(), 18);
  const slippage = BigInt(10000 - MAX_SLIPPAGE_BPS);
  return (amt * slippage) / 10000n;
}

// ===========================================================
// 10) Execute with fallback (Aave + Balancer)
//      Logic 8: Gas gate
//      Logic 9: Nonce management
//      Logic 11–12: Aave populate/send/wait/profit
//      Logic 13–14: Balancer populate/send/wait/profit
//      Logic 15: Compare profits & final alerts
// ===========================================================
async function executeWithFallback(params, pool, estProfit) {
  if (!wallet) return console.error('❌ Wallet required for sending TXs');

  let txAave, txBal;
  let profitA = 0, profitB = 0;

  // Logic 9: Nonce management
  const baseNonce = await wallet.getNonce();

  // Logic 8: Skip trade if gas > profit
  async function shouldSkipForGas(txReq, profitEst) {
    try {
      const gasLimit   = await baseProvider.estimateGas({ ...txReq, from: wallet.address });
      const feeData    = await baseProvider.getFeeData();
      const gasPrice   = feeData.gasPrice ?? 0n;
      const gasCostWei = BigInt(gasLimit) * gasPrice;
      const gasEth     = Number(ethers.formatUnits(gasCostWei, 18));
      const priceUsd   = Number(process.env.ETH_PRICE_USD || '2500'); // keep existing logic
      const gasCostUsd = gasEth * priceUsd;
      console.log(`⛽ Gas: ${gasLimit} | Cost ≈ $${gasCostUsd.toFixed(2)} | Profit ≈ $${profitEst.toFixed(2)}`);
      return gasCostUsd > profitEst;
    } catch {
      return false;
    }
  }

  // Logic 11–12: Aave execution
  try {
    const txAReq = await aaveContract.populateTransaction.executeArbitrage(params);
    txAReq.chainId ??= CHAIN_ID;
    txAReq.nonce   = baseNonce;

    if (await shouldSkipForGas(txAReq, estProfit)) {
      await sendAlert(`⛔ Skipped Aave trade: Gas > Profit | Pool: ${pool.token0} → ${pool.token1}`);
    } else {
      txAave = await sendWithRpcFallback(txAReq, baseNonce);
      if (txAave?.wait) await txAave.wait();
      // Re-estimate post-trade profit in isolated scope
      profitA = await protection.estimateProfitUSD(pool, { routers: {}, tokenList: {}, priceFeeds: {} });
      await sendAlert(`✅ Aave trade executed | Profit: $${profitA.toFixed(2)} | TX: ${txAave?.hash ?? 'submitted'}`);
    }
  } catch (e) {
    await sendAlert(`⚠️ Aave execution failed | Reason: ${e.message}`);
  }

  // Logic 13–14: Balancer execution
  try {
    const txBReq = await balancerContract.populateTransaction.executeArbitrage(params);
    txBReq.chainId ??= CHAIN_ID;
    txBReq.nonce   = baseNonce + 1;

    if (await shouldSkipForGas(txBReq, estProfit)) {
      await sendAlert(`⛔ Skipped Balancer trade: Gas > Profit | Pool: ${pool.token0} → ${pool.token1}`);
    } else {
      txBal = await sendWithRpcFallback(txBReq, baseNonce + 1);
      if (txBal?.wait) await txBal.wait();
      profitB = await protection.estimateProfitUSD(pool, { routers: {}, tokenList: {}, priceFeeds: {} });
      await sendAlert(`✅ Balancer trade executed | Profit: $${profitB.toFixed(2)} | TX: ${txBal?.hash ?? 'submitted'}`);
    }
  } catch (e) {
    await sendAlert(`⚠️ Balancer execution failed | Reason: ${e.message}`);
  }

  // Logic 15: Compare profits / final alert
  if (!txAave && !txBal) {
    await sendAlert(`⛔ Trade failed completely | Pool: ${pool.token0} → ${pool.token1}`);
  } else if (txAave && txBal) {
    if (profitA > profitB) {
      await sendAlert(`📊 Aave outperformed Balancer | Aave: $${profitA.toFixed(2)} | Balancer: $${profitB.toFixed(2)}`);
    } else if (profitB > profitA) {
      await sendAlert(`📊 Balancer outperformed Aave | Aave: $${profitA.toFixed(2)} | Balancer: $${profitB.toFixed(2)}`);
    } else {
      await sendAlert(`📊 Aave and Balancer equal | Profit: $${profitA.toFixed(2)}`);
    }
  }
}

// ===========================================================
// 11) RPC send fallback (Logic 10) — TRUE PRIVATE BROADCAST
// ===========================================================
const PRIVATE_RPC_TIMEOUT_MS = Number(process.env.PRIVATE_RPC_TIMEOUT_MS || 5000);

async function sendWithRpcFallback(txReq, nonce) {
  // Ensure chainId/nonce are set exactly as your logic expects
  txReq.chainId ??= CHAIN_ID;
  txReq.nonce   ??= nonce;

  // 1) Populate fees/limits ONCE using the baseProvider tied to wallet
  const populated = await wallet.populateTransaction({
    ...txReq,
    // preserve any fee fields already present in txReq
  });

  // 2) Sign once (offline). Deterministic raw transaction.
  const signedRaw = await wallet.signTransaction(populated);

  // 3) Try private relays in order with per-endpoint timeout
  const order = [
    { name: 'Rubic',    url: RUBIC_RPC_URL },
    { name: 'Merkle',   url: MERKLE_RPC_URL },
    { name: 'GetBlock', url: GETBLOCK_RPC_URL },
  ];

  let lastError = null;

  for (const item of order) {
    try {
      const prov = new ethers.JsonRpcProvider(item.url, { name: 'polygon', chainId: CHAIN_ID });
      const txHash = await sendRawWithTimeout(prov, signedRaw, PRIVATE_RPC_TIMEOUT_MS);
      console.log(`🚀 Sent via ${item.name}: ${txHash}`);
      // Return a tx-like object with wait() for Logic 11–15 compatibility
      return {
        hash: txHash,
        wait: async (confirms = 1) => baseProvider.waitForTransaction(txHash, confirms),
      };
    } catch (e) {
      lastError = e;
      console.warn(`⚠️ ${item.name} send failed: ${e?.message || e}`);
    }
  }

  throw new Error(`All private RPC sends failed. Last error: ${lastError?.message ?? 'unknown'}`);
}

/**
 * Low-level raw broadcast with timeout against a single provider.
 * Uses eth_sendRawTransaction to keep it PRIVATE and identical across endpoints.
 */
async function sendRawWithTimeout(provider, signedRaw, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`send timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    provider
      .send('eth_sendRawTransaction', [signedRaw])
      .then((txHash) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(txHash);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = String(err?.message || err);
        if (msg.includes('already known') || msg.includes('nonce too low')) {
          try {
            const maybeHash = /0x[0-9a-fA-F]{64}/.exec(msg)?.[0];
            if (maybeHash) return resolve(maybeHash);
          } catch {}
        }
        reject(err);
      });
  });
}

// ===========================================================
// 12) Start bot
// ===========================================================
console.log('[BOT] hybridSimulationBot running (Ethers v6, 15 logics intact; NO WebSockets)');
const stopFeed = listenForBlocks(); // HTTP-backed block feed
setInterval(processTransactions, BOT_INTERVAL_MS);
