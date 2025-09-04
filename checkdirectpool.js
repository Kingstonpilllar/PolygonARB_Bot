// checkdirectpool.js
const fs = require("fs");
const path = require("path");
const { listenTelegramAlerts, sendTelegramAlert } = require("./telegramalert.js");

const DIRECT_POOL_FILE = path.join(__dirname, "direct_pool.json");

// Helper: load JSON safely (resilient)
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

// Helper: save JSON safely (resilient)
function saveDirectPool(pool) {
  try {
    fs.writeFileSync(DIRECT_POOL_FILE, JSON.stringify(pool, null, 2));
  } catch (err) {
    console.error("[DirectPool] Failed to save JSON:", err.message);
  }
}

// Delete tradeId from direct_pool.json
function removeFromDirectPool(type, tradeId) {
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
    removeFromDirectPool(type, tradeId);
  }
});
