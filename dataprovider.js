// ESM + ethers v6
import 'dotenv/config';
import { ethers } from 'ethers';

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

// start from a random read RPC
let _rIdx = Math.floor(Math.random() * READ_RPC_URLS.length);
let _read = new ethers.JsonRpcProvider(READ_RPC_URLS[_rIdx], CHAIN_ID);
_read.setPollingInterval(1500);

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
  _read = new ethers.JsonRpcProvider(READ_RPC_URLS[_rIdx], CHAIN_ID);
  _read.setPollingInterval(1500);

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
  console.warn('READ failover rotating RPC…');
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

// start from a random write RPC
let _wIdx = Math.floor(Math.random() * WRITE_RPC_URLS.length);
let _write = null;

function _makeWriteProvider() {
  const url = WRITE_RPC_URLS[_wIdx];
  console.log(`Using WRITE RPC: ${url}`);
  const provider = new ethers.JsonRpcProvider(url, CHAIN_ID);
  provider.setPollingInterval(1500);
  return provider;
}

function _ensureWrite() {
  if (!_write) _write = _makeWriteProvider();
  return _write;
}

function _rotateWrite() {
  _wIdx = (_wIdx + 1) % WRITE_RPC_URLS.length;
  _write = _makeWriteProvider();
  return _write;
}

export function getWriteProvider() {
  return _ensureWrite();
}

export function getSigner() {
  if (!PRIVATE_KEY) throw new Error('Missing PRIVATE_KEY in .env');
  return new ethers.Wallet(PRIVATE_KEY, _ensureWrite());
}

export async function writeFailover() {
  console.warn('WRITE failover rotating RPC…');
  return _rotateWrite();
}

export function startWriteWatchdog(intervalMs = 3000, threshold = 3) {
  let fails = 0;
  setInterval(async () => {
    try {
      await _ensureWrite().getBlockNumber();
      fails = 0;
    } catch {
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
  if (readNet.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`Read provider chainId ${readNet.chainId} != ${CHAIN_ID}`);
  }
  if (WRITE_RPC_URLS.length) {
    const writeNet = await _ensureWrite().getNetwork();
    if (writeNet.chainId !== BigInt(CHAIN_ID)) {
      throw new Error(`Write provider chainId ${writeNet.chainId} != ${CHAIN_ID} (check WRITE_RPC_URLS)`);
    }
  }
}
