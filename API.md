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

## 2. 健康检查

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

## 3. 错误码

| HTTP 状态码 | 场景 | 响应示例 |
|-------------|------|----------|
| 400 | 缺少参数或消息过长 | `{"error": "缺少 userId 或 message"}` |
| 429 | 用户请求过于频繁（每用户60秒10次） | `{"error": "请求过于频繁，请 45 秒后再试", "retryAfter": 45}` |
| 429 | IP 请求过于频繁（每IP 60秒30次） | `{"error": "IP 请求过于频繁，请 30 秒后再试", "retryAfter": 30}` |
| 429 | 上一条消息还在处理中 | `{"error": "上一条消息还在处理中，请稍后再试"}` |
| 502 | 上游服务出错 | `{"error": "服务暂时不可用"}` |
| 504 | 上游响应超时 | `{"error": "响应超时，请重试"}` |

---

## 4. 前端对接示例

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

---

## 5. 注意事项

1. **userId 要持久化**：同一用户每次访问应使用相同的 userId，AI 会记住上下文。建议存在 `localStorage` 或 `sessionStorage` 中
2. **并发限制**：同一 userId 同时只能有一个进行中的请求，上一条没返回完不要发下一条
3. **消息长度**：单条消息最大 2000 字符
4. **限流策略**：每用户 60 秒内最多 10 次请求，超限后等待 `retryAfter` 秒再重试
