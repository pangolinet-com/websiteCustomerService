process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// OpenClaw 配置（根据实际环境修改）
const OPENCLAW_ENDPOINT = 'https://34.56.243.110:18789/v1/chat/completions';
const OPENCLAW_TOKEN = 'gqzamr3ifxacyapcnnipzww2wsasiryb';

// ============ 限流配置 ============
// 每用户每分钟最多 10 次请求（官网客服场景，正常用户够用，防刷）
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 分钟
const RATE_LIMIT_MAX = 10;           // 最多 10 次
const rateLimitMap = new Map();      // userId -> { count, resetTime }

// 定时清理过期条目，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetTime) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

function checkRateLimit(userId) {
  const now = Date.now();
  let record = rateLimitMap.get(userId);

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(userId, record);
    return null; // 通过
  }

  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return retryAfter; // 返回剩余秒数
  }

  return null; // 通过
}

// SSE 流式聊天中转接口
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: '缺少 userId 或 message' });
  }

  // 限流检查
  const retryAfter = checkRateLimit(userId);
  if (retryAfter !== null) {
    return res.status(429).json({
      error: `请求过于频繁，请 ${retryAfter} 秒后再试`,
      retryAfter
    });
  }

  const sessionKey = `user:${userId}`;
  console.log(`[${sessionKey}] 收到消息: ${message}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const response = await axios.post(OPENCLAW_ENDPOINT, {
      model: 'openclaw:main',
      messages: [{ role: 'user', content: message }],
      user: sessionKey,
      stream: true
    }, {
      headers: {
        'Authorization': `Bearer ${OPENCLAW_TOKEN}`,
        'Content-Type': 'application/json',
        'x-openclaw-session-key': sessionKey
      },
      responseType: 'stream'
    });

    response.data.on('data', (chunk) => {
      res.write(chunk);
    });

    response.data.on('end', () => {
      res.end();
    });

    response.data.on('error', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

  } catch (error) {
    if (error.response) {
      let body = '';
      error.response.data.on('data', (chunk) => { body += chunk.toString(); });
      error.response.data.on('end', () => {
        console.error(`[${sessionKey}] OpenClaw 错误 (${error.response.status}):`, body);
        res.write(`data: ${JSON.stringify({ error: '服务暂时不可用' })}\n\n`);
        res.end();
      });
    } else {
      console.error(`[${sessionKey}] 请求失败:`, error.message);
      res.write(`data: ${JSON.stringify({ error: '服务暂时不可用' })}\n\n`);
      res.end();
    }
  }
});

const PORT = 39527;
app.listen(PORT, () => {
  console.log(`中转服务已启动: http://localhost:${PORT}`);
  console.log(`接口: POST /api/chat  body: { userId, message }`);
  console.log(`限流: 每用户 ${RATE_LIMIT_MAX} 次/${RATE_LIMIT_WINDOW / 1000}秒`);
});
