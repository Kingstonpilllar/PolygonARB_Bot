// dataproviders.js
// ESM + ethers v6
import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';

// ---------- CONSTANTS ----------
const CHAIN_ID = 137; // Polygon mainnet

// ---------- HARDCODED READ RPCs ----------
const READ_RPC_URLS = [
  'https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.network',
  'https://matic-mainnet.chainstacklabs.com'
];

if (!READ_RPC_URLS.length) {
  throw new Error('READ_RPC_URLS is empty - add at least one RPC URL');
}

// helper: set polling interval if provider supports it (ethers v6 -> pollingInterval)
function _setProviderPolling(provider, ms) {
  if (!provider || !ms) return;
  try {
    // ethers v6: use pollingInterval
    provider.pollingInterval = ms;
  } catch {
    /* ignore */
  }
}

// start from a random read RPC index
let _rIdx = Math.floor(Math.random() * READ_RPC_URLS.length);
let _read = new JsonRpcProvider(READ_RPC_URLS[_rIdx], CHAIN_ID);
_setProviderPolling(_read, 1500);

// subscribe registry so listeners can be reattached on failover
const _subs = []; // { kind: 'block'|'log', handler, filter? }

// keep original call order: attach first, then record
export function addBlockListener(handler) {
  _read.on('block', handler);
  _subs.push({ kind: 'block', handler });
}

export function addLogListener(filter, handler) {
  _read.on(filter, handler);
  _subs.push({ kind: 'log', filter, handler });
}

function _rotateRead() {
  _rIdx = (_rIdx + 1) % READ_RPC_URLS.length;
  _read = new JsonRpcProvider(READ_RPC_URLS[_rIdx], CHAIN_ID);
  _setProviderPolling(_read, 1500);

  // reattach listeners in the same order they were added originally
  for (const s of _subs) {
    if (s.kind === 'block') {
      _read.on('block', s.handler);
    } else {
      _read.on(s.filter, s.handler);
    }
  }
  return _read;
}

export function getReadProvider() {
  return _read;
}

export async function readFailover() {
  console.warn('READ failover rotating RPC…');
  return _rotateRead();
}

export function startReadWatchdog(intervalMs = 1500, threshold = 3) {
  let fails = 0;
  setInterval(async () => {
    try {
      await _read.getBlockNumber();
      fails = 0;
    } catch (err) {
      if (++fails >= threshold) {
        console.warn('Watchdog rotating READ provider after repeated failures');
        fails = 0;
        _rotateRead();
      }
    }
  }, intervalMs);
}

// ---------- HARDCODED WRITE RPCs ----------
const WRITE_RPC_URLS = [
  'https://polygon-rpc.com',
  'https://polygon-bor-rpc.publicnode.com'
];

const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim() || null;

let _wIdx = WRITE_RPC_URLS.length ? Math.floor(Math.random() * WRITE_RPC_URLS.length) : 0;
let _write = null;

function _makeWriteProvider() {
  if (!WRITE_RPC_URLS.length) {
    throw new Error('WRITE_RPC_URLS is empty - add at least one write RPC URL');
  }
  const url = WRITE_RPC_URLS[_wIdx];
  const provider = new JsonRpcProvider(url, CHAIN_ID);
  _setProviderPolling(provider, 1500);
  return provider;
}

function _ensureWrite() {
  if (!_write) _write = _makeWriteProvider();
  return _write;
}

function _rotateWrite() {
  if (!WRITE_RPC_URLS.length) {
    throw new Error('No WRITE RPCs to rotate');
  }
  _wIdx = (_wIdx + 1) % WRITE_RPC_URLS.length;
  _write = _makeWriteProvider();
  return _write;
}

export function getWriteProvider() {
  return _ensureWrite();
}

export function getSigner() {
  if (!PRIVATE_KEY) throw new Error('Missing PRIVATE_KEY in .env');
  return new Wallet(PRIVATE_KEY, _ensureWrite());
}

export async function writeFailover() {
  console.warn('WRITE failover rotating RPC…');
  return _rotateWrite();
}

export function startWriteWatchdog(intervalMs = 3000, threshold = 3) {
  if (!WRITE_RPC_URLS.length) {
    console.warn('No WRITE RPCs configured; write watchdog disabled');
    return;
  }
  let fails = 0;
  setInterval(async () => {
    try {
      await _ensureWrite().getBlockNumber();
      fails = 0;
    } catch (err) {
      if (++fails >= threshold) {
        console.warn('Watchdog rotating WRITE provider after repeated failures');
        fails = 0;
        _rotateWrite();
      }
    }
  }, intervalMs);
}

// ---------- OPTIONAL: MISMATCH GUARD ----------
export async function verifySameChain() {
  const readNet = await _read.getNetwork();
  if (readNet.chainId !== CHAIN_ID) {
    throw new Error(`Read provider chainId ${readNet.chainId} != ${CHAIN_ID}`);
  }
  if (WRITE_RPC_URLS.length) {
    const writeNet = await _ensureWrite().getNetwork();
    if (writeNet.chainId !== CHAIN_ID) {
      throw new Error(`Write provider chainId ${writeNet.chainId} != ${CHAIN_ID} (check WRITE_RPC_URLS)`);
    }
  }
}
