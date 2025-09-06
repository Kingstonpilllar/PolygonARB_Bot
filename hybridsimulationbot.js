require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const sendAlert = require('./telegramalert.js');
// ❌ Flashbots removed

// ===========================================================
// 0) Run updateconfig.js safely
// ===========================================================
async function runUpdateConfig() {
  try {
    const updater = require('./updateconfig.js');
    if (typeof updater === 'function') {
      console.log('[INIT] Running updateconfig.js...');
      await updater();
      console.log('[INIT] updateconfig.js finished.');
    } else {
      console.log('[INIT] updateconfig.js found but no default function export. Skipping.');
    }
  } catch (e) {
    console.warn('[INIT] No updateconfig.js or failed to run. Reason:', e.message);
  }
}
runUpdateConfig();

// ===========================================================
// 1) Imports that depend on env/config
// ===========================================================
const protection = require('./protectionutilities.js');


let factories = null;
try { factories = require('./factories.js'); } catch (_) {}

// ===========================================================
// 2) Env & constants
// ===========================================================
const CHAIN_ID = Number(process.env.CHAIN_ID || '137');
const PROFIT_USD = Number(process.env.PROFIT_THRESHOLD_USD || '40');
const BOT_INTERVAL_MS = Number(process.env.BOT_INTERVAL_MS || '5000');
const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || '50');

const RPC_URLS = (process.env.RPC_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const WS_URLS = (process.env.WS_URLS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!RPC_URLS.length) throw new Error('RPC_URLS is empty');

// ===========================================================
// 3) Providers (multi-RPC + Private RPC fallback)
// ===========================================================
const rpcProviders = RPC_URLS.map(u => new ethers.JsonRpcProvider(u, { name: 'polygon', chainId: CHAIN_ID }));
const baseProvider = rpcProviders[0];

// Private tx provider fallback (used for sending)
const RUBIC_RPC_URL = process.env.RUBIC_RPC_URL || 'https://rubic-polygon.rpc.blxrbdn.com';
const MERKLE_RPC_URL = process.env.MERKLE_RPC_URL || 'https://polygon.merkle.io/';
const GETBLOCK_RPC_URL = process.env.GETBLOCK_RPC_URL || 'https://go.getblock.us/…';

let txProvider = new ethers.JsonRpcProvider(RUBIC_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });

function setPrivateTransactionProvider() {
  txProvider = new ethers.JsonRpcProvider(RUBIC_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });
  txProvider.on('error', () => {
    console.log('⚠️ Rubic RPC failed, switching to Merkle...');
    txProvider = new ethers.JsonRpcProvider(MERKLE_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });
    txProvider.on('error', () => {
      console.log('⚠️ Merkle RPC failed, switching to GetBlock...');
      txProvider = new ethers.JsonRpcProvider(GETBLOCK_RPC_URL, { name: 'polygon', chainId: CHAIN_ID });
    });
  });
}
setPrivateTransactionProvider();

// ===========================================================
// 4) WebSocket listener for new blocks (with failover)
// ===========================================================
let wsIndex = 0;
let wsProvider = new ethers.WebSocketProvider(WS_URLS[wsIndex], { name: 'polygon', chainId: CHAIN_ID });

function switchWsProvider() {
  wsIndex = (wsIndex + 1) % WS_URLS.length;
  wsProvider = new ethers.WebSocketProvider(WS_URLS[wsIndex], { name: 'polygon', chainId: CHAIN_ID });
  console.log(`🔄 Switched WS provider to: ${WS_URLS[wsIndex]}`);
}

async function listenForBlocks() {
  try {
    wsProvider.on("block", async (blockNumber) => {
      console.log("⛓️ New block:", blockNumber);
      await processTransactions();
    });
  } catch (error) {
    console.error(`[WS] Error: ${error.message}`);
    switchWsProvider();
    listenForBlocks();
  }
}

// ===========================================================
// 5) Wallet & contracts
// ===========================================================
const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
let wallet = null;

if (PRIVATE_KEY) {
  wallet = new ethers.Wallet(PRIVATE_KEY, baseProvider);
  console.log(`[BOT] Wallet loaded: ${wallet.address}`);
} else {
  console.warn('[BOT] PRIVATE_KEY is blank. Scanning only.');
}

const aaveABI = require('./aaveABI.json');
const balancerABI = require('./balancerABI.json');

const aaveContract = new ethers.Contract(process.env.AAVE_FLASHLOAN_CONTRACT, aaveABI, wallet || txProvider);
const balancerContract = new ethers.Contract(process.env.BALANCER_FLASHLOAN_CONTRACT, balancerABI, wallet || txProvider);

// ===========================================================
// 5.1) Decimals helper (new; does not touch your logics)
// ===========================================================
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];

async function getTokenDecimals(provider, tokenAddress) {
  if (!tokenAddress || tokenAddress === ethers.ZeroAddress) return 18; // default fallback
  try {
    const erc = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, provider);
    return await erc.decimals();
  } catch {
    return 18; // safe fallback if token misbehaves
  }
}

// ===========================================================
// 6) Process transactions (with protections)
// ===========================================================
async function processTransactions() {
  try {
    const { routers, tokenList, priceFeeds, directPools, triPools } = loadAllConfigsFresh();
    const allPools = [...directPools, ...triPools];

    for (let pool of allPools) {
      const passed = await protection.runAllChecks(pool, { routers, tokenList, priceFeeds });
      if (!passed) {
        const msg = `⛔ Trade skipped (failed protections)\nPool: ${pool.token0} → ${pool.token1}`;
        console.log(msg);
        await sendAlert(msg);
        continue;
      }

      const estProfit = await protection.estimateProfitUSD(pool, { routers, tokenList, priceFeeds });
      if (estProfit < PROFIT_USD) {
        const msg = `⚠️ Trade skipped (low profit)\nPool: ${pool.token0} → ${pool.token1}\nProfit est: $${estProfit.toFixed(2)} < $${PROFIT_USD}`;
        console.log(msg);
        await sendAlert(msg);
        continue;
      }

      // UPDATED: real decimals for loanAmount (logic order untouched)
      const loanDec = await getTokenDecimals(baseProvider, pool.loanAsset);
      const params = {
        loanAsset: pool.loanAsset,
        loanAmount: ethers.parseUnits(pool.amount.toString(), loanDec),
        steps: buildSteps(pool, routers, tokenList, priceFeeds)
      };

      await executeWithFallback(params, pool, estProfit);
    }
  } catch (e) {
    console.error("❌ Error in processTransactions:", e.message);
  }
}

// ===========================================================
// 7) Load configs
// ===========================================================
function loadAllConfigsFresh() {
  const routers = safeRequireJson('./routers.json') || {};
  const tokenList = safeRequireJson('./tokenlist.json') || [];
  const priceFeeds = safeRequireJson('./chainlinkpricefeed.json') || {};
  const directPools = safeRequireJson('./direct_pool.json') || [];
  const triPools = safeRequireJson('./tri_pool.json') || [];
  return { routers, tokenList, priceFeeds, directPools, triPools };
}

function safeRequireJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf-8'));
  } catch (_) {
    return null;
  }
}

// ===========================================================
// 8) Reassign ownership if necessary
// ===========================================================
async function ensureOwnershipIfNeeded() {
  // Ownership checks go here
}

// ===========================================================
// 9) Main loop
// ===========================================================
async function scanAndExecute() {
  try {
    const { routers, tokenList, priceFeeds, directPools, triPools } = loadAllConfigsFresh();
    if (!wallet) return;

    await ensureOwnershipIfNeeded();

    const opps = [...directPools.map(p => ({ ...p, _type: 0 })), ...triPools.map(p => ({ ...p, _type: 1 }))];
    const runList = opps.sort((a, b) => (b.estProfitUSD ?? 0) - (a.estProfitUSD ?? 0));

    for (const opp of runList) {
      const passed = await protection.runAllChecks(opp, { routers, tokenList, priceFeeds });
      if (!passed) {
        const msg = `⛔ Trade skipped (failed protections)\nOpp: ${opp.token0} → ${opp.token1}`;
        console.log(msg);
        await sendAlert(msg);
        continue;
      }

      const estProfit = await protection.estimateProfitUSD(opp, { routers, tokenList, priceFeeds });
      if (estProfit < PROFIT_USD) {
        const msg = `⚠️ Trade skipped (low profit)\nOpp: ${opp.token0} → ${opp.token1}\nProfit est: $${estProfit.toFixed(2)} < $${PROFIT_USD}`;
        console.log(msg);
        await sendAlert(msg);
        continue;
      }

      // UPDATED: real decimals for loanAmount (logic order untouched)
      const loanDec = await getTokenDecimals(baseProvider, opp.loanAsset);
      const params = {
        loanAsset: opp.loanAsset,
        loanAmount: ethers.parseUnits(opp.amount.toString(), loanDec),
        steps: buildSteps(opp, routers, tokenList, priceFeeds)
      };

      await executeWithFallback(params, opp, estProfit);
    }
  } catch (e) {
    console.error('[SCAN] Error:', e.message);
  }
}

// ===========================================================
// 10) Build steps
// ===========================================================
function buildSteps(pool, routers, tokenList, priceFeeds) {
  const steps = [];
  const minOut = calcMinOut(pool.amount);

  if (pool._type === 0) {
    steps.push({
      kind: 0,
      router: routers[pool.router] || pool.router,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: "0x",               // ⬅️ renamed from v3PathBytes
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerBack] || pool.router,
      path: [pool.token1, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: "0x",               // ⬅️ renamed from v3PathBytes
      minAmountOut: minOut
    });
  } else if (pool._type === 1) {
    steps.push({
      kind: 0,
      router: routers[pool.routerA] || pool.routerA,
      path: [pool.token0, pool.token1],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: "0x",               // ⬅️ renamed from v3PathBytes
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerB] || pool.routerB,
      path: [pool.token1, pool.token2],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: "0x",               // ⬅️ renamed from v3PathBytes
      minAmountOut: minOut
    });
    steps.push({
      kind: 0,
      router: routers[pool.routerC] || pool.routerA,
      path: [pool.token2, pool.token0],
      v3Fee: 0,
      v3ExactInputSingle: false,
      v3Path: "0x",               // ⬅️ renamed from v3PathBytes
      minAmountOut: minOut
    });
  }

  return steps;
}

// ===========================================================
// 11) Slippage control
// ===========================================================
function calcMinOut(amount) {
  const amt = ethers.parseUnits(amount.toString(), 18);
  const slippage = BigInt(10000 - MAX_SLIPPAGE_BPS);
  return (amt * slippage) / BigInt(10000);
}

// ===========================================================
// 12) Telegram alerts
// ===========================================================
// Already integrated

// ===========================================================
// 13) Emoji-tagged alerts
// ===========================================================
// Already integrated

// ===========================================================
// 14) Selective execution
// 15) Gas > Profit Skip
// ===========================================================
async function executeWithFallback(params, pool, estProfit) {
  if (!wallet) {
    console.error("❌ Wallet required for sending TXs");
    return;
  }

  let txAave, txBal;
  let profitA = 0, profitB = 0;

  let baseNonce = await wallet.getNonce();

  // Logic 15: Gas Estimation Helper (unchanged)
  async function shouldSkipForGas(txReq, profitEst) {
    try {
      const gasLimit = await baseProvider.estimateGas({ ...txReq, from: wallet.address });
      const gasPrice = await baseProvider.getFeeData();
      const gasCostEth = BigInt(gasLimit) * BigInt(gasPrice.gasPrice || 0n);
      const gasCostUsd = Number(ethers.formatUnits(gasCostEth, "ether")) * (process.env.ETH_PRICE_USD || 2500);
      console.log(`⛽ Gas: ${gasLimit.toString()} | Cost ≈ $${gasCostUsd.toFixed(2)} | Profit ≈ $${profitEst.toFixed(2)}`);
      return gasCostUsd > profitEst;
    } catch (err) {
      console.warn("⚠️ Gas estimation failed:", err.message);
      return false;
    }
  }

  // Aave Execution (send path uses 3-RPC fallback)
  try {
    const txAReq = await aaveContract.populateTransaction.executeArbitrage(params);
    txAReq.nonce = baseNonce;

    if (await shouldSkipForGas(txAReq, estProfit)) {
      await sendAlert(`⛔ Skipped Aave trade: Gas > Profit | Pool: ${pool.token0} → ${pool.token1}`);
    } else {
      txAave = await sendWithRpcFallback(txAReq, baseNonce);
      if (txAave && txAave.wait) await txAave.wait();
      profitA = await protection.estimateProfitUSD(pool, { routers: {}, tokenList: {}, priceFeeds: {} });
      await sendAlert(`✅ Aave trade executed | Profit: $${profitA.toFixed(2)} | TX: ${txAave?.hash || 'submitted'}`);
    }
  } catch (e) {
    await sendAlert(`⚠️ Aave execution failed | Reason: ${e.message}`);
  }

  // Balancer Execution (send path uses 3-RPC fallback)
  try {
    const txBReq = await balancerContract.populateTransaction.executeArbitrage(params);
    txBReq.nonce = baseNonce + 1;

    if (await shouldSkipForGas(txBReq, estProfit)) {
      await sendAlert(`⛔ Skipped Balancer trade: Gas > Profit | Pool: ${pool.token0} → ${pool.token1}`);
    } else {
      txBal = await sendWithRpcFallback(txBReq, baseNonce + 1);
      if (txBal && txBal.wait) await txBal.wait();
      profitB = await protection.estimateProfitUSD(pool, { routers: {}, tokenList: {}, priceFeeds: {} });
      await sendAlert(`✅ Balancer trade executed | Profit: $${profitB.toFixed(2)} | TX: ${txBal?.hash || 'submitted'}`);
    }
  } catch (e) {
    await sendAlert(`⚠️ Balancer execution failed | Reason: ${e.message}`);
  }

  // Compare
  if (!txAave && !txBal) {
    await sendAlert(`⛔ Trade failed completely | Pool: ${pool.token0} → ${pool.token1}`);
  }
  if (txAave && txBal) {
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
// RPC send fallback (Rubic -> Merkle -> GetBlock)
// ===========================================================
async function sendWithRpcFallback(txReq, nonce) {
  const order = [
    { name: 'Rubic',   url: RUBIC_RPC_URL },
    { name: 'Merkle',  url: MERKLE_RPC_URL },
    { name: 'GetBlock',url: GETBLOCK_RPC_URL }
  ];

  txReq.chainId = txReq.chainId ?? CHAIN_ID;
  txReq.nonce = nonce;

  let lastError = null;

  for (const item of order) {
    try {
      const prov = new ethers.JsonRpcProvider(item.url, { name: 'polygon', chainId: CHAIN_ID });
      const w = new ethers.Wallet(PRIVATE_KEY, prov);

      // Optional: set fees here if desired
      // const fee = await prov.getFeeData();
      // txReq.maxFeePerGas = txReq.maxFeePerGas ?? fee.maxFeePerGas ?? fee.gasPrice;
      // txReq.maxPriorityFeePerGas = txReq.maxPriorityFeePerGas ?? fee.maxPriorityFeePerGas ?? 0n;

      const tx = await w.sendTransaction(txReq);
      console.log(`🚀 Sent via ${item.name}: ${tx.hash}`);
      return tx;
    } catch (e) {
      lastError = e;
      console.warn(`⚠️ ${item.name} send failed: ${e.message}`);
      continue;
    }
  }

  throw new Error(`All RPC sends failed. Last error: ${lastError?.message || 'unknown'}`);
}

// ===========================================================
// Start bot
// ===========================================================
console.log('[BOT] hybridsimulationbot running (15 logics: protections + alerts + gas skip).'); // Flashbots removed
listenForBlocks();
setInterval(scanAndExecute, BOT_INTERVAL_MS);

