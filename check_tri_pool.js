// check_tri_pool.js
const fs = require("fs");
const path = require("path");
const { listenTelegramAlerts, sendTelegramAlert } = require("./telegramalert.js");

const TRI_POOL_FILE = path.join(__dirname, "tri_pool.json");

// Helper: load JSON safely (resilient)
function loadTriPool() {
  try {
    if (fs.existsSync(TRI_POOL_FILE)) {
      return JSON.parse(fs.readFileSync(TRI_POOL_FILE, "utf8"));
    }
    return [];
  } catch (err) {
    console.error("[TriPool] Failed to read JSON:", err.message);
    return [];
  }
}

// Helper: save JSON safely (resilient)
function saveTriPool(pool) {
  try {
    fs.writeFileSync(TRI_POOL_FILE, JSON.stringify(pool, null, 2));
  } catch (err) {
    console.error("[TriPool] Failed to save JSON:", err.message);
  }
}

// Delete tradeId from tri_pool.json
function removeFromTriPool(type, tradeId) {
  try {
    let pool = loadTriPool();
    const before = pool.length;
    pool = pool.filter(item => item.id !== tradeId);

    if (pool.length !== before) {
      saveTriPool(pool);
      console.log(`[TriPool] Removed ${type} tradeId: ${tradeId}`);
      sendTelegramAlert(`${getEmoji(type)} ${capitalize(type)} trade ${tradeId} removed from tri_pool.json`);
    } else {
      console.log(`[TriPool] TradeId not found: ${tradeId}`);
      sendTelegramAlert(`⚠️ Trade ${tradeId} not found in tri_pool.json`);
    }
  } catch (err) {
    console.error("[TriPool] Error processing trade:", err.message);
  }
}

// Emoji by trade type
function getEmoji(type) {
  if (type === "successful") return "✅";
  if (type === "skip") return "⏭️";
  if (type === "fail") return "❌";
  return "ℹ️";
}

// Capitalize first letter
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 🔥 Listen for alerts (resilient)
listenTelegramAlerts(({ type, tradeId }) => {
  if (["successful", "skip", "fail"].includes(type)) {
    removeFromTriPool(type, tradeId);
  }
});
