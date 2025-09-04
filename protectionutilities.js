// protectionutilities.js

// 11 safety/profit protections + WEBSOCKET FALLBACK + FLASH TOKEN FALLBACK + CHAINLINK USD CHECK

require("dotenv").config();

const fs = require("fs");
const { ethers } = require("ethers");

// ---------- ENV CONFIG ----------
const PROFIT_THRESHOLD_BPS = Number(process.env.PROFIT_THRESHOLD_BPS || 100);
const PROFIT_THRESHOLD_USD = Number(process.env.PROFIT_THRESHOLD_USD || 0);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3000);

const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || 100);
const HIGH_GAS_GWEI = ethers.parseUnits(process.env.HIGH_GAS_GWEI || "300", "gwei");
const GAS_LIMIT_MAX = BigInt(process.env.GAS_LIMIT_MAX || "2000000");
const GAS_PRICE_TIMEOUT_MS = Number(process.env.GAS_PRICE_TIMEOUT_MS || 1200);
const ESTIMATE_GAS_TIMEOUT_MS = Number(process.env.ESTIMATE_GAS_TIMEOUT_MS || 1800);

const MEV_FILE = process.env.MEV_FILE || "./mev_queue.json";
const MEV_LOOKBACK_MS = Number(process.env.MEV_LOOKBACK_MS || 10_000);

// ---------- WebSocket Providers ----------
const WS_URLS = (process.env.WS_URLS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const wsProviders = WS_URLS.map(url => new ethers.WebSocketProvider(url));

if (wsProviders.length === 0) {
  throw new Error("❌ No WebSocket URLs found in .env (example: WS_URLS=wss://alchemy...,wss://quiknode...)");
}

let _wsRingIdx = 0;
async function wsCallWithFallback(label, callFn, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 1200);
  const startIdx = _wsRingIdx % wsProviders.length;

  const withTimeout = (p) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error("ws_timeout")), timeoutMs)),
    ]);

  for (let i = 0; i < wsProviders.length; i++) {
    const idx = (startIdx + i) % wsProviders.length;
    const prov = wsProviders[idx];
    try {
      const res = await withTimeout(callFn(prov));
      _wsRingIdx++;
      return { ok: true, result: res, provider: prov };
    } catch {}
  }
  return { ok: false, error: `ws_fallback_failed:${label}` };
}

// ---------- FLASH-LOAN TOKEN FALLBACK CONFIG ----------
const FLASH_FALLBACK_TOKENS = (process.env.FLASH_FALLBACK_TOKENS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

function _resolveFlashFallbackTokens(runtimeList) {
  const list = (runtimeList && runtimeList.length ? runtimeList : FLASH_FALLBACK_TOKENS);
  return list.slice(0, 5);
}

// ---------- ABIs ----------
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];

const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const V3_POOL_ABI = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,int24 observationIndex,int24 observationCardinality,int24 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const AGG_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

// ---------- STATE ----------
const lastActionAt = new Map();

// ============= 11 PROTECTIONS =============

// 1) SLIPPAGE
function validateSlippage(expectedOut, minOut) {
  if (expectedOut <= 0n) return { ok: false, slippageBps: 10000, reason: "expectedOut<=0" };
  const diff = expectedOut - minOut;
  const slippageBps = diff <= 0n ? 0 : Number((diff * 10000n) / expectedOut);
  return { ok: minOut <= expectedOut && slippageBps <= MAX_SLIPPAGE_BPS, slippageBps, maxSlippageBps: MAX_SLIPPAGE_BPS };
}

// 2) GAS
async function assessGas(txRequest) {
  const gp = await wsCallWithFallback("gasPrice", p => p.getFeeData().then(fd => fd.gasPrice), { timeoutMs: GAS_PRICE_TIMEOUT_MS });
  if (!gp.ok) return { ok: false, reason: "gasPriceFail" };
  const gasPrice = txRequest.gasPrice ?? gp.result;
  if (gasPrice > HIGH_GAS_GWEI) return { ok: false, reason: "gasPriceTooHigh", gasPrice };

  const eg = await wsCallWithFallback("estimateGas", p => p.estimateGas(txRequest), { timeoutMs: ESTIMATE_GAS_TIMEOUT_MS });
  const gasLimit = txRequest.gasLimit ?? (eg.ok ? eg.result : 0n);
  if (gasLimit === 0n) return { ok: false, reason: "gasEstimationFailed" };
  if (gasLimit > GAS_LIMIT_MAX) return { ok: false, reason: "gasLimitTooHigh", gasLimit };
  return { ok: true, gasPrice, gasLimit };
}

// 3) PROFIT THRESHOLD (simple USD inputs)
function meetsProfitThresholdUSD(profitUsd, notionalUsd) {
  if (!Number.isFinite(profitUsd) || !Number.isFinite(notionalUsd) || notionalUsd <= 0)
    return { ok: false, reason: "invalidInputs", thresholdBps: PROFIT_THRESHOLD_BPS, thresholdUsd: PROFIT_THRESHOLD_USD };
  const profitBps = (profitUsd / notionalUsd) * 10000;
  return { ok: profitBps >= PROFIT_THRESHOLD_BPS && profitUsd >= PROFIT_THRESHOLD_USD, profitBps, profitUsd };
}

// 3b) PROFIT THRESHOLD via CHAINLINK feeds
async function meetsProfitThresholdUSD_Chainlink(provider, { profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap }) {
  try {
    async function fetchPrice(token) {
      const feedAddr = feedMap?.[token];
      if (!feedAddr) return null;
      const c = new ethers.Contract(feedAddr, AGG_V3_ABI, provider);
      const [dec, rd] = await Promise.all([c.decimals(), c.latestRoundData()]);
      return Number(rd[1]) / 10 ** dec;
    }

    const [profitPrice, notionalPrice] = await Promise.all([
      fetchPrice(profitToken),
      fetchPrice(notionalToken),
    ]);

    if (!profitPrice || !notionalPrice) {
      return { ok: false, reason: "missingFeed" };
    }

    const profitUsd = Number(ethers.formatUnits(profitAmountWei, 18)) * profitPrice;
    const notionalUsd = Number(ethers.formatUnits(notionalAmountWei, 18)) * notionalPrice;

    return meetsProfitThresholdUSD(profitUsd, notionalUsd);
  } catch {
    return { ok: false, reason: "chainlinkError" };
  }
}

// 4) COOLDOWN
function enforceCooldown(key) {
  const now = Date.now();
  const last = lastActionAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return { ok: false, msRemaining: COOLDOWN_MS - (now - last) };
  lastActionAt.set(key, now);
  return { ok: true };
}

// 5) FLASHLOAN AVAILABILITY (Aave + Balancer controlled via .env)
async function isFlashLoanAvailable(candidates = []) {
  const AAVE_LOAN = (process.env.AAVE_LOAN || "false").toLowerCase() === "true";
  const BAL_LOAN  = (process.env.BAL_LOAN || "false").toLowerCase() === "true";

  if (!AAVE_LOAN && !BAL_LOAN) {
    return { ok: false, reason: "loansDisabledInEnv" };
  }

  let aaveOk = false;
  let balOk = false;

  async function checkBalance(token, addr, needed) {
    for (const p of wsProviders) {
      try {
        const bal = await new ethers.Contract(token, ERC20_ABI, p).balanceOf(addr);
        if (bal >= BigInt(needed)) return true;
      } catch {}
    }
    return false;
  }

  if (AAVE_LOAN) {
    const aaveCandidates = candidates.filter(c => c.type === "aave");
    for (const c of aaveCandidates) {
      if (await checkBalance(c.token, c.addr, c.needed)) {
        aaveOk = true;
        break;
      }
    }
  }

  if (BAL_LOAN) {
    const balCandidates = candidates.filter(c => c.type === "balancer");
    for (const c of balCandidates) {
      if (await checkBalance(c.token, c.addr, c.needed)) {
        balOk = true;
        break;
      }
    }
  }

  if (aaveOk || balOk) {
    return { ok: true, aave: aaveOk, balancer: balOk };
  } else {
    return { ok: false, reason: "noLiquidity", aave: aaveOk, balancer: balOk };
  }
}

// 6) FALLBACK TOKEN
async function chooseFallbackToken(wallet, tokens, minAmt = 0n) {
  for (const t of tokens) {
    const res = await wsCallWithFallback(`erc20.balanceOf:${t}`, p => new ethers.Contract(t, ERC20_ABI, p).balanceOf(wallet));
    if (res.ok && res.result > minAmt) return { ok: true, token: t, balance: res.result };
  }
  return { ok: false };
}

// 7) WALLET BALANCE
async function hasWalletBalance(wallet, token, needed) {
  const minRequiredWei = BigInt(needed);
  if (token === ethers.ZeroAddress) {
    const bal = await wsCallWithFallback("getBalance", p => p.getBalance(wallet));
    return { ok: bal.ok && bal.result >= minRequiredWei, balance: bal.result };
  }
  const erc = await wsCallWithFallback(`erc20.balanceOf:${token}`, p => new ethers.Contract(token, ERC20_ABI, p).balanceOf(wallet));
  return { ok: erc.ok && erc.result >= minRequiredWei, balance: erc.result };
}

// 8) PROFIT LOCK
function lockProfit(profitUsd, lockPct = 0.75) {
  if (!Number.isFinite(profitUsd) || profitUsd <= 0) return { locked: 0, leftover: 0 };
  return { locked: profitUsd * lockPct, leftover: profitUsd * (1 - lockPct) };
}

// 9) V2 RESERVES
async function getV2Reserves(pair) {
  const res = await wsCallWithFallback(`v2.getReserves:${pair}`, async p => {
    const c = new ethers.Contract(pair, V2_PAIR_ABI, p);
    const [t0, t1, [r0, r1, ts]] = await Promise.all([c.token0(), c.token1(), c.getReserves()]);
    return { token0: t0, token1: t1, r0, r1, tsLast: Number(ts), ts: Date.now() };
  });
  return res.ok ? res.result : null;
}

// 10) V3 STATE
async function getV3State(pool) {
  const res = await wsCallWithFallback(`v3.slot0:${pool}`, async p => {
    const c = new ethers.Contract(pool, V3_POOL_ABI, p);
    const [slot0, liquidity, t0, t1] = await Promise.all([c.slot0(), c.liquidity(), c.token0(), c.token1()]);
    return { token0: t0, token1: t1, sqrtPriceX96: slot0.sqrtPriceX96, liquidity, ts: Date.now() };
  });
  return res.ok ? res.result : null;
}

// 11) MEV RISK
function isMEVRisk() {
  try {
    if (!fs.existsSync(MEV_FILE)) return { risk: false };
    const q = JSON.parse(fs.readFileSync(MEV_FILE, "utf-8"));
    const now = Date.now();
    return { risk: q.some(e => now - (e.timestamp || 0) < MEV_LOOKBACK_MS) };
  } catch { return { risk: true }; }
}

// ---------- COMPOSED GUARD ----------
async function runProtections(params) {
  const { routeKey, expectedOut, minOut, txRequest,
    profitUsd, notionalUsd, profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap,
    wallet, v2PairAddr, v3PoolAddr,
    fallbackTokens = [], neededBalance, flashCandidates = [] } = params;

  if (!enforceCooldown(routeKey).ok) return { ok: false, reason: "cooldown" };
  if (isMEVRisk().risk) return { ok: false, reason: "mevRisk" };

  const slip = validateSlippage(expectedOut, minOut);
  if (!slip.ok) return { ok: false, reason: "slippage", details: slip };

  let pt;
  if (Number.isFinite(profitUsd) && Number.isFinite(notionalUsd)) {
    pt = meetsProfitThresholdUSD(profitUsd, notionalUsd);
  } else {
    pt = await meetsProfitThresholdUSD_Chainlink(wsProviders[0], { profitToken, profitAmountWei, notionalToken, notionalAmountWei, feedMap });
  }
  if (!pt.ok) return { ok: false, reason: "profitBelowThreshold", details: pt };

  const gas = await assessGas(txRequest);
  if (!gas.ok) return { ok: false, reason: "gasBad", details: gas };

  if (neededBalance?.token) {
    const wb = await hasWalletBalance(wallet, neededBalance.token, neededBalance.amountWei);
    if (!wb.ok) return { ok: false, reason: "insufficientBalance", details: wb };
  }

  if (flashCandidates.length) {
    const fl = await isFlashLoanAvailable(flashCandidates);
    if (!fl.ok) return { ok: false, reason: "flashNotAvailable", details: fl };
  }

  const reserves = v2PairAddr ? await getV2Reserves(v2PairAddr) : v3PoolAddr ? await getV3State(v3PoolAddr) : null;
  const fallback = fallbackTokens.length ? await chooseFallbackToken(wallet, fallbackTokens) : null;
  const lock = lockProfit(pt.profitUsd || profitUsd || 0, 0.75);

  return { ok: true, details: { slip, pt, gas, reserves, fallback, lock } };
}

// ---------- EXPORT ----------
module.exports = {
  validateSlippage,
  assessGas,
  meetsProfitThresholdUSD,
  meetsProfitThresholdUSD_Chainlink,
  enforceCooldown,
  isFlashLoanAvailable,
  chooseFallbackToken,
  hasWalletBalance,
  lockProfit,
  getV2Reserves,
  getV3State,
  isMEVRisk,
  runProtections
};
