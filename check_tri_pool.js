// check_tri_pool.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listenTelegramAlerts, sendTelegramAlert } from "./telegramalert.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRI_POOL_FILE = path.join(__dirname, "tri_pool.json");

// Read JSON → always return an array of trades
function loadTriPool() {
  try {
    if (!fs.existsSync(TRI_POOL_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(TRI_POOL_FILE, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.trades)) return parsed.trades;
    return [];
  } catch (err) {
    console.error("[TriPool] Failed to read JSON:", err.message);
    return [];
  }
}

// Save array back. If original file had {trades:[]}, we still write array (simpler).
function saveTriPool(pool) {
  try {
    fs.writeFileSync(TRI_POOL_FILE, JSON.stringify(pool, null, 2));
  } catch (err) {
    console.error("[TriPool] Failed to save JSON:", err.message);
  }
}

function normalizeId(x) {
  // Support id / tradeId, number/string
  if (!x) return null;
  if (typeof x === "object") x = x.tradeId ?? x.id ?? null;
  if (x == null) return null;
  return String(x).trim();
}

function getEmoji(type) {
  switch (type) {
    case "successful": return "✅";
    case "skip":       return "⏭️";
    case "fail":       return "❌";
    default:           return "ℹ️";
  }
}

function cap(s) {
  return typeof s === "string" && s.length ? s[0].toUpperCase() + s.slice(1) : "";
}

function removeFromTriPool(typeRaw, tradeIdRaw) {
  try {
    const type = (typeRaw || "").toString().trim().toLowerCase();
    const tradeId = normalizeId(tradeIdRaw);
    if (!tradeId) {
      console.warn("[TriPool] Missing tradeId in alert, ignoring.");
      return;
    }

    let pool = loadTriPool();
    const before = pool.length;

    // Support both id keys in file
    pool = pool.filter(item => {
      const itemId = normalizeId(item);
      return itemId !== tradeId;
    });

    if (pool.length !== before) {
      saveTriPool(pool);
      console.log(`[TriPool] Removed ${type || "info"} tradeId: ${tradeId}`);
      // fire-and-forget; if your send function returns a promise it's fine to not await
      try { sendTelegramAlert(`${getEmoji(type)} ${cap(type) || "Info"} trade ${tradeId} removed from tri_pool.json`); } catch {}
    } else {
      console.log(`[TriPool] TradeId not found: ${tradeId}`);
      try { sendTelegramAlert(`⚠️ Trade ${tradeId} not found in tri_pool.json`); } catch {}
    }
  } catch (err) {
    console.error("[TriPool] Error processing trade:", err.message);
  }
}

// 🔥 Listen for alerts
// Be resilient to different payload shapes
listenTelegramAlerts?.((payload) => {
  try {
    // Accept: { type, tradeId } or { status, id } or raw string JSON
    let data = payload;
    if (typeof payload === "string") {
      try { data = JSON.parse(payload); } catch { data = { type: payload }; }
    }
    const type = (data?.type ?? data?.status ?? "").toString().toLowerCase();
    const tradeId = data?.tradeId ?? data?.id ?? null;

    if (["successful", "skip", "fail"].includes(type) && tradeId != null) {
      removeFromTriPool(type, tradeId);
    } else {
      // Not our event—ignore quietly
    }
  } catch (e) {
    console.error("[TriPool] Listener error:", e.message);
  }
});
