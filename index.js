const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ============================================================
// 环境变量 (部署时在 Render 等平台配置)
// ============================================================
const {
  FEISHU_APP_ID,           // 飞书应用 App ID (cli_xxx)
  FEISHU_APP_SECRET,       // 飞书应用 App Secret
  FEISHU_VERIFICATION_TOKEN, // 飞书事件订阅 Verification Token
  DEEPSEEK_API_KEY,        // DeepSeek API Key (sk-xxx)
  FEISHU_BOT_CHAT_ID,      // [可选] 固定回复的 chat_id；不传则回复到原消息的 chat
  PORT = 3000,
} = process.env;

// ============================================================
// 飞书 Access Token 缓存
// ============================================================
let tenantAccessToken = null;
let tokenExpireAt = 0;

async function getTenantAccessToken() {
  if (tenantAccessToken && Date.now() < tokenExpireAt - 60000) {
    return tenantAccessToken;
  }
  const { data } = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
    { headers: { "Content-Type": "application/json" } }
  );
  if (data.code !== 0) throw new Error(`飞书认证失败: ${data.msg}`);
  tenantAccessToken = data.tenant_access_token;
  tokenExpireAt = Date.now() + data.expire * 1000;
  return tenantAccessToken;
}

// ============================================================
// 获取消息内容中的纯文本
// ============================================================
function extractText(content) {
  if (!content) return "";
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    if (parsed.text) return parsed.text;
    // post 类型消息
    if (parsed.content) {
      return parsed.content
        .flatMap((block) => block.map((seg) => seg.text || ""))
        .join("");
    }
  } catch {
    return String(content);
  }
  return String(content);
}

// ============================================================
// 调用 DeepSeek API (Anthropic 兼容模式)
// ============================================================
async function callAI(userMessage) {
  const { data } = await axios.post(
    "https://api.deepseek.com/anthropic/v1/messages",
    {
      model: "deepseek-v4-pro",
      max_tokens: 2048,
      system:
        "你是 CLIBOT，刘倩的飞书智能助手。你可以帮她：\n" +
        "- 预约会议、管理日历\n" +
        "- 搜索飞书消息和文档\n" +
        "- 回答工作相关问题\n" +
        "- 执行各种飞书操作\n\n" +
        "回复风格：简洁、直接、友好。用中文回复。\n" +
        "当需要用户确认时，明确列出选项让用户选择。",
      messages: [{ role: "user", content: userMessage }],
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );
  return data.content[0].text;
}

// ============================================================
// 通过飞书 API 发送消息
// ============================================================
async function sendFeishuMessage(chatId, text) {
  const token = await getTenantAccessToken();
  const body = {
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  };
  await axios.post(
    "https://open.feishu.cn/open-apis/im/v1/messages",
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      params: { receive_id_type: "chat_id" },
    }
  );
}

// ============================================================
// 飞书事件订阅 - URL 验证
// ============================================================
app.get("/webhook", (req, res) => {
  const { token, challenge, type } = req.query;
  console.log("URL 验证请求:", { token, type });

  // URL 验证不需要检查 token（token 用于事件通知，非 URL 验证）
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  res.json({ ok: true });
});

// ============================================================
// 飞书事件订阅 - 接收事件
// ============================================================
app.post("/webhook", async (req, res) => {
  try {
    const { challenge, token, type, event } = req.body || {};

    // URL 验证 (POST 方式) — 必须在任何其他响应之前处理
    if (type === "url_verification" && challenge) {
      console.log("URL 验证成功, 返回 challenge");
      return res.json({ challenge });
    }

    // 先返回 200，避免飞书超时重试
    res.json({ ok: true });

    // 记录 token（可在 Render 环境变量中配置 FEISHU_VERIFICATION_TOKEN 进行校验）
    if (token) {
      console.log("收到事件 token:", token);
      if (FEISHU_VERIFICATION_TOKEN && FEISHU_VERIFICATION_TOKEN !== "pending" && token !== FEISHU_VERIFICATION_TOKEN) {
        console.error("事件 token 不匹配");
        return;
      }
    }

    if (!event || !event.message) return;

    const { message, sender } = event;
    const msgType = message.message_type;
    const chatId = message.chat_id;
    const content = message.content;

    // 忽略 bot 自己的消息
    if (sender?.sender_type === "app") return;

    console.log("收到用户消息:", { msgType, chatId, sender });

    // 提取文本
    let userText = "";
    if (msgType === "text") {
      userText = extractText(content);
    } else if (msgType === "post") {
      userText = extractText(content);
    } else if (msgType === "image") {
      userText = "[用户发送了一张图片]";
    } else {
      userText = `[${msgType} 类型消息]`;
    }

    if (!userText.trim()) return;

    // 调用 AI
    console.log("调用 AI 处理:", userText.slice(0, 200));
    const reply = await callAI(userText);

    // 回复
    const targetChat = FEISHU_BOT_CHAT_ID || chatId;
    await sendFeishuMessage(targetChat, reply);
    console.log("已回复:", reply.slice(0, 200));
  } catch (err) {
    console.error("处理消息出错:", err.message);
  }
});

// ============================================================
// 健康检查
// ============================================================
app.get("/", (_req, res) => res.send("CLIBOT is running ✅"));

app.listen(PORT, () => {
  console.log(`CLIBOT server running on port ${PORT}`);
  console.log(`Webhook URL: <你的域名>/webhook`);
});
