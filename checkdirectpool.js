import fs from "fs";
import path from "path";
import { listenTelegramAlerts, sendTelegramAlert } from "./telegramalert.js";

const DIRECT_POOL_FILE = path.join(process.cwd(), "direct_pool.json");

// Helper: load JSON safely
function loadDirectPool() {
  try {
    if (fs.existsSync(DIRECT_POOL_FILE)) {
      return JSON.parse(fs.readFileSync(DIRECT_POOL_FILE, "utf8"));
    }
    return [];
  } catch (err) {
    console.error("[DirectPool] Failed to read JSON:", err.message);
    return [];
  }
}

// Helper: save JSON safely
function saveDirectPool(pool) {
  try {
    fs.writeFileSync(DIRECT_POOL_FILE, JSON.stringify(pool, null, 2));
  } catch (err) {
    console.error("[DirectPool] Failed to save JSON:", err.message);
  }
}

// Delete tradeId from direct_pool.json
export function removeFromDirectPool(type, tradeId) {
  try {
    let pool = loadDirectPool();
    const before = pool.length;
    pool = pool.filter(item => item.id !== tradeId);

    if (pool.length !== before) {
      saveDirectPool(pool);
      console.log(`[DirectPool] Removed ${type} tradeId: ${tradeId}`);
      sendTelegramAlert(`${getEmoji(type)} ${capitalize(type)} trade ${tradeId} removed from direct_pool.json`);
    } else {
      console.log(`[DirectPool] TradeId not found: ${tradeId}`);
      sendTelegramAlert(`⚠️ Trade ${tradeId} not found in direct_pool.json`);
    }
  } catch (err) {
    console.error("[DirectPool] Error processing trade:", err.message);
  }
}

// Emoji by trade type
function getEmoji(type) {
  switch (type) {
    case "successful":
      return "✅";
    case "skip":
      return "⏭️";
    case "fail":
      return "❌";
    default:
      return "ℹ️";
  }
}

// Capitalize first letter
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 🔥 Listen for Telegram alerts and remove trades from pool
listenTelegramAlerts(({ type, tradeId }) => {
  if (["successful", "skip", "fail"].includes(type)) {
    removeFromDirectPool(type, tradeId);
  }
});
