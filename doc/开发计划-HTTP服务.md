# HTTP 服务折叠页 —— 开发计划方案（v0.3.0）

> 状态：**待确认**。确认后按本方案分工实施。

---

## 一、需求拆解

| # | 需求 | 关键约束 |
| :-- | :--- | :--- |
| R1 | 设置页新增「HTTP 服务」折叠卡片 | **默认不勾选开启**；端口默认 **1992** 可改；密钥验证**默认开启**，密钥**随机生成**且可自定义输入 |
| R2 | 独立 HTTP 网页服务 | 与 DSH 自带的 webServer 完全独立，自己监听端口 |
| R3 | ① 配置页 | 覆盖 DSH 插件设置页**全部**设置项 + **可编辑默认总结 AI 提示词** + **一键重置默认提示词** |
| R4 | ② 日志页 | 展示所有有用日志，格式自拟 |
| R5 | ③ 总结记录页（重点） | 比 QQ 简洁版**更精细的 Markdown 文档**；列表 + 预览 + UI 交互自拟 |

---

## 二、总体设计

### 2.1 进程与端口模型

```
DSH 宿主进程
├── ctx.webServer（DSH 自己的 GUI，端口由 DSH 决定）
└── 本插件
    ├── /api/qq-digest/*       ← 挂在 DSH webServer 上（现有设置页用）
    └── http.createServer      ← 新增，独立端口，默认 1992
        ├── GET  /              配置页
        ├── GET  /logs          日志页
        ├── GET  /summaries     总结记录页
        └── /api/*              同名 API（供三个页面 fetch）
```

**⚠️ 端口冲突风险（必须处理）**：1992 恰好是 DSH Web GUI 常用端口之一（本机曾用 `http://127.0.0.1:1992`）。因此：
- 启动前先做 `net.createServer().listen()` 探测，端口被占用时**不静默失败**，把错误写进 `status.http.error`，设置页与网页端都明确提示「端口 1992 已被占用，请换一个」。
- 端口可改（`httpServer.port`，范围 1024–65535）。

### 2.2 配置结构（新增 `httpServer` 段）

```yaml
httpServer:
  enabled: false          # 默认不开启（用户明确要求「默认不勾选」）
  port: 1992
  host: "127.0.0.1"       # 默认仅本机；改 0.0.0.0 时 UI 显示风险提示
  authEnabled: true       # 默认开启密钥验证
  token: ""               # 空 = 首次启用时自动随机生成 32 位并落盘
  sessionHours: 168       # 登录态有效期（Cookie），默认 7 天
prompt:
  system: ""              # 空 = 用内置默认提示词；非空 = 覆盖
```

**密钥生成规则**：`crypto.randomBytes(24).toString('base64url')`（32 字符），只在首次启用且 `token` 为空时生成一次并写入 `settings.json`，**不会每次启动都变**。设置页提供「重新生成」按钮（需二次确认，会让所有已登录会话失效）。

### 2.3 鉴权设计

- 登录页 `GET /login`：输入密钥 → `POST /api/login` 校验（`crypto.timingSafeEqual` 防时序攻击）→ 下发 HttpOnly + SameSite=Lax 的 Cookie（值为 HMAC 签名的过期时间戳，不直接存明文密钥）。
- 所有 `/api/*` 与三个页面均需登录；未登录跳 `/login`。
- 失败限流：同一 IP 连续失败 5 次锁定 60 秒（内存计数，重启清零）。
- `authEnabled=false` 时跳过登录（UI 上标注「⚠️ 已关闭鉴权，任何能访问该端口的人都能看到群聊总结」）。

### 2.4 提示词可编辑（R3 核心）

- 新增 `lib/summarize/prompt-store.js`：
  - `DEFAULT_SYSTEM_PROMPT` = 现有 `buildSystemPrompt()` 的输出（抽成常量导出，行为零变化）。
  - `getSystemPrompt(cfg)` → `cfg.prompt.system || DEFAULT_SYSTEM_PROMPT`。
  - `resetSystemPrompt()` → 清空 `prompt.system`。
- `summarize.js` 改为调用 `getSystemPrompt(modelCfg.promptSystem)`，**默认路径字节级不变**，现有 90 个测试不受影响。
- 网页端提示词编辑框：等宽字体 + 字数统计 + 「恢复默认」按钮（带确认）+ 「预览默认内容」（只读弹层）。
- 保存时校验：非空且长度 50–20000 字符，否则拒绝并提示。

---

## 三、页面设计

### 3.1 配置页 `/`（R3）

单页多卡片，与 DSH 设置页**同一套字段**（复用同一份 `pickEditable` 白名单，保证不漂移），额外多一张「AI 提示词」卡片：

| 卡片 | 内容 |
| :-- | :--- |
| 运行状态 | 启动状态、WS 连接、群进度 `[n/threshold]`、最近错误 |
| HTTP 服务 | 开关、端口、监听地址、鉴权开关、密钥（脱敏显示 + 复制 + 重新生成） |
| 监听目标 | 群列表、忽略自己 |
| 信息过滤 | 关键词、按成员排除（复用现有成员选择交互） |
| 批次触发 | 阈值、宽限期、缓冲上限、最长等待 |
| 总结模型 | 提供商、模型、温度、tokens、超时、重试、历史条数 |
| **AI 提示词** | **可编辑 system prompt + 一键恢复默认 + 预览默认值** |
| 投递目标 | 好友列表、单条字数、合并窗口 |
| 存储与预演 | 保留天数、dryRun、侧边栏入口 |

保存语义与 DSH 设置页一致：校验 → 写 `settings.json` → 热重建运行态；`httpServer` 段变化时**只重启 HTTP 服务本身**，不重建 WS 管线。

### 3.2 日志页 `/logs`（R4）

**数据结构**：新增 `lib/store/logs.js` 环形缓冲 + 落盘。

```json
{ "at": 1730000000000, "level": "info", "scope": "pipeline", "groupId": "123456789", "msg": "冻结批次 b12，31 条", "extra": { "batchId": "b12-123456789", "reason": "threshold" } }
```

- 内存保留最近 2000 条，落盘 `logs/YYYY-MM-DD.jsonl`（保留 7 天，跟随 `storage.keepDays`）。
- 接管 `runtime.logger`：包一层 `TeeLogger`，同时写 DSH logger 与本缓冲，**现有调用点零改动**。
- 页面能力：按级别（info/warn/error）过滤、按群号过滤、关键字搜索、时间范围、自动滚动开关、`/api/logs/stream`（SSE）实时推送、导出当前筛选结果为 `.jsonl`。
- 单页渲染上限 500 条 + 「加载更多」，避免一次拉爆。

### 3.3 总结记录页 `/summaries`（R5，重点）

**数据增强**：现在 `SummaryHistory` 只存纯文本。改为额外存结构化字段（向后兼容，旧记录缺字段按空处理）：

```json
{
  "batchId": "b12-123456789", "groupId": "...", "groupName": "...",
  "at": 1730000000000, "count": 31, "firstSec": ..., "lastSec": ...,
  "ok": true, "model": "workbuddy/deepseek-v4.1-flash", "attempts": 1,
  "participants": [{ "id": "...", "name": "王五", "count": 7 }],
  "text": "（QQ 简洁版原文）",
  "md": "（精细 Markdown 全文）",
  "delivered": 1, "failed": 0
}
```

**Markdown 精细版如何生成（两种模式，默认第一种）**：

| 模式 | 做法 | 成本 |
| :-- | :--- | :--- |
| **A. 本地渲染（默认）** | 用批次结构化数据 + 原总结文本，本地拼装完整 MD：标题、元信息表、要点正文、参与成员表（发言数排序）、时间轴、投递状态 | **零额外 LLM 调用** |
| B. AI 精细版（可选开关） | 额外一次 LLM 调用，用「详细版提示词」产出更长的结构化 MD（含分主题、结论、待办） | 每次总结 +1 次调用 |

- 新增 `lib/summarize/markdown.js`：`renderDetailedMarkdown(entry, records)`。
- MD 示例结构：
  ```markdown
  # 123456789 · AI技术交流分享[北辰]
  > 2026-10-25 11:20–12:05 · 31 条消息 · 12 位发言人 · workbuddy/deepseek-v4.1-flash

  ## 一、本批主线
  ...
  ## 二、要点
  ...
  ## 三、参与成员
  | 成员 | QQ | 发言数 |
  ## 四、投递状态
  ```

**页面交互**：

- 左侧列表（群筛选 + 时间倒序 + 搜索正文），每项显示：群名、时间、条数、状态徽章、两行摘要预览。
- 右侧预览区：渲染后的 Markdown（自带极简 MD 渲染器，不引第三方依赖）+ 顶部工具栏「复制 MD / 下载 .md / 查看原始文本 / 上一批 / 下一批」。
- 空状态、加载失败、无搜索结果各有独立文案。
- 深色模式跟随 `prefers-color-scheme`。

---

## 四、代码改动清单

### 新增文件

| 文件 | 职责 |
| :-- | :--- |
| `lib/http/server.js` | `HttpServer` 类：listen/close、路由分发、静态资源、端口探测 |
| `lib/http/auth.js` | 密钥校验、Cookie 签名、失败限流 |
| `lib/http/api.js` | 网页端 API 路由表（复用 runtime） |
| `lib/http/static/index.html` | 配置页 |
| `lib/http/static/logs.html` | 日志页 |
| `lib/http/static/summaries.html` | 总结记录页 |
| `lib/http/static/login.html` | 登录页 |
| `lib/http/static/app.css` | 三页共用样式（含深色模式） |
| `lib/http/static/md.js` | 极简 Markdown 渲染器（零依赖） |
| `lib/store/logs.js` | 环形日志缓冲 + JSONL 落盘 |
| `lib/summarize/prompt-store.js` | 默认提示词常量 + 读写 + 重置 |
| `lib/summarize/markdown.js` | 精细 Markdown 渲染 |
| `test/http.test.js` | HTTP 服务、鉴权、路由 |
| `test/logs.test.js` | 日志缓冲与落盘 |
| `test/markdown.test.js` | MD 渲染 |
| `test/prompt-store.test.js` | 提示词覆盖与重置 |

### 修改文件

| 文件 | 改动 |
| :-- | :--- |
| `lib/config.js` | 新增 `httpServer` 与 `prompt` 默认值 + 校验 |
| `lib/store/settings.js` | 白名单加 `httpServer.*`、`prompt.system`（`prompt.system` 走单独端点，不进通用白名单，避免误清空） |
| `lib/runtime.js` | 持有 `HttpServer` 实例；配置变化时按需启停；日志 Tee 接管 |
| `lib/summarize/prompt.js` | `buildSystemPrompt()` 改为返回常量，保持导出不变 |
| `lib/summarize/summarize.js` | 用 `getSystemPrompt()` 取提示词 |
| `lib/store/history.js` | entry 增加 `participants` / `md` / `model` / `attempts` 字段（向后兼容） |
| `lib/pipeline.js` | 组装 entry 时补 participants 与 md |
| `index.js` | 新增 `/api/qq-digest/prompt`（GET/POST/reset）、`/api/qq-digest/http`（状态/生成密钥）；`BACKEND_VERSION` → 4 |
| `client.js` | 设置页新增「HTTP 服务」折叠卡片 + 「AI 提示词」折叠卡片 |
| `README.md` / `doc/版本变更记录.md` | 文档与 v0.3.0 变更记录 |

---

## 五、开发阶段与分工

| 阶段 | 内容 | 负责人 | 依赖 |
| :-- | :-- | :-- | :--- |
| **P0** | 配置结构 + 提示词存储 + 日志缓冲（纯 lib 层，可独立单测） | test-dev | 无 |
| **P1** | HTTP 服务骨架 + 鉴权 + 端口探测（依赖 P0 的配置段） | srv-dev | P0 |
| **P2** | 三个页面 + 静态资源 + MD 渲染（依赖 P1 的路由契约） | srv-dev | P1 |
| **P3** | DSH 设置页两张新卡片 + 提示词端点（与 P1 并行，改 client.js 与 index.js） | doc-writer | P0 |
| **P4** | history/pipeline 结构化增强 + markdown.js（与 P1/P2 并行） | core-extractor | P0 |
| **P5** | 全量测试 + README/变更记录 + 端到端验证 | verifier-writer | P1–P4 |

**写作用域划分（避免冲突）**：
- P0/P4：`lib/store/logs.js`、`lib/summarize/prompt-store.js`、`lib/summarize/markdown.js`、`lib/store/history.js`、`lib/pipeline.js`
- P1/P2：`lib/http/**`
- P3：`client.js`、`index.js`
- P5：`test/**`、`README.md`、`doc/**`

---

## 六、边界与异常处理

| 场景 | 行为 |
| :-- | :--- |
| 端口被占用 | 不崩溃，`status.http.error` 明确报错，UI 提示换端口 |
| 密钥为空且启用鉴权 | 首次启动自动生成并落盘，日志打印一次（不打全量，只打前后 4 位） |
| 用户自定义密钥太短 | 拒绝保存，要求 ≥ 16 字符 |
| 关闭鉴权 | 保存时二次确认；页面顶部常驻红色横幅 |
| 提示词被清空 | 视为「恢复默认」，不报错 |
| 提示词超长 | > 20000 字符拒绝保存 |
| 日志落盘失败 | 只影响持久化，内存缓冲继续，页面顶部提示 |
| 总结记录无 md 字段（旧数据） | 首次打开时按 A 模式即时补渲染 |
| HTTP 服务关闭 | 只关自己，绝不影响 DSH webServer 与 WS 管线 |
| 插件热重载 | HTTP 服务随 runtime 重建；端口未变时先 close 再 listen，避免 EADDRINUSE |

---

## 七、验证方式

1. **单测**：`node --test "test/*.test.js"`，新增 ≥ 25 例（鉴权、端口、日志、MD、提示词），总数 ≥ 115，全绿。
2. **默认关闭**：新装/重置配置后 `status.http.enabled === false`，1992 端口无监听。
3. **开启流程**：设置页勾选 → 保存 → `http://127.0.0.1:1992` 出现登录页 → 输错密钥 5 次被锁 → 输对进入配置页。
4. **提示词**：改提示词 → 保存 → 触发一次总结 → 新提示词生效；点「恢复默认」→ 与内置常量逐字一致。
5. **日志页**：发群消息 → 5 秒内日志页出现新条目；筛选/搜索/导出可用。
6. **总结页**：触发总结 → 列表出现新记录 → 预览区渲染完整 MD（含成员表、元信息）→ 下载 `.md` 内容正确。
7. **端口冲突**：手动占用 1992 → 开启服务 → 页面显示明确错误且 DSH 不受影响。
8. **回归**：现有 90 例全绿；DSH 设置页功能无变化；WS 收发正常。

---

## 八、已确认的决策（2026-10-25）

| # | 决策 |
| :-- | :--- |
| 1 | **默认端口 1213**（避开 DSH GUI 的 1992；端口仍可改，范围 1024–65535） |
| 2 | **监听地址 `0.0.0.0`**（局域网可访问；鉴权默认开启，UI 常驻提示「已暴露到局域网」） |
| 3 | 总结记录 MD **默认本地渲染**，另提供 **`summary.aiDetail` 开关**（开启后每次总结额外一次 LLM 调用产出 AI 精细版） |
| 4 | 日志保留 **7 天**（跟 `storage.keepDays`） |
| 5 | 版本号 **v0.3.0** |

> 注：`0.0.0.0` 意味着同网段任何设备都能连到 1213 端口，因此鉴权默认开启是硬要求；`authEnabled=false` 时页面必须常驻红色风险横幅。