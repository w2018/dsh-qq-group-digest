<div align="center">

# 🚀 dsh-qq-group-digest

**QQ 群消息 → AI 总结 → 私聊投递，一条流水线跑完**

DeepSeek-Harness 插件 · 按阈值分批 · 走 DSH 已配置模型 · 群维度报告

[![version](https://img.shields.io/badge/version-v0.1.0-blue.svg)](#版本信息)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](#许可)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.7--rc.2-7c5cff.svg)](https://github.com/deepseek-ai)
[![releases](https://img.shields.io/badge/releases-none-lightgrey.svg)](#版本信息)

[核心配套](#-核心配套luckylilliabot) · [版本信息](#版本信息) · [依赖](#依赖) · [安装使用](#安装使用) · [主要功能](#主要功能) · [数据与目录](#数据与目录)

</div>

---

## 🔗 核心配套：LuckyLilliaBot

> 本插件只负责 **收消息 → 总结 → 投递**。
> QQ 登录与 OneBot11 协议端由 [**LuckyLilliaBot**](https://github.com/LLOneBot/LuckyLilliaBot)（LLBot，支持 OneBot 11 / Satori / Milky）提供。
> 必须先跑起 LuckyLilliaBot 并开启 OneBot11 正向 WebSocket，本插件才有消息可监听。

模型调用走 DSH 的 `ctx.llm.stream` —— 凭证 / 代理 / 重试 / 路由全部沿用你在 DSH「设置 → 模型」里配好的那套，**插件不碰 API Key**。

---

## 版本信息

| 项 | 值 |
| :--- | :--- |
| 当前版本 | **v0.1.0** |
| Releases | 暂无发布版本（v0.1.0 尚未打 tag） |

---

## 依赖

| 项 | 要求 |
| :--- | :--- |
| **DSH** | ≥ `0.1.7-rc.2`，且已配置至少一个可用模型 |
| **Node** | ≥ `22`（用内置全局 `WebSocket`，无第三方 ws 依赖） |
| **QQ 协议端** | [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) 已登录，且开启 OneBot11 正向 WebSocket |
| **权限** | 接收私聊的账号必须是 bot 账号的好友 |

插件本身 **零运行时依赖** —— 只用 Node 内置模块 + DSH 宿主服务。

---

## 安装使用

### ① 在 LuckyLilliaBot 里开正向 WS

在 LLBot 的 OneBot11 配置里开启正向 WebSocket 服务，记下 `host` / `port` / `token`：

```json
{
  "enable": true,
  "name": "dsh-digest",
  "host": "127.0.0.1",
  "port": 3001,
  "token": "换成你自己的口令",
  "messagePostFormat": "array",
  "enableForcePushEvent": true,
  "reportSelfMessage": false
}
```

改完重启 LLBot，确认端口在听：

```powershell
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3001
```

### ② 源码安装

编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`：

1. `dependencies` 里加 `"dsh-qq-group-digest": "link:D:/本地安装文件夹/dsh-qq-group-digest"`
2. `dsh.profile.bundles` 数组末尾加 `"dsh-qq-group-digest"`

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
pnpm install
```

> ⚠️ **首次 `pnpm install` 可能失败**
> 报 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`（`拒绝访问 (os error 5)`），因为 DSH 桌面进程正占用 `node_modules`。
> **把同一条命令再跑一次即可**，第二次走增量路径。

安装或改 `cordis.patch.yml` 后 **重启一次 DSH**。之后所有日常配置都在设置页里改，不需要再重启。

### ③ 在设置页配置

打开 **DSH → 设置 → 存储与预演**

> 💡 **首次建议先开 `dryRun`**进行测试：报告只写 `outbox/dryrun-*.md`，不发 QQ。
> 核对文本满意后，到「设置 → QQ 群总结 → 存储与预演」关掉即可，热生效。

**保存并生效** = 校验 → 写 `settings.json` → 热重建运行态。WS 断一下再重连，DSH 不用重启。

---

## 主要功能

| 能力 | 说明 |
| :--- | :--- |
| 📥 **群消息采集** | 连 OneBot11 正向 WS，按群白名单采集，`(group_id, message_id)` 双层 LRU 去重，`real_seq` 排序并标注缺口 |
| ⏱ **批次触发** | 每群独立状态机，`threshold` / `maxBuffer` / `maxWaitMs` 任一满足即冻结，`freezeGraceMs` 抗乱序抖动 |
| 🧠 **总结与降级** | 路由三级回退（显式配置 → DSH 默认 → 首个可用），失败指数退避重试；重试耗尽降级为原始摘录，**仍然投递** |
| 📤 **报告投递** | 多群按群名 / 群号编号成一份报告，超长按行分段，段间间隔防风控；全部失败兜底写 `outbox/failed-*.md` |
| 🧵 **历史上下文** | 每群 `summaries/<群号>.json` 存最近 20 条，每次总结附带此前 `historyCount` 条，避免重复叙述、丢关键结论 |
| 🔄 **热重载** | 改 `lib/**` 后点「热重载插件」即可生效，未总结的消息不会丢 |

---

## 数据与目录

运行期数据在 `$DSH_HOME/storages/qq-digest/`（`storage.dir` 可改）：

| 路径 | 内容 |
| :--- | :--- |
| `messages/<群号>/<日期>.jsonl` | 原始消息，`storage.keepDays` 到期清理 |
| `summaries/<群号>.json` | 每群历史总结，删掉即清空该群记忆 |
| `outbox/` | dryRun 预演与发送失败的兜底报告 |
| `settings.json` | 设置页保存的覆盖配置；删掉即回到 `cordis.patch.yml` 初始值 |

<details>
<summary><b>代码结构</b>（点开）</summary>

```
dsh-qq-group-digest/
├── package.json          # 插件清单 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml      # 挂载 + 首次安装的初始配置
├── index.js              # Host 半身：HTTP 路由、运行态装配
├── client.js             # Client 半身：设置页面板 + 侧边栏入口
├── lib/                  # 连接 / 接入 / 分批 / 总结 / 投递 / 存储
├── doc/                  # 版本变更记录
└── test/                 # 85 个用例，node:test，零依赖
```

</details>

---

## 更新代码后如何生效

| 改了什么 | 怎么生效 | 要重启 DSH 吗 |
| :--- | :--- | :---: |
| 设置项（阈值、群号、模型、dryRun…） | 设置页点「保存并生效」 | ❌ 不要 |
| `client.js` | 刷新页面（F5） | ❌ 不要 |
| `index.js` / `lib/**` | 设置页点「热重载插件」 | ❌ 不要 |
| `cordis.patch.yml` / `package.json` / 依赖 | 重启 DSH | ✅ 要 |

> 热重载的做法是把 `lib/` 整棵树复制到 `generations/` 再 `import`，绕过 Node 的 ESM 缓存；
> 新一代起来之后才停旧的，未总结消息经 `snapshotPending` / `restorePending` 继承。
> 但 **新增路由 / 改动 `apply()` 装配逻辑**属于 `index.js` 本身，这类改动仍需重启一次 DSH。

---

## 卸载

1. 从 profile 的 `package.json` 删掉 `dsh-qq-group-digest` 依赖行与 `dsh.profile.bundles` 里的条目
2. 删 `node_modules/dsh-qq-group-digest`（link 目录）
3. `pnpm install`
4. 重启 DSH

运行期数据 `$DSH_HOME/storages/qq-digest/` 不会被自动删除，自行决定是否清理。

---

<div align="center">

## 许可

[MIT](https://opensource.org/licenses/MIT) © w2018

<sub>本插件不自带 QQ 协议实现，协议能力由 <a href="https://github.com/LLOneBot/LuckyLilliaBot">LuckyLilliaBot</a> 提供</sub>

</div>
