process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ============ 配置 ============
const CONFIG = {
  // OpenClaw
  openclawEndpoint: 'https://34.56.243.110:18789/v1/chat/completions',
  openclawToken: 'gqzamr3ifxacyapcnnipzww2wsasiryb',

  // 服务
  port: 39527,
  apiKey: 'sk-pangolin-cs-2024',           // 接口鉴权密钥，调用方需传 Authorization: Bearer <apiKey>

  // CORS 白名单（填你的官网域名，* 表示允许所有）
  corsOrigins: ['*'],

  // 限流
  userRateLimit: { window: 60_000, max: 10 },  // 每用户：60秒10次
  ipRateLimit: { window: 60_000, max: 30 },    // 每IP：60秒30次（一个IP可能有多个用户）

  // 安全
  maxMessageLength: 2000,    // 单条消息最大字符数
  requestTimeout: 30_000,    // 上游超时 30 秒
};

// ============ 中间件 ============

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CONFIG.corsOrigins.includes('*') || CONFIG.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));

// API Key 鉴权
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${CONFIG.apiKey}`) {
    return res.status(401).json({ error: '未授权，请提供有效的 API Key' });
  }
  next();
}

// ============ 限流器 ============
const cleanupTimers = []; // 收集定时器，关闭时统一清理

function createRateLimiter(window, max) {
  const map = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of map) {
      if (now > val.resetTime) map.delete(key);
    }
  }, 5 * 60_000);

  cleanupTimers.push(timer);

  return function check(key) {
    const now = Date.now();
    let record = map.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + window };
      map.set(key, record);
      return null;
    }

    record.count++;
    if (record.count > max) {
      return Math.ceil((record.resetTime - now) / 1000);
    }
    return null;
  };
}

const checkUserRate = createRateLimiter(CONFIG.userRateLimit.window, CONFIG.userRateLimit.max);
const checkIpRate = createRateLimiter(CONFIG.ipRateLimit.window, CONFIG.ipRateLimit.max);

// ============ 并发锁 ============
const activeSessions = new Set(); // 正在请求中的 userId

// ============ 健康检查 ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), activeSessions: activeSessions.size });
});

// ============ 聊天接口 ============
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { userId, message } = req.body;

  // 参数校验
  if (!userId || !message) {
    return res.status(400).json({ error: '缺少 userId 或 message' });
  }

  if (typeof message !== 'string' || message.length > CONFIG.maxMessageLength) {
    return res.status(400).json({ error: `消息长度不能超过 ${CONFIG.maxMessageLength} 字` });
  }

  // IP 限流
  const clientIp = req.ip || req.socket.remoteAddress;
  const ipRetry = checkIpRate(clientIp);
  if (ipRetry !== null) {
    return res.status(429).json({ error: `IP 请求过于频繁，请 ${ipRetry} 秒后再试`, retryAfter: ipRetry });
  }

  // 用户限流
  const userRetry = checkUserRate(userId);
  if (userRetry !== null) {
    return res.status(429).json({ error: `请求过于频繁，请 ${userRetry} 秒后再试`, retryAfter: userRetry });
  }

  // 并发锁：同一用户同时只能有一个请求
  if (activeSessions.has(userId)) {
    return res.status(429).json({ error: '上一条消息还在处理中，请稍后再试' });
  }

  activeSessions.add(userId);
  const sessionKey = `user:${userId}`;
  const requestId = crypto.randomBytes(4).toString('hex');
  console.log(`[${requestId}][${sessionKey}] 收到消息: ${message.substring(0, 100)}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Request-Id', requestId);
  res.flushHeaders();

  try {
    const response = await axios.post(CONFIG.openclawEndpoint, {
      model: 'openclaw:main',
      messages: [{ role: 'user', content: message }],
      user: sessionKey,
      stream: true
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.openclawToken}`,
        'Content-Type': 'application/json',
        'x-openclaw-session-key': sessionKey
      },
      responseType: 'stream',
      timeout: CONFIG.requestTimeout
    });

    response.data.on('data', (chunk) => {
      res.write(chunk);
    });

    response.data.on('end', () => {
      activeSessions.delete(userId);
      res.end();
    });

    response.data.on('error', (err) => {
      console.error(`[${requestId}][${sessionKey}] 流错误:`, err.message);
      activeSessions.delete(userId);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    // 客户端断开时清理
    req.on('close', () => {
      activeSessions.delete(userId);
      response.data.destroy();
    });

  } catch (error) {
    activeSessions.delete(userId);

    if (error.code === 'ECONNABORTED') {
      console.error(`[${requestId}][${sessionKey}] 请求超时`);
      res.write(`data: ${JSON.stringify({ error: '响应超时，请重试' })}\n\n`);
      res.end();
      return;
    }

    if (error.response) {
      let body = '';
      error.response.data.on('data', (chunk) => { body += chunk.toString(); });
      error.response.data.on('end', () => {
        console.error(`[${requestId}][${sessionKey}] OpenClaw 错误 (${error.response.status}):`, body);
        res.write(`data: ${JSON.stringify({ error: '服务暂时不可用' })}\n\n`);
        res.end();
      });
    } else {
      console.error(`[${requestId}][${sessionKey}] 请求失败:`, error.message);
      res.write(`data: ${JSON.stringify({ error: '服务暂时不可用' })}\n\n`);
      res.end();
    }
  }
});

// ============ 启动 ============
const server = app.listen(CONFIG.port, () => {
  console.log(`中转服务已启动: http://localhost:${CONFIG.port}`);
  console.log(`接口: POST /api/chat`);
  console.log(`鉴权: Authorization: Bearer ${CONFIG.apiKey}`);
  console.log(`限流: 用户 ${CONFIG.userRateLimit.max}次/${CONFIG.userRateLimit.window / 1000}秒, IP ${CONFIG.ipRateLimit.max}次/${CONFIG.ipRateLimit.window / 1000}秒`);
});

// 优雅关闭
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  cleanupTimers.forEach(t => clearInterval(t));
  activeSessions.clear();
  server.close(() => {
    console.log('所有连接已关闭，进程退出');
    process.exit(0);
  });
  // 5秒内没关完则强制退出
  setTimeout(() => {
    console.error('强制退出');
    process.exit(1);
  }, 5000);
}
