require("dotenv").config();
const axios = require("axios");
const EventEmitter = require("events");

// ----- helpers -----
function pickEnvByChain(baseKey, chainId) {
  const perChain = process.env[`${baseKey}__${chainId}`];
  return perChain || process.env[baseKey];
}

function getCfg(chainId) {
  const token = pickEnvByChain("TELEGRAM_BOT_TOKEN", chainId);
  const chatIdsRaw = pickEnvByChain("TELEGRAM_CHAT_ID", chainId);
  const threadIdRaw = pickEnvByChain("TELEGRAM_THREAD_ID", chainId);

  const chatIds = (chatIdsRaw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const threadId = threadIdRaw ? Number(threadIdRaw) : undefined;

  return { token, chatIds, threadId };
}

function escapeMarkdownV2(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function chunkMessage(text, maxLen = 4000) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

// ----- main sender -----
async function sendTelegramAlert(message, opts = {}) {
  const chainId = opts.chainId ?? process.env.CHAIN_ID;
  const { token, chatIds: envChatIds, threadId: envThreadId } = getCfg(chainId);

  const chatIds = Array.isArray(opts.chatIds) && opts.chatIds.length
    ? opts.chatIds
    : envChatIds;
  const threadId = typeof opts.threadId === "number" ? opts.threadId : envThreadId;

  if (!token || !chatIds.length) {
    console.error("[TELEGRAM] Missing token or chat id(s). Set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID.");
    return;
  }

  const parseMode = opts.parseMode || "Markdown";
  const disableWebPagePreview = !!opts.disablePreview;
  const disableNotification = !!opts.disableNotification;
  const finalText = parseMode === "MarkdownV2"
    ? escapeMarkdownV2(message)
    : String(message);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const chunks = chunkMessage(finalText);

  for (const chat_id of chatIds) {
    for (const part of chunks) {
      const payload = {
        chat_id,
        text: part,
        parse_mode: parseMode,
        disable_web_page_preview: disableWebPagePreview,
        disable_notification: disableNotification,
      };
      if (typeof threadId === "number") payload.message_thread_id = threadId;

      try {
        await axios.post(url, payload, { timeout: 15000 });
        console.log(`[TELEGRAM] Sent to ${chat_id}${threadId ? `#${threadId}` : ""}: ${part.slice(0, 80)}${part.length > 80 ? "…" : ""}`);
      } catch (err) {
        const msg = err?.response?.data?.description || err.message;
        console.error(`[TELEGRAM] Failed for ${chat_id}: ${msg}`);
      }
    }
  }
}

// ----- NEW: shared event emitter -----
const alertEmitter = new EventEmitter();

async function sendAndEmit(message, opts = {}) {
  await sendTelegramAlert(message, opts);

  const text = message.toLowerCase();
  let type = null;
  if (text.includes("successful trade")) type = "successful";
  if (text.includes("skip trade")) type = "skip";
  if (text.includes("fail trade")) type = "fail";

  if (type) {
    const match = message.match(/id[:\s]*([a-zA-Z0-9_-]+)/i);
    const tradeId = match ? match[1] : null;

    if (tradeId) {
      // 🔥 Broadcast to both listeners (direct_pool + tri_pool)
      alertEmitter.emit("alert", { type, tradeId });
      console.log(`📩 Local Alert -> type: ${type}, tradeId: ${tradeId}`);
    }
  }
}

// ----- subscription API -----
function listenTelegramAlerts(callback) {
  alertEmitter.on("alert", callback);
}

// ----- exports -----
module.exports = Object.assign(sendAndEmit, {
  sendTelegramAlert: sendAndEmit,
  send: sendAndEmit,
  listenTelegramAlerts,
});
