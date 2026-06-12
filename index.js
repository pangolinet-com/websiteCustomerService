process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ============ 配置 ============
const CONFIG = {
  // OpenClaw
  openclawEndpoint: 'http://43.134.24.35:19999/v1/chat/completions',
  openclawToken: 'kdyixwjs7nfxnbywnefy6n6kdzzpddn7',

  // 第二个智能体（指纹会话，流式）—— 不同端口、不同 token
  openclawEndpoint2: 'http://43.134.24.35:18789/v1/chat/completions',
  openclawToken2: 'wys68ceyyrn4rzert7rrjwkqicx4nzhs',

  // 落库接口（ext-api，存指纹+消息+回复）。persistEndpoint 为空时跳过落库
  persistEndpoint: 'https://extapi.pangolinfo.com/chat2/message/store',
  persistToken: '99594168868640efb92be65408c8eeaf',  // 内部密钥，请求头 X-System-Token
  persistTimeout: 5_000,

  // 服务
  port: 39527,

  // 限流总开关：true=开启所有限流，false=全部跳过（chat + chat2 的 IP/用户/并发锁/指纹数据库判重都不生效）
  // 线上测试用：关掉后同一指纹/用户/IP 可反复请求，不会被 FP_USED 永久挡住。
  rateLimitEnabled: true,

  // CORS 白名单（调试阶段允许所有，上线后改为 /^https?:\/\/([a-z0-9-]+\.)*pangolinfo\.com$/ ）
  corsPattern: null,

  // 限流
  userRateLimit: { window: 60_000, max: 10 },  // 每用户：60秒10次
  ipRateLimit: { window: 60_000, max: 30 },    // 每IP：60秒30次（一个IP可能有多个用户）

  // chat2 限流（引流场景）：
  //   指纹 —— 永久只能提问 1 次，靠数据库判重（查 latestByFingerprint，found=true 即已消费），重启不失效
  //   IP   —— 两层内存限流，防止狂换指纹绕过：
  //           短窗 1 分钟 1 次（防连点），长窗 24 小时 5 次（防一天内反复试用）
  fpIpRateLimit:    { window: 60_000, max: 1 },      // 每IP：1分钟1次
  fpIpDailyLimit:   { window: 86_400_000, max: 5 },  // 每IP：24小时5次

  // 指纹消费判重查询接口（ext-api，GET ?fingerprintId=xxx，返回 data.found）
  fpCheckEndpoint: 'https://extapi.pangolinfo.com/chat2/message/latestByFingerprint',

  // 报告判重查询接口（ext-api，GET，受 token 保护：转发用户 Authorization，后端按 userId 查最新一条，返回 data.found）
  // 登录用户「有且只能发一次报告」就靠它：found=true 即已生成过报告。
  reportCheckEndpoint: 'https://extapi.pangolinfo.com/chat2/message/latest',

  // 安全
  maxMessageLength: 2000,    // 单条消息最大字符数
  requestTimeout: 30_000,    // 上游超时 30 秒
};

// ============ 中间件 ============

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!CONFIG.corsPattern || (origin && CONFIG.corsPattern.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));

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

// chat2 的 IP 限流器（指纹判重走数据库；IP 两层内存频率限流：分钟级 + 天级）
const checkFpIpRate = createRateLimiter(CONFIG.fpIpRateLimit.window, CONFIG.fpIpRateLimit.max);
const checkFpIpDaily = createRateLimiter(CONFIG.fpIpDailyLimit.window, CONFIG.fpIpDailyLimit.max);

// ============ 并发锁 ============
const activeSessions = new Set();  // /api/chat 正在请求中的 userId
const activeSessions2 = new Set(); // /api/chat2 正在请求中的 fingerprintId

// ============ 健康检查 ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), activeSessions: activeSessions.size });
});

// ============ 聊天接口 ============
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;

  // 参数校验
  if (!userId || !message) {
    return res.status(400).json({ error: '缺少 userId 或 message' });
  }

  if (typeof message !== 'string' || message.length > CONFIG.maxMessageLength) {
    return res.status(400).json({ error: `消息长度不能超过 ${CONFIG.maxMessageLength} 字` });
  }

  // 限流（总开关关闭时全部跳过）
  if (CONFIG.rateLimitEnabled) {
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
  }

  activeSessions.add(userId);
  const requestId = crypto.randomBytes(4).toString('hex');
  console.log(`[${requestId}][${userId}] 收到消息: ${message.substring(0, 100)}`);

  res.setHeader('X-Request-Id', requestId);

  try {
    const response = await axios.post(CONFIG.openclawEndpoint, {
      model: 'openclaw:main',
      messages: [{ role: 'user', content: message }],
      user: userId,
      stream: false
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.openclawToken}`,
        'Content-Type': 'application/json'
      },
      timeout: CONFIG.requestTimeout
    });

    activeSessions.delete(userId);
    const content = response.data?.choices?.[0]?.message?.content ?? '';
    console.log(`[${requestId}][${userId}] 回复: ${content.substring(0, 100)}`);
    return res.json({ reply: content });

  } catch (error) {
    activeSessions.delete(userId);

    if (error.code === 'ECONNABORTED') {
      console.error(`[${requestId}][${userId}] 请求超时`);
      return res.status(504).json({ error: '响应超时，请重试' });
    }

    if (error.response) {
      console.error(`[${requestId}][${userId}] OpenClaw 错误 (${error.response.status}):`, error.response.data);
      return res.status(502).json({ error: '服务暂时不可用' });
    }

    console.error(`[${requestId}][${userId}] 请求失败:`, error.message);
    return res.status(500).json({ error: '服务暂时不可用' });
  }
});

// ============ 落库（chat2 流结束后的副作用）============
// 把完整回复 + 指纹 id 推送给我方后端落库接口。失败只记日志，不影响用户。
async function persistMessage(fingerprintId, userMessage, reply, requestId) {
  if (!CONFIG.persistEndpoint) return; // 未配置则跳过
  try {
    await axios.post(CONFIG.persistEndpoint, {
      fingerprintId,
      message: userMessage,
      reply
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-System-Token': CONFIG.persistToken  // 内部密钥，免用户 token
      },
      timeout: CONFIG.persistTimeout
    });
    console.log(`[${requestId}][${fingerprintId}] 已落库`);
  } catch (e) {
    console.error(`[${requestId}][${fingerprintId}] 落库失败:`, e.message);
  }
}

// ============ 指纹消费判重 ============
// 查 ext-api：该指纹是否已经提问过（found=true 即已消费）。
// 容错：查询失败时【放行】（引流场景，宁可偶尔多放一次，也不要因查询挂了把所有人挡住）。
async function fingerprintUsed(fingerprintId) {
  try {
    const resp = await axios.get(CONFIG.fpCheckEndpoint, {
      params: { fingerprintId },
      headers: { 'X-System-Token': CONFIG.persistToken },
      timeout: CONFIG.persistTimeout
    });
    return resp.data?.data?.found === true;
  } catch (e) {
    console.error(`[${fingerprintId}] 指纹判重查询失败，放行:`, e.message);
    return false; // 查询失败 → 放行
  }
}

// ============ 报告判重（登录用户）============
// 转发用户的 Authorization 到 ext-api /chat2/message/latest，后端按 userId 查最新一条。
// found=true 即该用户已生成过报告。
// 容错与指纹判重【相反】：报告是「有且只能一次」的硬上限，查询失败时【拦住】(返回 true)，
// 宁可误拦也不让超发。token 无效（401）同样按已用完处理，挡住请求。
async function reportUsed(authorization, requestId) {
  try {
    const resp = await axios.get(CONFIG.reportCheckEndpoint, {
      headers: { Authorization: authorization },
      timeout: CONFIG.persistTimeout
    });
    return resp.data?.data?.found === true;
  } catch (e) {
    console.error(`[${requestId}] 报告判重查询失败，拦住:`, e.message);
    return true; // 查询失败 → 拦住（硬上限）
  }
}

// ============ 聊天接口（流式 · 第二个智能体）============
app.post('/api/chat2', async (req, res) => {
  const { fingerprintId, message } = req.body;

  // 参数校验
  if (!fingerprintId || !message) {
    return res.status(400).json({ error: '缺少 fingerprintId 或 message' });
  }

  if (typeof message !== 'string' || message.length > CONFIG.maxMessageLength) {
    return res.status(400).json({ error: `消息长度不能超过 ${CONFIG.maxMessageLength} 字` });
  }

  const requestId = crypto.randomBytes(4).toString('hex');

  // 登录态判定：带 Authorization: Bearer <jwt> 即视为登录用户的「报告」请求。
  // 登录用户走另一套闸门——绕开匿名期的 IP 限流和指纹永久判重（哪怕登录前已撞过 IP 墙也放行），
  // 改用数据库报告判重保证「有且只能发一次报告」。
  const authorization = req.get('authorization');
  const isLoggedIn = typeof authorization === 'string' && /^Bearer\s+\S/i.test(authorization);

  // 限流（总开关关闭时全部跳过）
  if (CONFIG.rateLimitEnabled) {
    // 并发锁：同一指纹同时只能有一个请求（判重落库前先挡住"还在处理中"的并发）。两条路径都加。
    if (activeSessions2.has(fingerprintId)) {
      return res.status(429).json({ error: '上一条消息还在处理中，请稍后再试' });
    }

    if (isLoggedIn) {
      // 登录用户：报告判重——有且只能一次。已生成过则拒绝（查询失败也拦住，硬上限）。
      if (await reportUsed(authorization, requestId)) {
        return res.status(200).json({ error: '报告已生成，无法重复领取', code: 'REPORT_USED' });
      }
    } else {
      // 匿名用户：IP 两层限流 + 指纹永久判重
      // IP 限流（内存；防止狂换指纹绕过）：先短窗 1分钟1次，再长窗 24小时5次
      // 先判短窗：被分钟限流挡住的连点请求不应消耗当天 5 次配额
      const clientIp = req.ip || req.socket.remoteAddress;
      const ipRetry = checkFpIpRate(clientIp);
      if (ipRetry !== null) {
        return res.status(429).json({ error: `请求过于频繁，请 ${ipRetry} 秒后再试`, retryAfter: ipRetry });
      }
      const ipDailyRetry = checkFpIpDaily(clientIp);
      if (ipDailyRetry !== null) {
        return res.status(429).json({ error: `今日试用次数已用完，请 ${ipDailyRetry} 秒后再试`, retryAfter: ipDailyRetry });
      }

      // 指纹判重：永久只能提问 1 次（已消费过则拒绝，前端据此引导登录）
      if (await fingerprintUsed(fingerprintId)) {
        return res.status(200).json({ error: '试用次数已用完，请登录后查看完整对话', code: 'FP_USED' });
      }
    }
  }

  activeSessions2.add(fingerprintId);
  console.log(`[${requestId}][${fingerprintId}] 收到消息(流式): ${message.substring(0, 100)}`);

  let upstream;
  let fullContent = '';   // 累积完整回复，供落库
  let buffer = '';        // 跨 chunk 的 SSE 行缓冲
  let cleaned = false;    // 防止并发锁重复释放
  let heartbeat = null;   // SSE 心跳定时器

  const release = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    activeSessions2.delete(fingerprintId);
  };

  // 客户端断开：中止上游流，清理并发锁，不落库
  // 用 res 的 close 而非 req.close —— req.close 在请求体读完时就会触发，会误判为断开
  res.on('close', () => {
    if (res.writableEnded) return; // 正常结束，非断开
    if (upstream?.data) upstream.data.destroy();
    release();
    console.log(`[${requestId}][${fingerprintId}] 客户端断开，已中止`);
  });

  try {
    upstream = await axios.post(CONFIG.openclawEndpoint2, {
      model: 'openclaw:main',
      messages: [{ role: 'user', content: message }],
      user: fingerprintId,
      stream: true
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.openclawToken2}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream',
      // 不设超时：选品分析这类智能体会边调 API 边思考，整轮可能数分钟，
      // 30 秒会把流掐断（实测会在生成最终报告前 aborted）。
      // 安全前提：客户端断开时由下方 res.on('close') 销毁上游流并释放并发锁，不会泄漏连接。
      timeout: 0
    });

    // 上游已连通，开始 SSE 透传
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', requestId);
    res.flushHeaders();

    // SSE 心跳：龙虾在思考/等工具结果时上游可能数十秒不吐字节，
    // 此时连接静默，易被 nginx/负载均衡/浏览器的空闲超时（常见 60s）掐断 → 前端表现为"超时不回复"。
    // 每 15 秒发一个 SSE 注释行（":" 开头，EventSource 自动忽略，不影响数据解析）保活。
    heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': ping\n\n');
    }, 15_000);

    upstream.data.on('data', (chunk) => {
      // 原样透传给前端
      res.write(chunk);

      // 同时解析增量内容，拼接完整体供落库
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || payload === '') continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) fullContent += delta;
        } catch {
          // 非 JSON 行忽略，不影响透传
        }
      }
    });

    upstream.data.on('end', () => {
      res.end();
      release();
      console.log(`[${requestId}][${fingerprintId}] 回复(流式): ${fullContent.substring(0, 100)}`);
      // 异步落库，不阻塞响应
      persistMessage(fingerprintId, message, fullContent, requestId);
    });

    upstream.data.on('error', (err) => {
      console.error(`[${requestId}][${fingerprintId}] 上游流错误:`, err.message);
      release();
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: '服务暂时不可用' })}\n\n`);
        res.end();
      }
    });

  } catch (error) {
    release();

    // 此时 SSE 尚未开始（flushHeaders 在 axios 成功之后），可正常返回 JSON 错误
    if (error.code === 'ECONNABORTED') {
      console.error(`[${requestId}][${fingerprintId}] 请求超时`);
      return res.status(504).json({ error: '响应超时，请重试' });
    }

    if (error.response) {
      console.error(`[${requestId}][${fingerprintId}] OpenClaw 错误 (${error.response.status})`);
      return res.status(502).json({ error: '服务暂时不可用' });
    }

    console.error(`[${requestId}][${fingerprintId}] 请求失败:`, error.message);
    return res.status(500).json({ error: '服务暂时不可用' });
  }
});

// ============ 启动 ============
const server = app.listen(CONFIG.port, () => {
  console.log(`中转服务已启动: http://localhost:${CONFIG.port}`);
  console.log(`接口: POST /api/chat, POST /api/chat2(流式)`);
  console.log(`限流总开关: ${CONFIG.rateLimitEnabled ? '【开启】' : '【关闭 —— 所有限流跳过】'}`);
  if (CONFIG.rateLimitEnabled) {
    console.log(`限流: 用户 ${CONFIG.userRateLimit.max}次/${CONFIG.userRateLimit.window / 1000}秒, IP ${CONFIG.ipRateLimit.max}次/${CONFIG.ipRateLimit.window / 1000}秒`);
    console.log(`限流(chat2匿名): 指纹永久1次(数据库判重), IP ${CONFIG.fpIpRateLimit.max}次/${CONFIG.fpIpRateLimit.window / 1000}秒 + ${CONFIG.fpIpDailyLimit.max}次/${CONFIG.fpIpDailyLimit.window / 3600_000}小时`);
    console.log(`限流(chat2登录): 绕过IP/指纹限流, 报告有且只能1次(数据库判重, 查询失败则拦住)`);
  }
});

// 优雅关闭
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  cleanupTimers.forEach(t => clearInterval(t));
  activeSessions.clear();
  activeSessions2.clear();
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
