# 如何在你的网站中实现用户消息隔离

## 核心机制：Session Key

OpenClaw 的 Gateway 允许通过 **`x-openclaw-session-key`** HTTP Header 或 OpenAI 协议中的 **`user`** 参数来指定一个唯一的“会话键”。

1. **物理隔离**：当你发送 `x-openclaw-session-key: user:123` 时，OpenClaw 会在内部加载/创建一个专属于该 Key 的 SQLite 数据库或缓存文件。
2. **上下文隔离**：即使同一个智能体（Agent）在运行，只要 `sessionKey` 不同，它们之间的聊天记录（Context）就是完全独立的。

## 具体代码实现

我已经为你创建了示例文件：`/root/.openclaw/workspace/pangolin-amz/connect-openclaw/index.js`

### 关键部分说明

```javascript
const axios = require('axios');

async function chatWithOpenClaw(userId, userMessage) {
    // 每一个不同的 userId 对应一个物理隔离的会话
    const sessionKey = `user:${userId}`;

    const response = await axios.post('http://localhost:18789/v1/chat/completions', {
        model: "openclaw:main",
        messages: [{ role: "user", content: userMessage }],
        user: sessionKey // 也可以通过这个参数
    }, {
        headers: {
            'Authorization': 'Bearer YOUR_TOKEN',
            // 💡 最推荐的方式：直接设置自定义 Header
            'x-openclaw-session-key': sessionKey
        }
    });

    return response.data.choices[0].message.content;
}
```

## 注意事项

1. **确保后端开启端点**：
   在 OpenClaw 配置中确保 `gateway.http.endpoints.chatCompletions.enabled` 为 `true`。

2. **多租户安全**：
   - 绝不要将 `gateway.auth.token` 暴露在前端。
   - 建议在你的网站后端（Node.js/Python/Go）接收用户消息，然后由后端构造 `sessionKey` 并透传给 OpenClaw。

3. **管理会话**：
   你可以通过 `openclaw sessions list` 看到这些生成的 `user:xxx` 会话。
