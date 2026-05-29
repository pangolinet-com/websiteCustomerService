# 官网 AI 客服接口文档

Base URL: `https://help.pangolinfo.com`

---

## 1. 聊天接口

### 请求

```
POST /api/chat
Content-Type: application/json
```

#### Body 参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| userId | string | 是 | 用户唯一标识，用于会话隔离和上下文记忆。建议用浏览器指纹或随机ID，同一用户保持不变 |
| message | string | 是 | 用户发送的消息，最长 2000 字 |

#### 请求示例

```json
{
  "userId": "web_abc12345",
  "message": "你好，请问你们的产品有哪些？"
}
```

### 响应

返回格式为 **JSON**，`Content-Type: application/json`。

#### 响应示例

```json
{
  "reply": "你好！我们的产品包括……"
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `reply` | string | AI 回复的完整文本 |

### 响应头

| Header | 说明 |
|--------|------|
| `Content-Type` | `application/json` |
| `X-Request-Id` | 请求唯一ID，排查问题时提供 |

---

## 2. 聊天接口（流式）

面向选品分析等长耗时场景的智能体，回复以 **SSE 流式**逐字返回，体验更实时。与 `/api/chat` 是**两个独立的智能体**，限流与并发互不影响。

### 请求

```
POST /api/chat2
Content-Type: application/json
```

#### Body 参数

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| fingerprintId | string | 是 | 浏览器指纹ID，用于会话隔离和上下文记忆。非登录用户也可使用，注册后由后端绑定到账号。同一用户保持不变 |
| message | string | 是 | 用户发送的消息，最长 2000 字 |

#### 请求示例

```json
{
  "fingerprintId": "fp_abc12345",
  "message": "帮我完成2026下半年的男鞋选品"
}
```

### 响应

返回格式为 **SSE 流**，`Content-Type: text/event-stream`。

服务端原样透传上游 OpenAI 兼容的流式分片，每个分片是一行 `data:` 事件，增量内容在 `choices[0].delta.content`，以 `data: [DONE]` 结束：

```
data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}

data: {"id":"chatcmpl_xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}

data: [DONE]
```

> 增量内容为 **markdown 文本**（含标题、表格、emoji 等），前端拼接后渲染。

#### 流中错误

若流已开始后上游异常，会收到一个错误事件后结束（前端应监听并提示重试）：

```
event: error
data: {"error":"服务暂时不可用"}
```

> 若流尚未开始（连接上游阶段就失败），则返回普通 JSON 错误（状态码见错误码表），不进入 SSE。

### 响应头

| Header | 说明 |
|--------|------|
| `Content-Type` | `text/event-stream` |
| `Cache-Control` | `no-cache` |
| `X-Request-Id` | 请求唯一ID，排查问题时提供 |

---

## 3. 健康检查

### 请求

```
GET /health
```

### 响应

```json
{
  "status": "ok",
  "uptime": 3600,
  "activeSessions": 2
}
```

---

## 4. 错误码

| HTTP 状态码 | 场景 | 响应示例 |
|-------------|------|----------|
| 400 | 缺少参数或消息过长 | `{"error": "缺少 userId 或 message"}` |
| 429 | 用户请求过于频繁（每用户60秒10次） | `{"error": "请求过于频繁，请 45 秒后再试", "retryAfter": 45}` |
| 429 | IP 请求过于频繁（每IP 60秒30次） | `{"error": "IP 请求过于频繁，请 30 秒后再试", "retryAfter": 30}` |
| 429 | 上一条消息还在处理中 | `{"error": "上一条消息还在处理中，请稍后再试"}` |
| 502 | 上游服务出错 | `{"error": "服务暂时不可用"}` |
| 504 | 上游响应超时 | `{"error": "响应超时，请重试"}` |

> `/api/chat2` 的限流维度为 **fingerprintId**（每指纹 60 秒 10 次、每 IP 60 秒 30 次），与 `/api/chat`（按 userId）各自独立计数。`/api/chat2` 不设上游超时（长任务可跑数分钟），故无 504；流开始前的上游错误返回 502，流开始后以 `event: error` 事件返回。

---

## 5. 前端对接示例

### 5.1 普通接口 `/api/chat`

```javascript
async function chat(userId, message) {
  const res = await fetch('https://help.pangolinfo.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, message })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || '请求失败');
  }

  const { reply } = await res.json();
  return reply;
}
```

### 5.2 流式接口 `/api/chat2`

逐字解析 SSE，`onDelta` 在每个增量到达时回调（可用于实时渲染），返回拼接后的完整 markdown：

```javascript
async function chatStream(fingerprintId, message, onDelta) {
  const res = await fetch('https://help.pangolinfo.com/api/chat2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprintId, message })
  });

  // 流开始前的错误（JSON）
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || '请求失败');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('event: error')) continue; // 下一行的 data 是错误体
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]' || payload === '') continue;
      try {
        const obj = JSON.parse(payload);
        if (obj.error) throw new Error(obj.error);     // 流中错误
        const delta = obj?.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta?.(delta); }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }
  return full;
}

// 用法：边到边渲染
chatStream('fp_abc12345', '帮我完成2026下半年的男鞋选品', (d) => {
  process.stdout.write(d); // 浏览器里改为追加到聊天气泡并用 markdown 渲染
});
```

---

## 6. 注意事项

1. **标识要持久化**：`/api/chat` 用 `userId`、`/api/chat2` 用 `fingerprintId`，同一用户每次访问应使用相同的值，AI 会记住上下文。建议存在 `localStorage` 或 `sessionStorage` 中
2. **并发限制**：同一标识同时只能有一个进行中的请求，上一条没返回完不要发下一条
3. **消息长度**：单条消息最大 2000 字符
4. **限流策略**：每标识 60 秒内最多 10 次请求，超限后等待 `retryAfter` 秒再重试
5. **`/api/chat2` 内容为 markdown**：回复含标题、表格、emoji 等 markdown 标记，前端拼接后需用 markdown 渲染器（如 `marked`/`markdown-it`）展示
6. **`/api/chat2` 长耗时**：选品分析等任务可能持续数分钟，前端需做好加载态与流式渲染，不要因等待时间长而误判为失败
