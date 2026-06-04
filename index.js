const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

// ============================================================
// 环境变量
// ============================================================
const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_VERIFICATION_TOKEN,
  DEEPSEEK_API_KEY,
  FEISHU_BOT_CHAT_ID,
  PORT = 3000,
} = process.env;

// ============================================================
// 工具函数
// ============================================================
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const logError = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.3 + otherChars / 3.5);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 相对时间
function relativeTime(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 30) return "刚刚";
  if (sec < 60) return "1分钟前";
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`;
  if (sec < 7200) return "1小时前";
  return `${Math.floor(sec / 3600)}小时前`;
}

// ============================================================
// 消息去重
// ============================================================
const processedMessages = new Set();
const MAX_DEDUP_SIZE = 1000;

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_DEDUP_SIZE) {
    let count = 0;
    for (const id of processedMessages) {
      if (count >= MAX_DEDUP_SIZE / 2) break;
      processedMessages.delete(id);
      count++;
    }
  }
  return false;
}

// ============================================================
// 会话历史 + 文件持久化
// 每条消息格式: { role, content, time: timestamp }
// ============================================================
const STORE_FILE = path.join(__dirname, ".conversation_store.json");
const conversationStore = new Map();

const MAX_MESSAGES = 20;           // 最多保留 20 条
const MAX_HISTORY_TOKENS = 6000;   // token 上限
const RECENT_MINUTES = 30;         // 只取最近 30 分钟的消息（保底至少 4 条）
const EXPIRE_MINUTES = 60;

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      const data = JSON.parse(raw);
      for (const [chatId, conv] of Object.entries(data)) {
        if (Date.now() - conv.lastActive <= EXPIRE_MINUTES * 60 * 1000) {
          // 兼容旧格式：没有 time 字段的消息补上时间戳
          conv.messages = (conv.messages || []).map(m => ({
            role: m.role,
            content: m.content,
            time: m.time || conv.lastActive || Date.now(),
          }));
          conversationStore.set(chatId, conv);
        }
      }
      log(`从文件恢复了 ${conversationStore.size} 个会话`);
    }
  } catch (err) {
    logError("恢复会话失败:", err.message);
  }
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(conversationStore)), "utf-8");
    } catch (err) {
      logError("保存会话失败:", err.message);
    }
  }, 1000);
}

// 获取历史：只取最近 RECENT_MINUTES 分钟内的消息，标注相对时间，不足 4 条时取最近 4 条
function getHistory(chatId) {
  const conv = conversationStore.get(chatId);
  if (!conv) return [];
  if (Date.now() - conv.lastActive > EXPIRE_MINUTES * 60 * 1000) {
    conversationStore.delete(chatId);
    saveStore();
    return [];
  }

  const now = Date.now();
  const windowMs = RECENT_MINUTES * 60 * 1000;
  const allMessages = conv.messages;

  // 标注时间
  const annotated = allMessages.map(m => ({
    role: m.role,
    content: `[${relativeTime(m.time)}] ${m.content}`,
    time: m.time,
  }));

  // 取窗口内的消息
  const recent = annotated.filter(m => now - m.time <= windowMs);

  // 保底：至少保留最近 4 条（可能跨窗口）
  if (recent.length < 4 && annotated.length > recent.length) {
    const older = annotated
      .filter(m => now - m.time > windowMs)
      .slice(-(4 - recent.length));
    return [...older, ...recent];
  }

  return recent;
}

function addHistory(chatId, role, content) {
  let conv = conversationStore.get(chatId);
  if (!conv) {
    conv = { messages: [], lastActive: Date.now() };
    conversationStore.set(chatId, conv);
  }
  conv.messages.push({ role, content, time: Date.now() });
  conv.lastActive = Date.now();

  // 硬上限
  while (conv.messages.length > MAX_MESSAGES) {
    conv.messages.shift();
  }
  // Token 裁剪
  while (conv.messages.length > 2) {
    const total = conv.messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    if (total <= MAX_HISTORY_TOKENS) break;
    conv.messages.shift();
  }
  saveStore();
}

function clearHistory(chatId) {
  conversationStore.delete(chatId);
  saveStore();
}

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [chatId, conv] of conversationStore) {
    if (now - conv.lastActive > EXPIRE_MINUTES * 60 * 1000) {
      conversationStore.delete(chatId);
      log("清理过期会话:", chatId);
    }
  }
  saveStore();
  log(`会话状态: ${conversationStore.size} 活跃, ${processedMessages.size} 去重`);
}, 10 * 60 * 1000);

// ============================================================
// 飞书 Access Token
// ============================================================
let tenantAccessToken = null;
let tokenExpireAt = 0;
let tokenPromise = null;

async function getTenantAccessToken() {
  if (tenantAccessToken && Date.now() < tokenExpireAt - 120000) {
    return tenantAccessToken;
  }
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    try {
      const { data } = await axios.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
        { headers: { "Content-Type": "application/json" }, timeout: 10000 }
      );
      if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg}`);
      tenantAccessToken = data.tenant_access_token;
      tokenExpireAt = Date.now() + data.expire * 1000;
      log("飞书 Token 已刷新");
      return tenantAccessToken;
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

// ============================================================
// 提取文本
// ============================================================
function extractText(content) {
  if (!content) return "";
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    if (parsed.text) return parsed.text;
    if (parsed.content) {
      return parsed.content
        .flatMap((b) => b.map((seg) => seg.text || ""))
        .join("");
    }
  } catch {
    return String(content);
  }
  return String(content);
}

// ============================================================
// System Prompt —— 动态时间 + 近期上下文串联策略
// ============================================================
function buildSystemPrompt() {
  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    `现在时间是 ${timeStr}（北京时间）。`,
    "",
    "你是 CLIBOT，刘倩的 AI 助手，通过飞书文字消息交流。",
    "",
    "## ⛔ 绝对禁止 —— 违反即失败",
    "你是一个纯文本对话模型。你没有任何接口或权限访问以下系统：",
    "- 飞书（ Lark）—— 日历、日程、会议、消息记录、文档、审批、考勤等",
    "- 任何数据库、API、外部系统",
    "- 刘倩的真实工作数据",
    "",
    "因此以下行为绝对禁止，一次都不行：",
    "❌ 编造会议时间、地点、参会人、会议内容",
    "❌ 编造日程安排（如「你周一上午9点有个会」）",
    "❌ 编造文档内容（如「你有一份关于XX的报告」）",
    "❌ 编造任何人发给你的消息或邮件",
    "❌ 编造任何看起来像「真实数据」的信息",
    "❌ 猜测刘倩的工作安排、会议内容、项目进展",
    "",
    "✅ 正确做法：被问到这类问题时，一句话说清楚即可。",
    "例如：「这个我查不到真实数据哦，你可以用 Claude Code 来查飞书日历。」",
    "然后可以基于常识给出通用建议（比如怎么高效开会），但要明确标注这只是通用建议，不是你查到的。",
    "如果用户问的不是飞书数据，而是知识/建议/写作/分析/代码类问题，正常回答。",
    "",
    "## 对话上下文",
    "每条历史消息前有 [X分钟前] 时间标签。",
    "1. [刚刚]~[5分钟前] 的消息是同一轮对话，有多个问题就全部回复",
    "2. 用户纠正/补充的信息要用来完成前面的请求（比如先问日程，后补充日期）",
    "3. [30分钟前] 以上的旧消息不主动关联，除非用户明确引用",
    "",
    "## 风格",
    "亲切自然、有主见、默认简洁、复杂问题可深入。用中文。适度表情符号。",
    "飞书是纯文本，不要用 Markdown 格式。",
  ].join("\n");
}

// ============================================================
// Markdown 清理
// ============================================================
function cleanMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, (m) => {
      const code = m.replace(/```\w*\n?/g, "").replace(/```/g, "").trim();
      return code ? `「${code}」` : "";
    })
    .replace(/`([^`]+)`/g, "「$1」")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "· ")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "———")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// 调用 AI（动态 prompt + 近期限流历史）
// ============================================================
async function callAI(userMessage, history = []) {
  const messages = [...history, { role: "user", content: userMessage }];

  const requestBody = {
    model: "deepseek-v4-pro",
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages,
  };

  let data;
  try {
    // 启用有限思考：既能提高准确性防止造假，又不会太慢
    const res = await axios.post(
      "https://api.deepseek.com/anthropic/v1/messages",
      { ...requestBody, thinking: { type: "enabled", budget_tokens: 1024 } },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        timeout: 90000,
      }
    );
    data = res.data;
  } catch (err) {
    // 参数不支持则逐步回退
    if (err.response?.status === 400 || err.response?.data?.error?.message?.includes("thinking")) {
      log("thinking 配置不支持，回退默认模式");
      const res = await axios.post(
        "https://api.deepseek.com/anthropic/v1/messages",
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          timeout: 90000,
        }
      );
      data = res.data;
    } else {
      throw err;
    }
  }

  const textBlock = data.content.find((c) => c.type === "text");
  const raw = textBlock ? textBlock.text : data.content[0]?.text || "";
  return cleanMarkdown(raw);
}

// ============================================================
// 发送消息（长文本自动拆分）
// ============================================================
const MAX_MSG_LENGTH = 3800;

async function sendFeishuMessage(chatId, text) {
  const token = await getTenantAccessToken();
  const chunks = splitText(text, MAX_MSG_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
    const body = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: prefix + chunks[i] }),
    };
    await axios.post("https://open.feishu.cn/open-apis/im/v1/messages", body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      params: { receive_id_type: "chat_id" },
    });
    if (chunks.length > 1 && i < chunks.length - 1) await sleep(300);
  }
}

function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen * 0.5) {
      splitAt = remaining.lastIndexOf("。", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ============================================================
// Webhook
// ============================================================
app.get("/webhook", (req, res) => {
  const { token, challenge, type } = req.query;
  if (type === "url_verification") return res.json({ challenge });
  res.json({ ok: true });
});

app.post("/webhook", async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  try {
    const { challenge, token, type, event } = req.body || {};

    if (type === "url_verification" && challenge) {
      return res.json({ challenge });
    }

    res.json({ ok: true });

    if (token && FEISHU_VERIFICATION_TOKEN && FEISHU_VERIFICATION_TOKEN !== "pending") {
      if (token !== FEISHU_VERIFICATION_TOKEN) {
        logError(`[${reqId}] Token 不匹配`);
        return;
      }
    }

    if (!event || !event.message) return;

    const { message, sender } = event;
    const messageId = message.message_id;
    const chatId = message.chat_id;

    if (sender?.sender_type === "app") return;
    if (isDuplicate(messageId)) {
      log(`[${reqId}] 重复消息跳过: ${messageId}`);
      return;
    }

    // 提取文本
    const msgType = message.message_type;
    let userText = "";
    if (msgType === "text" || msgType === "post") {
      userText = extractText(message.content);
    } else if (msgType === "image") {
      userText = "[图片]";
    } else if (msgType === "file") {
      userText = "[文件]";
    } else if (msgType === "sticker") {
      userText = "[表情包]";
    } else {
      userText = `[${msgType}]`;
    }

    if (!userText.trim()) return;

    log(`[${reqId}] chat:${chatId} type:${msgType} msg:"${userText.slice(0, 120)}"`);

    const targetChat = FEISHU_BOT_CHAT_ID || chatId;

    // 命令
    const cmd = userText.trim();
    if (cmd === "/clear" || cmd === "清空对话" || cmd === "重置对话") {
      clearHistory(chatId);
      await sendFeishuMessage(targetChat, "✅ 对话已清空");
      return;
    }
    if (cmd === "/status" || cmd === "状态") {
      const conv = conversationStore.get(chatId);
      const cnt = conv ? conv.messages.length : 0;
      await sendFeishuMessage(
        targetChat,
        `📊 当前对话: ${cnt} 条 | 活跃聊天: ${conversationStore.size} 个\n上下文窗口: 最近 ${RECENT_MINUTES} 分钟 | token 上限: ${MAX_HISTORY_TOKENS}`
      );
      return;
    }

    // 取历史（自动标注时间 + 过滤久远消息）
    const history = getHistory(chatId);
    log(`[${reqId}] 历史:${history.length}条`);

    let reply;
    try {
      reply = await callAI(userText, history);
    } catch (aiErr) {
      logError(`[${reqId}] AI 失败:`, aiErr.message);
      await sendFeishuMessage(targetChat, "😅 暂时无法回复，请稍后再试");
      return;
    }

    if (!reply || !reply.trim()) return;

    addHistory(chatId, "user", userText);
    addHistory(chatId, "assistant", reply);

    await sendFeishuMessage(targetChat, reply);
    log(`[${reqId}] 已回复 | ${reply.length}字 | ${Math.ceil(reply.length / MAX_MSG_LENGTH)}条`);
  } catch (err) {
    logError(`[${reqId}] 异常:`, err.message);
    try {
      const tc = FEISHU_BOT_CHAT_ID || req.body?.event?.message?.chat_id;
      if (tc) await sendFeishuMessage(tc, "😅 出错了，请稍后再试");
    } catch {}
  }
});

// ============================================================
// 健康检查
// ============================================================
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    chats: conversationStore.size,
    msgs: [...conversationStore.values()].reduce((s, c) => s + c.messages.length, 0),
  });
});

// ============================================================
// 关闭
// ============================================================
function shutdown(signal) {
  log(`${signal}，保存后关闭...`);
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(conversationStore)), "utf-8");
    log(`已保存 ${conversationStore.size} 个会话`);
  } catch (e) {
    logError("保存失败:", e.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ============================================================
// 启动
// ============================================================
loadStore();
app.listen(PORT, () => {
  log(`🚀 CLIBOT 启动 | 端口 ${PORT}`);
  log(`   上下文: 最近 ${RECENT_MINUTES} 分钟 | 上限 ${MAX_HISTORY_TOKENS} tokens`);
  log(`   持久化: ${STORE_FILE}`);
});
