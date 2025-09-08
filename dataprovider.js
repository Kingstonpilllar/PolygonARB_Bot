// ESM + ethers v6
import 'dotenv/config';
import { ethers } from 'ethers';

// ---------- CONSTANTS ----------
const CHAIN_ID = 137; // Polygon mainnet

// ---------- READ-ONLY (HARDCODED) ----------
const READ_RPC_URLS = [
  'https://polygon-mainnet.g.alchemy.com/v2/C3-3l0i9jKmV2y_07pPCd',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon-rpc.com',
  'https://rpc-mainnet.matic.network',
  'https://matic-mainnet.chainstacklabs.com'
];

let _rIdx = 0;
let _read = new ethers.JsonRpcProvider(READ_RPC_URLS[_rIdx], { chainId: CHAIN_ID, name: 'polygon' });
_read.pollingInterval = 1500;

// subscribe registry so listeners can be reattached on failover
const _subs = []; // { kind: 'block'|'log', handler, filter? }

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
  _read = new ethers.JsonRpcProvider(READ_RPC_URLS[_rIdx], { chainId: CHAIN_ID, name: 'polygon' });
  _read.pollingInterval = 1500;
  // reattach listeners
  for (const s of _subs) {
    if (s.kind === 'block') _read.on('block', s.handler);
    else _read.on(s.filter, s.handler);
  }
  return _read;
}

export function getReadProvider() {
  return _read;
}

export async function readFailover() {
  console.warn('♻️ READ failover rotating RPC…');
  return _rotateRead();
}

export function startReadWatchdog(intervalMs = 1500, threshold = 3) {
  let fails = 0;
  setInterval(async () => {
    try {
      await _read.getBlockNumber();
      fails = 0;
    } catch {
      if (++fails >= threshold) {
        fails = 0;
        _rotateRead();
      }
    }
  }, intervalMs);
}

// ---------- WRITE (TX) VIA .env ONLY ----------
const WRITE_RPC_URL = process.env.WRITE_RPC_URL || process.env.RPC_URL || null;
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').trim() || null;

let _write = null;
function _ensureWrite() {
  if (!_write) {
    if (!WRITE_RPC_URL) throw new Error('Missing WRITE_RPC_URL (or RPC_URL) in .env');
    _write = new ethers.JsonRpcProvider(WRITE_RPC_URL);
  }
  return _write;
}

export function getWriteProvider() {
  return _ensureWrite();
}

export function getSigner() {
  if (!PRIVATE_KEY) throw new Error('Missing PRIVATE_KEY in .env');
  return new ethers.Wallet(PRIVATE_KEY, _ensureWrite());
}

// ---------- OPTIONAL: MISMATCH GUARD ----------
/**
 * Ensures both read and write providers (if write configured) are on Polygon (137).
 * Throws if mismatch is detected.
 */
export async function verifySameChain() {
  const readNet = await _read.getNetwork();
  if (readNet.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`Read provider chainId ${readNet.chainId} != ${CHAIN_ID}`);
  }
  if (WRITE_RPC_URL) {
    const writeNet = await _ensureWrite().getNetwork();
    if (writeNet.chainId !== BigInt(CHAIN_ID)) {
      throw new Error(`Write provider chainId ${writeNet.chainId} != ${CHAIN_ID} (check WRITE_RPC_URL)`);
    }
  }
}
