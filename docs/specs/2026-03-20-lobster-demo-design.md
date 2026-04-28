# Pangolin AI 引流龙虾 · 设计文档

**版本：** v1.1
**日期：** 2026-03-20
**状态：** 已确认，待开发

---

## 一、项目背景与目标

### 产品定位

Pangolin 主营亚马逊电商数据 API（Amazon Scrape API、SERP API、Keyword Trends API、Review API 等）。

本项目目标：在官网部署一个 AI 引流助手（"龙虾"），让已登录的潜在客户**免费试用我们的 API 能力**，体验数据价值后引导留资或付费转化。

### 用户流程

```
访问官网
  └─ 看到龙虾入口
       └─ 点击对话框
            ├─ 未登录 → 跳转注册/登录页
            └─ 已登录 → 进入工作台
                  └─ 选择场景（竞品分析 / 关键词选品 / 评价洞察）
                        └─ 与龙虾对话（试用 API 能力）
                              └─ Token 点数耗尽
                                    └─ 引导留资 / 加微信页面
```

---

## 二、系统架构

### 技术栈

| 层 | 技术 |
|---|---|
| 后端服务 | Node.js + Express（全新独立服务） |
| 数据库 | 现有 MySQL 云数据库（新增业务表） |
| AI 引擎 | OpenClaw（单实例，多场景复用） |
| 认证 | 复用现有后端登录体系，验证 JWT 提取 userId |

### 请求链路

```
前端
 │  携带 JWT Token + { scenarioId, message }
 ▼
[Auth 中间件]
 │  验证 JWT，提取 userId（不信任前端传参）
 │  提取 req.body.scenarioId 供后续中间件使用
 ▼
[Usage 中间件]
 │  查 lobster_user_usage.total_tokens_used（无记录视为 0）
 │  查全局 token_limit（来自 CONFIG，默认 100000）
 │  超限 → 返回 TOKEN_LIMIT_EXCEEDED（前端跳转留资页）
 ▼
[并发锁]
 │  同一 userId 同时只能有一个进行中的请求（Set 实现）
 ▼
[Rate 限流器]
 │  防高频刷接口（每用户 60s 内 10 次）
 ▼
[Chat Handler]
 ├─ 从 lobster_scenarios 加载场景 base_system_prompt（平台 SOP）
 ├─ 从 lobster_user_experience 加载用户自定义背景（可选）
 ├─ 拼装完整 system prompt（平台层在前，用户层追加在后）
 ├─ 调用 OpenClaw（session key = userId:scenarioSlug）
 ├─ 解析 response.usage.total_tokens
 ├─ 写入 lobster_messages（用户消息 + AI 回复）
 ├─ 原子更新 lobster_user_usage（SQL: total_tokens_used + N）
 └─ 返回 { reply, tokensUsed, tokensRemaining }
```

### Token 用量模型

采用**全局共享池**方案：每个用户有一个全局 token 上限（跨所有场景共享），上限值存放在服务配置 `CONFIG.tokenLimit`（默认 100000），不在数据库中维护。`lobster_user_usage` 只记录累计消耗，判断超限时在服务层用 `CONFIG.tokenLimit` 比较。

### AI 上下文策略

- 每次请求只发 **当前消息 + system prompt**，不手动管理历史
- OpenClaw 通过 `x-openclaw-session-key: {userId}:{scenarioSlug}` 自动维护每个用户每个场景的独立上下文
- 我们的 MySQL 只负责前端历史展示和用量统计，不参与 AI 上下文

---

## 三、数据库设计（新增 5 张表）

> 在现有 MySQL 云数据库中新增以下表，表名统一加 `lobster_` 前缀。

---

### 表 1：`lobster_scenarios`（场景配置）

```sql
CREATE TABLE lobster_scenarios (
  id                  INT PRIMARY KEY AUTO_INCREMENT,
  slug                VARCHAR(50) UNIQUE NOT NULL,   -- 场景标识，如 competitor_analysis
  name                VARCHAR(100) NOT NULL,          -- 展示名，如"竞品分析"
  base_system_prompt  TEXT NOT NULL,                 -- 平台 SOP（Joey 经验迁移到此）
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**业务说明：**
- Joey 的龙虾经验和 SOP 写入 `base_system_prompt`，一个场景一条记录
- 用户无任何接口可修改此表，从根本上保证平台 SOP 只读
- Token 上限统一由 `CONFIG.tokenLimit` 控制，不在此表存储

**初始数据（3 个场景）：**

| slug | name | 主要调用的 Pangolin API |
|---|---|---|
| `competitor_analysis` | 竞品分析 | Amazon Scrape API |
| `keyword_selection` | 关键词选品 | SERP API + Keyword Trends API |
| `review_insight` | 评价洞察 | Amazon Review API |

---

### 表 2：`lobster_user_experience`（用户自定义背景）

```sql
CREATE TABLE lobster_user_experience (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  user_id      VARCHAR(100) NOT NULL,
  scenario_id  INT NOT NULL,
  content      TEXT,                              -- 用户填写的背景信息
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_scenario (user_id, scenario_id)
);
```

**业务说明：**
- 这是**用户主动填写**的背景信息，有独立的编辑入口，与对话消息完全无关
- 每个用户每个场景只有一条记录，内容整体覆盖更新（UPSERT）
- 若用户未填写则只使用平台 SOP，不会报错
- 拼装 system prompt 时追加在平台 SOP 之后：

```
{base_system_prompt}

以下是该用户的补充背景信息，请在回答时参考：
{user_experience.content}
```

---

### 表 3：`lobster_messages`（对话历史）

```sql
CREATE TABLE lobster_messages (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id      VARCHAR(100) NOT NULL,
  scenario_id  INT NOT NULL,
  role         ENUM('user', 'assistant') NOT NULL,
  content      TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_scenario (user_id, scenario_id)
);
```

**业务说明：**
- 仅用于前端 UI 展示历史记录，不参与 AI 上下文
- Token 消耗不在消息层记录，统一记录在 `lobster_user_usage`
- 历史接口支持分页（默认返回最新 50 条），防止超长列表
- 切换场景时前端加载对应场景的历史（user_id + scenario_id），天然隔离

---

### 表 4：`lobster_user_usage`（用量统计）

```sql
CREATE TABLE lobster_user_usage (
  user_id            VARCHAR(100) PRIMARY KEY,
  total_tokens_used  BIGINT NOT NULL DEFAULT 0,   -- 累计消耗 token（跨所有场景）
  total_messages     INT NOT NULL DEFAULT 0,       -- 累计对话条数
  last_chat_at       DATETIME,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**业务说明：**
- Usage 中间件 SELECT 此表，若无记录则视为 0（新用户自动放行）
- 每次对话完成后**原子更新**（防并发竞争）：
  ```sql
  INSERT INTO lobster_user_usage (user_id, total_tokens_used, total_messages, last_chat_at)
  VALUES (?, ?, 1, NOW())
  ON DUPLICATE KEY UPDATE
    total_tokens_used = total_tokens_used + VALUES(total_tokens_used),
    total_messages    = total_messages + 1,
    last_chat_at      = NOW();
  ```
- 若 OpenClaw 未返回 `usage.total_tokens`，降级为每条消息固定扣 1000 token（可配置），不用 0 防止无限刷

---

### 表 5：`lobster_leads`（留资信息）

```sql
CREATE TABLE lobster_leads (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  user_id       VARCHAR(100),                    -- 已登录用户的 id（可为空）
  name          VARCHAR(100),                    -- 姓名
  contact       VARCHAR(100) NOT NULL,           -- 微信号或手机号
  description   TEXT,                            -- 需求描述
  source        VARCHAR(50) DEFAULT 'token_exhausted',  -- 来源标识
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**业务说明：**
- 用户 token 耗尽后展示留资表单，提交后写入此表
- `source` 标识来源，便于后续统计转化率
- 对应接口：`POST /api/lobster/leads`

---

## 四、API 接口设计

### Base URL
```
https://your-service.pangolinfo.com
```

### 认证方式
所有接口（除健康检查外）在 Header 携带：
```
Authorization: Bearer {JWT}
```

**JWT 对接前提：** 开发前需向现有后端团队确认：JWT 签名算法（HS256/RS256）、userId 所在的 payload 字段名、验证 secret/公钥获取方式。

---

### 接口列表

#### 1. 获取场景列表
```
GET /api/lobster/scenarios
```
响应：
```json
{
  "scenarios": [
    { "id": 1, "slug": "competitor_analysis", "name": "竞品分析" },
    { "id": 2, "slug": "keyword_selection",   "name": "关键词选品" },
    { "id": 3, "slug": "review_insight",      "name": "评价洞察" }
  ]
}
```

---

#### 2. 发送消息（核心接口）
```
POST /api/lobster/chat
```
Request Body：
```json
{
  "scenarioId": 1,
  "message": "帮我分析 B08N5WRWNW"
}
```
响应（正常）：
```json
{
  "reply": "正在调用 Amazon Scrape API...\n\nASIN: B08N5WRWNW\n价格: $39.99...",
  "tokensUsed": 850,
  "tokensRemaining": 99150
}
```
响应（点数耗尽，HTTP 403）：
```json
{
  "error": "TOKEN_LIMIT_EXCEEDED",
  "message": "试用点数已用完",
  "tokensUsed": 100000,
  "tokensRemaining": 0
}
```

---

#### 3. 获取对话历史（分页）
```
GET /api/lobster/history/:scenarioId?limit=50&offset=0
```
响应：
```json
{
  "messages": [
    { "role": "user",      "content": "帮我分析 B08N5WRWNW", "createdAt": "2026-03-20T10:00:00Z" },
    { "role": "assistant", "content": "ASIN: B08N5WRWNW...", "createdAt": "2026-03-20T10:00:02Z" }
  ],
  "total": 24,
  "hasMore": false
}
```

---

#### 4. 获取用户背景信息
```
GET /api/lobster/experience/:scenarioId
```
响应：
```json
{
  "content": "我卖户外装备，目标人群是 25-35 岁男性，亚马逊美国站运营..."
}
```
> 若用户未填写，返回 `{ "content": "" }`，不报 404。

---

#### 5. 保存/更新用户背景信息
```
PUT /api/lobster/experience/:scenarioId
```
Request Body：
```json
{
  "content": "更新后的背景信息..."
}
```

---

#### 6. 获取用量统计
```
GET /api/lobster/usage
```
响应：
```json
{
  "totalTokensUsed": 68000,
  "tokenLimit": 100000,
  "tokensRemaining": 32000,
  "totalMessages": 45
}
```

---

#### 7. 提交留资信息
```
POST /api/lobster/leads
```
Request Body：
```json
{
  "name": "张三",
  "contact": "wx_zhangsan",
  "description": "我需要每天抓取 1000 个 ASIN 的价格数据"
}
```
响应：
```json
{ "success": true }
```
> Auth 中间件提取 userId 自动写入，前端无需传 userId。

---

#### 8. 健康检查
```
GET /health
```

---

## 五、前端页面设计

### 工作台布局

```
┌──────────────────────────────────────────────────────────────┐
│  🦞 Pangolin AI 数据助手                     用量: ████░░ 68% │
│                                                              │
│  [ 竞品分析 ▼ ]    [ 关键词选品 ]    [ 评价洞察 ]             │
├──────────────────┬───────────────────────────────────────────┤
│                  │                                           │
│  我的背景         │  竞品分析助手                              │
│  ──────────────  │  ─────────────────────────────────────── │
│  主营类目:        │                                           │
│  户外服装         │   🤖 你好！我可以帮你抓取任意 ASIN 的      │
│                  │      实时数据，包括价格、BSR、库存、        │
│  目标站点:        │      Buy Box 状态等。输入 ASIN 开始吧。    │
│  亚马逊美国站     │                                           │
│                  │   👤 帮我分析 B08N5WRWNW                   │
│  [编辑背景]       │                                           │
│                  │   🤖 ASIN: B08N5WRWNW                    │
│                  │      价格: $39.99 (-5% 较上周)            │
│  ──────────────  │      BSR:  #234 运动户外 ↑12               │
│  剩余点数         │      Buy Box: 自营 (89% 占比)             │
│  ██████░░ 6.8万  │                                           │
│  Token 剩余      │                                           │
│                  │   ┌─────────────────────────────────┐    │
│  [点数不足?]      │   │ 输入 ASIN 或提问...       [分析] │    │
│  → 联系获取正式   │   └─────────────────────────────────┘    │
│    API 权限       │                                           │
└──────────────────┴───────────────────────────────────────────┘
```

### 点数耗尽页（全屏覆盖）

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│              🦞 试用点数已用完                                 │
│                                                              │
│         您已体验了 Pangolin API 的核心能力                     │
│                                                              │
│     ┌─────────────────────────────────────────┐             │
│     │  获取正式 API 权限，无限次调用             │             │
│     │                                         │             │
│     │  [  联系销售  ]    [  扫码加微信  ]       │             │
│     │                                         │             │
│     │  或填写联系方式，我们主动联系您：          │             │
│     │  姓名: ______________________            │             │
│     │  微信/手机: __________________           │             │
│     │  需求描述: __________________            │             │
│     │                          [ 提 交 ]       │             │
│     └─────────────────────────────────────────┘             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、OpenClaw 对接细节

### Session Key 命名规则
```
x-openclaw-session-key: {userId}:{scenarioSlug}
```
示例：`u_001:competitor_analysis`

**隔离效果：**
- 不同用户 → 不同 session → 完全隔离的 AI 记忆
- 同一用户切换场景 → 不同 session → 场景间上下文不互串

### 每次请求的消息结构
```json
{
  "model": "openclaw:main",
  "messages": [
    {
      "role": "system",
      "content": "{base_system_prompt}\n\n以下是该用户的补充背景：\n{user_experience}"
    },
    {
      "role": "user",
      "content": "{用户当前消息}"
    }
  ],
  "user": "{userId}:{scenarioSlug}",
  "stream": false
}
```

Headers：
```
Authorization: Bearer {OPENCLAW_TOKEN}
x-openclaw-session-key: {userId}:{scenarioSlug}
Content-Type: application/json
```

### Token 计量与降级
```javascript
// 正常取值
const tokensConsumed = response.data.usage?.total_tokens;

// OpenClaw 未返回 usage 时降级
const tokensConsumed = response.data.usage?.total_tokens ?? CONFIG.fallbackTokensPerMessage;
// CONFIG.fallbackTokensPerMessage 默认 1000，可配置
```

---

## 七、执行计划

### Phase 1：后端服务

| 任务 | 说明 |
|---|---|
| 1.0 前置确认 | 向现有后端团队确认 JWT 签名算法、userId 字段名、验证 secret |
| 1.1 项目初始化 | 新建 Node.js + Express 项目，配置 mysql2 连接池、.env |
| 1.2 建表 | 执行 5 张表的 DDL |
| 1.3 写入初始场景数据 | 将 3 个场景 + Joey SOP 写入 `lobster_scenarios` |
| 1.4 Auth 中间件 | 验证 JWT，提取 userId，同步解析 req.body.scenarioId |
| 1.5 Usage 中间件 | 读 `lobster_user_usage`（无记录视为 0），超限返回 TOKEN_LIMIT_EXCEEDED |
| 1.6 并发锁 | activeSessions Set，防同一用户并发双发 |
| 1.7 Rate 限流器 | 复用现有 websiteCustomerService 限流实现 |
| 1.8 CORS 配置 | 开发阶段 allow all，生产限制为 pangolinfo.com |
| 1.9 Chat 接口 | 核心：拼 prompt → 调 OpenClaw → 原子更新用量 → 存消息 → 返回 |
| 1.10 其余接口 | 历史（分页）、背景 CRUD、用量查询、留资提交 |

### Phase 2：前端页面

| 任务 | 说明 |
|---|---|
| 2.1 工作台布局 | 场景 tab + 左侧背景面板 + 右侧对话区 |
| 2.2 场景切换 | 切换时加载对应历史，背景面板随场景变化 |
| 2.3 背景信息编辑 | 弹窗编辑，保存调 PUT 接口 |
| 2.4 点数展示与进度条 | 实时更新，每次回复后刷新剩余量 |
| 2.5 留资引导页 | 点数耗尽时全屏覆盖，含表单和微信引导 |
| 2.6 登录拦截 | 未登录访问龙虾入口跳转注册 |

### Phase 3：SOP 迁移与调优

| 任务 | 说明 |
|---|---|
| 3.1 Joey SOP 迁移 | 将 Joey 龙虾经验整理后写入各场景 `base_system_prompt` |
| 3.2 业务边界测试 | 验证龙虾拒绝非产品相关问题的表现 |
| 3.3 错误处理 Skill 化 | （Joey 负责）常见错误处理写成 OpenClaw skill |
| 3.4 压测 & 上线 | 验证限流、隔离、用量统计准确性 |

---

## 八、关键约束与风险

| 约束/风险 | 说明 |
|---|---|
| 平台 SOP 只读 | `lobster_scenarios.base_system_prompt` 无用户写接口 |
| userId 来源 | 只从 JWT 提取，前端无法伪造 |
| JWT 对接依赖 | 开发前需向现有后端确认 JWT 规格（见 1.0） |
| 并发安全 | 用量更新使用 MySQL 原子 INSERT...ON DUPLICATE KEY UPDATE，防并发竞争 |
| Token 降级 | OpenClaw 不返回 usage 时按固定值 1000 token/条 扣减，不影响统计列的数据类型 |
| 上下文依赖 OpenClaw | 若 OpenClaw session 被清除，AI 上下文丢失，但 MySQL 历史记录仍可展示 |

---

## 九、文件结构（新服务）

```
lobster-service/
├── src/
│   ├── config.js          # 配置：DB、OpenClaw、限流、tokenLimit、fallbackTokensPerMessage
│   ├── db.js              # MySQL 连接池（mysql2/promise）
│   ├── middleware/
│   │   ├── auth.js        # JWT 验证，提取 userId
│   │   ├── usage.js       # Token 用量检查
│   │   ├── concurrency.js # 并发锁（activeSessions Set）
│   │   └── rateLimit.js   # 请求频率限制
│   ├── routes/
│   │   └── lobster.js     # 所有 /api/lobster/* 路由
│   ├── services/
│   │   ├── openclaw.js    # 封装 OpenClaw 调用
│   │   ├── prompt.js      # 拼装 system prompt
│   │   └── usage.js       # 用量原子读写
│   └── index.js           # 入口
├── docs/
│   └── specs/
│       └── 2026-03-20-lobster-demo-design.md
├── package.json
└── .env                   # DB_URL、OPENCLAW_TOKEN、JWT_SECRET、TOKEN_LIMIT
```

---

*文档版本 v1.1，已修正 token 用量模型、留资表设计、并发安全、新用户初始化、分页等问题。下次对话开始开发时，将本文档路径提供给 AI 即可直接开始 Phase 1。*
