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
// 飞书日历集成 —— 真实数据查询
// ============================================================
const WEEKDAY_MAP = {
  "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0,
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
};

function beijingNow() {
  const d = new Date();
  // 转为北京时间
  const bj = new Date(d.getTime() + (8 * 60 - d.getTimezoneOffset()) * 60000);
  const day = bj.getDay(); // 0=Sun
  const monday = new Date(bj);
  monday.setDate(bj.getDate() - (day === 0 ? 6 : day - 1));
  return {
    year: bj.getFullYear(),
    month: bj.getMonth() + 1,
    date: bj.getDate(),
    day,
    monday,
  };
}

function beijingISO(year, month, day, hour = 0, minute = 0) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
}

function isCalendarQuery(text) {
  if (!text) return false;
  const kw = ["日程", "日历", "会议", "安排", "行程", "时间表"];
  return kw.some((w) => text.includes(w));
}

function parseDateRange(text) {
  if (!text) return null;
  const bj = beijingNow();

  // 1. YYYY年M月D日
  let m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const label = `${m[1]}年${m[2]}月${m[3]}日`;
    return { start: beijingISO(+m[1], +m[2], +m[3], 0, 0), end: beijingISO(+m[1], +m[2], +m[3], 23, 59), label };
  }

  // 2. M月D日/号
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const label = `${m[1]}月${m[2]}日`;
    return { start: beijingISO(bj.year, +m[1], +m[2], 0, 0), end: beijingISO(bj.year, +m[1], +m[2], 23, 59), label };
  }

  // 3. M/D or M-D
  m = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const label = `${m[1]}月${m[2]}日`;
    return { start: beijingISO(bj.year, +m[1], +m[2], 0, 0), end: beijingISO(bj.year, +m[1], +m[2], 23, 59), label };
  }

  // 4. 后天
  if (/后天/.test(text)) {
    const d = new Date(bj.monday);
    d.setDate(bj.date + 2);
    const label = `后天 (${d.getMonth() + 1}月${d.getDate()}日)`;
    return { start: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0), end: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 23, 59), label };
  }

  // 5. 明天
  if (/明天/.test(text)) {
    const d = new Date(bj.monday);
    d.setDate(bj.date + 1);
    const label = `明天 (${d.getMonth() + 1}月${d.getDate()}日)`;
    return { start: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0), end: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 23, 59), label };
  }

  // 6. 今天
  if (/今天/.test(text)) {
    const label = `今天 (${bj.month}月${bj.date}日)`;
    return { start: beijingISO(bj.year, bj.month, bj.date, 0, 0), end: beijingISO(bj.year, bj.month, bj.date, 23, 59), label };
  }

  // 7. 下周X
  m = text.match(/下[周星期]\s*([一二三四五六日天1-6])/);
  if (m) {
    const wd = WEEKDAY_MAP[m[1]];
    const d = new Date(bj.monday);
    d.setDate(bj.monday.getDate() + 7 + wd);
    const label = `下周${m[1]} (${d.getMonth() + 1}月${d.getDate()}日)`;
    return { start: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0), end: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 23, 59), label };
  }

  // 8. 本周X / 周X
  m = text.match(/[本这]?[周星期]\s*([一二三四五六日天1-6])/);
  if (m) {
    const wd = WEEKDAY_MAP[m[1]];
    const d = new Date(bj.monday);
    d.setDate(bj.monday.getDate() + wd);
    const label = `周${m[1]} (${d.getMonth() + 1}月${d.getDate()}日)`;
    return { start: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0), end: beijingISO(d.getFullYear(), d.getMonth() + 1, d.getDate(), 23, 59), label };
  }

  // 9. 下周（整周范围）
  if (/下周/.test(text)) {
    const startD = new Date(bj.monday);
    startD.setDate(bj.monday.getDate() + 7);
    const endD = new Date(startD);
    endD.setDate(startD.getDate() + 6);
    const label = `下周 (${startD.getMonth() + 1}/${startD.getDate()}-${endD.getMonth() + 1}/${endD.getDate()})`;
    return { start: beijingISO(startD.getFullYear(), startD.getMonth() + 1, startD.getDate(), 0, 0), end: beijingISO(endD.getFullYear(), endD.getMonth() + 1, endD.getDate(), 23, 59), label };
  }

  // 10. 本周/这周（整周范围）
  if (/[本这]周/.test(text)) {
    const startD = new Date(bj.monday);
    const endD = new Date(bj.monday);
    endD.setDate(bj.monday.getDate() + 6);
    const label = `本周 (${startD.getMonth() + 1}/${startD.getDate()}-${endD.getMonth() + 1}/${endD.getDate()})`;
    return { start: beijingISO(startD.getFullYear(), startD.getMonth() + 1, startD.getDate(), 0, 0), end: beijingISO(endD.getFullYear(), endD.getMonth() + 1, endD.getDate(), 23, 59), label };
  }

  // 默认：今天
  const label = `今天 (${bj.month}月${bj.date}日)`;
  return { start: beijingISO(bj.year, bj.month, bj.date, 0, 0), end: beijingISO(bj.year, bj.month, bj.date, 23, 59), label };
}

async function queryFeishuCalendar(startTime, endTime) {
  try {
    const token = await getTenantAccessToken();
    // 用 Date.UTC 直接计算 Unix 时间戳（秒），北京时间 UTC+8
    const toTimestamp = (isoStr) => {
      const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) return 0;
      return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], 0) / 1000);
    };
    const startTs = toTimestamp(startTime);
    const endTs = toTimestamp(endTime);
    log("日历查询:", startTime, "→ ts:", startTs);
    // 关键：不带 user_id_type/user_id，page_size 至少 10
    const { data } = await axios.get(
      "https://open.feishu.cn/open-apis/calendar/v4/calendars/primary/events",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          start_time: startTs,
          end_time: endTs,
          page_size: 50,
        },
        timeout: 10000,
      }
    );
    if (data.code !== 0) {
      logError("日历API错误:", data.code, data.msg);
      return null;
    }
    return (data.data?.items || []).map((ev) => ({
      summary: ev.summary || ev.subject || "(无标题)",
      startTime: ev.start_time?.date_time || ev.start_time?.date || "",
      endTime: ev.end_time?.date_time || ev.end_time?.date || "",
      location: ev.location?.name || ev.location || "",
      description: (ev.description || "").slice(0, 200),
    }));
  } catch (err) {
    logError("日历API请求失败:", err.message);
    return null;
  }
}

function formatCalendarContext(events, dateLabel) {
  const header = `[飞书日历数据 - 以下为真实查询结果]\n查询时间范围: ${dateLabel}`;
  if (!events || events.length === 0) {
    return `${header}\n该时间段内没有日程安排。`;
  }
  const lines = events.map((ev, i) => {
    const time = ev.startTime ? formatEventTime(ev.startTime, ev.endTime) : "全天";
    let line = `${i + 1}. ${time}  ${ev.summary}`;
    if (ev.location) line += `\n   地点: ${ev.location}`;
    return line;
  });
  return `${header}\n共 ${events.length} 个日程:\n\n${lines.join("\n\n")}`;
}

function formatEventTime(start, end) {
  const toTime = (s) => {
    const m = s.match(/T(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : null;
  };
  const st = toTime(start);
  const et = toTime(end);
  if (st && et) return `${st}-${et}`;
  if (st) return st;
  return "";
}

async function getCalendarContext(userText, openId) {
  if (!isCalendarQuery(userText) || !openId) return null;
  const range = parseDateRange(userText);
  if (!range) return null;
  log("日历查询:", range.label, "| open_id:", openId.slice(0, 10) + "...");
  const events = await queryFeishuCalendar(range.start, range.end);
  if (events === null) {
    // API 失败 → 让 AI 告知用户暂时无法查询
    return "[飞书日历数据]\n日历接口暂时无法访问（可能是权限未开通或网络问题）。请告知用户稍后重试或联系管理员开通 calendar 权限。";
  }
  return formatCalendarContext(events, range.label);
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
    "你没有任何接口或权限访问以下：",
    "- 飞书文档、审批、考勤、消息记录",
    "- 任何数据库、API、外部系统",
    "",
    "以下行为绝对禁止：",
    "❌ 编造文档内容、审批状态、考勤数据",
    "❌ 编造任何人发给用户的消息",
    "❌ 编造任何看起来像「真实数据」的信息",
    "❌ 猜测刘倩的工作内容、项目进展",
    "",
    "## ✅ 日历数据 —— 可用",
    "当用户询问日程/会议/安排时，用户消息中可能会附带以 [飞书日历数据] 开头的数据块。",
    "这些数据是系统实时从飞书日历查询的，真实可信。",
    "- 基于这些数据回答用户，按时间顺序列出日程",
    "- 如果数据显示「该时间段内没有日程安排」，如实告知",
    "- 如果消息中没有 [飞书日历数据] 但用户问日历相关，告知「暂时无法查询日历，请稍后再试」",
    "- 绝对不要在 [飞书日历数据] 之外编造任何日程信息",
    "- 如果用户问的不是飞书数据，而是知识/建议/写作/分析/代码，正常回答",
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
// 发送消息（长文本自动拆分 + 支持回复指定消息）
// ============================================================
const MAX_MSG_LENGTH = 3800;

// 发送新消息（用于 /clear /status 等系统命令）
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

// 回复指定消息（挂载在用户消息下方，带问题引用）
async function sendFeishuReply(messageId, text, originalQuestion) {
  const token = await getTenantAccessToken();
  // 截取原始问题作为引用（最多60字）
  const quote = originalQuestion.replace(/\n/g, " ").slice(0, 60);
  const prefix = originalQuestion ? `↳「${quote}${originalQuestion.length > 60 ? "..." : ""}」\n` : "";
  const fullText = prefix + text;

  const chunks = splitText(fullText, MAX_MSG_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    const chunkPrefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : "";
    const body = {
      content: JSON.stringify({ text: chunkPrefix + chunks[i] }),
      msg_type: "text",
    };
    await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
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
    // 保存原始问题，供回复引用
    const originalQuestion = userText;

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
    if (cmd === "/debug" || cmd === "debug") {
      const diag = [];
      const oid = sender?.sender_id?.open_id;
      diag.push(oid ? `✅ open_id: ${oid.slice(0, 12)}...` : "❌ 缺少 open_id");
      diag.push(typeof queryFeishuCalendar === "function" ? "✅ 日历模块已加载" : "❌ 日历模块缺失");

      if (oid) {
        const token = await getTenantAccessToken();
        const bj = beijingNow();
        const ts = String(Math.floor(Date.UTC(bj.year, bj.month - 1, bj.date, -8, 0, 0) / 1000));
        const te = String(Math.floor(Date.UTC(bj.year, bj.month - 1, bj.date, 15, 59, 59) / 1000));

        async function apiTest(label, url, params = {}) {
          try {
            const res = await axios.get(url, {
              headers: { Authorization: `Bearer ${token}` },
              params,
              timeout: 8000,
              validateStatus: () => true, // 不抛异常，拿真实响应
            });
            const d = res.data;
            return `${label}: HTTP${res.status} code=${d.code} ${d.msg||""}`;
          } catch (e) {
            return `${label}: 网络错误 ${e.message}`;
          }
        }
        diag.push(`时间戳: ts=${ts} te=${te}`);
        diag.push(await apiTest("测试1-列出日历", "https://open.feishu.cn/open-apis/calendar/v4/calendars"));

        // 对比：应用日历 vs 用户个人日历
        const appCals = await axios.get("https://open.feishu.cn/open-apis/calendar/v4/calendars", {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }).then(r => r.data).catch(() => ({ code: -1 }));

        const userCals = await axios.get("https://open.feishu.cn/open-apis/calendar/v4/calendars", {
          headers: { Authorization: `Bearer ${token}` },
          params: { user_id_type: "open_id", user_id: oid },
          validateStatus: () => true,
        }).then(r => r.data).catch(() => ({ code: -1 }));

        diag.push(`应用日历(${appCals.data?.calendar_list?.length||0}个):`);
        (appCals.data?.calendar_list||[]).forEach(c => diag.push(`  ID=${c.calendar?.calendar_id||c.calendar_id||"?"} 名=${c.summary||"?"}`));
        diag.push(`个人日历(${userCals.data?.calendar_list?.length||0}个):`);
        (userCals.data?.calendar_list||[]).forEach(c => diag.push(`  ID=${c.calendar?.calendar_id||c.calendar_id||"?"} 名=${c.summary||"?"} type=${c.type||"?"}`));

        // 用个人日历ID查事件
        const uCal = userCals.data?.calendar_list?.[0];
        if (uCal) {
          const ucalId = uCal.calendar?.calendar_id || uCal.calendar_id;
          // 不加user_id查
          diag.push(await apiTest("个人日历事件(无user)", `https://open.feishu.cn/open-apis/calendar/v4/calendars/${encodeURIComponent(ucalId)}/events`, { start_time: parseInt(ts), end_time: parseInt(te) }));
        }
      }
      await sendFeishuMessage(targetChat, `🔍 CLIBOT 诊断\n\n${diag.join("\n")}`);
      return;
    }

    // 日历集成：检测日程查询，从飞书获取真实数据
    const senderOpenId = sender?.sender_id?.open_id;
    if (senderOpenId) {
      const ctx = await getCalendarContext(userText, senderOpenId);
      if (ctx) {
        userText = ctx + "\n\n---\n用户问题: " + userText;
        log(`[${reqId}] 日历数据已注入`);
      }
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

    // 回复到用户原始消息下方（带引用），不再是独立新消息
    await sendFeishuReply(messageId, reply, originalQuestion);
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
