<div align="center">

# 🚀 dsh-qq-group-digest

**QQ 群消息 → AI 总结 → 私聊投递，一条流水线跑完**

DeepSeek-Harness 插件 · 按阈值分批 · 走 DSH 已配置模型 · 群维度报告

[![version](https://img.shields.io/badge/version-v0.5.1-blue.svg)](#版本信息)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](#许可)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.7--rc.2-7c5cff.svg)](https://github.com/deepseek-ai)
[![releases](https://img.shields.io/badge/releases-v0.5.1-lightgrey.svg)](https://github.com/w2018/dsh-qq-group-digest/releases)

[核心配套](#-核心配套luckylilliabot) · [版本信息](#版本信息) · [依赖](#依赖) · [安装使用](#安装使用) · [HTTP 网页服务](#-http-网页服务) · [主要功能](#主要功能) · [数据与目录](#数据与目录)

</div>

---

## 🔗 核心配套：LuckyLilliaBot

> 本插件只负责 **收消息 → 总结 → 投递**。
> QQ 登录与 OneBot11 协议端由 [**LuckyLilliaBot**](https://github.com/LLOneBot/LuckyLilliaBot)（LLBot，支持 OneBot 11 / Satori / Milky）提供。
> 必须先跑起 LuckyLilliaBot 并开启 OneBot11 正向 WebSocket，本插件才有消息可监听。

模型调用走 DSH 的 `ctx.llm.stream` —— 凭证 / 代理 / 重试 / 路由全部沿用 DSH「设置 → 模型」配置，**插件不碰 API Key**。

---

## 版本信息

| 项 | 值 |
| :--- | :--- |
| 当前版本 | **v0.5.1** |
| 发布日期 | 2026-10-25 |
| npm | [dsh-qq-group-digest](https://www.npmjs.com/package/dsh-qq-group-digest) |
| 许可 | [MIT](./LICENSE) © w2018 |

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

### ② 安装插件

**方式 A：npm（推荐，版本锁定）**

```powershell
dsh plugin --profile desktop add dsh-qq-group-digest@0.5.1
```

**方式 B：GitHub 源**

```powershell
dsh plugin --profile desktop add github:w2018/dsh-qq-group-digest
```

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
| 🌐 **web服务** | 可开关的独立端口（默认 1213）网页端：配置页 / 日志页 / 总结记录页，默认密钥登录，与 DSH 设置页并存互不影响 |
| 🧵 **历史上下文** | 每群 `summaries/<群号>.json` 存最近 20 条，每次总结附带此前 `historyCount` 条，避免重复叙述、丢关键结论 |
| 🚫 **信息过滤** | 关键词模糊匹配与按群排除成员，命中的消息不计入总结，丢弃原因计入 `dropReasons` |
| 🧩 **双提示词** | 普通总结（`prompt.system`）与 AI 精细版（`prompt.detailSystem`）各一套 system prompt，可编辑、可一键恢复默认 |
| 🔄 **热重载** | 改 `lib/**` 后点「热重载插件」即可生效，未总结的消息不丢弃 |

---

## 🌐 web服务

插件自带web端，**默认关闭**，需要时在设置页勾选开启。

| 项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| 开关 | **关闭** | 不开就完全不监听端口，不影响 WS 管线与 DSH 设置页 |
| 默认地址 | `http://0.0.0.0:1213` | 局域网内可访问；仅本机用切换至 `127.0.0.1` |
| 密钥验证 | **开启** | 访问验证，密钥随机生成，可自定义。 |

> 📄 **本地渲染 vs AI 精细版**
> 默认用零依赖的本地渲染器把总结排成 Markdown，不额外调用模型、零成本。
> 打开「AI 精细版」开关后，每批总结会**再调一次模型**产出更详尽的长文（建议 800–1200 字、全文不超过 1200 个汉字，带待办复选框与关键链接）；
> 生成失败会自动回退本地渲染，**绝不影响 QQ 投递**。

---

## 📤 多群投递规则

| 场景 | 行为 |
| :--- | :--- |
| 单群触发 | 渲染该群一份报告 → 超长按行分段 → 逐段发送 |
| 多群触发（同一聚合窗口内） | 每群各渲染一份 → 每群各发一条（该群超长才分段） |
| 某群发送失败 | 只影响该群；其它群照常发，失败的群写 `outbox/failed-<时间>-<群号>.md` |
| 网页端总结记录 | 同样按群分组展示，详情只渲染单群单批的 Markdown，不做跨群拼接 |

`delivery.aggregateWindowMs` 只决定「多个群是否在同一批里一起投递」，**不影响是否合并成一条消息**。

---

## 数据与目录

运行期数据在 `$DSH_HOME/storages/qq-digest/`（`storage.dir` 可改）：

| 路径 | 内容 |
| :--- | :--- |
| `messages/<群号>/<日期>.jsonl` | 原始消息，`storage.keepDays` 到期清理 |
| `summaries/<群号>.json` | 每群历史总结（含 AI 精细版 md 与成员发言重点），删掉即清空该群记忆。`md` **只存正文**，不含参与成员表 —— 成员表在网页详情页与导出文件里现场渲染 |
| `group-names.json` | 群号 → 群名映射，连接协议端时自动补齐；删掉会在下次连接后重建 |
| `outbox/` | dryRun 预演与发送失败的兜底报告（多群时每群一个文件） |
| `logs/<日期>.jsonl` | 网页日志页的数据源，按天落盘，默认保留 7 天 |
| `settings.json` | 设置页保存的覆盖配置（含提示词与网页服务密钥）；删掉即回到 `cordis.patch.yml` 初始值 |

<details>
<summary><b>代码结构</b>（点开）</summary>

```
dsh-qq-group-digest/
├── package.json          # 插件清单 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml      # 挂载 + 首次安装的初始配置
├── index.js              # Host 半身：HTTP 路由、运行态装配
├── client.js             # Client 半身：设置页面板 + 侧边栏入口
├── lib/                  # 连接 / 接入 / 分批 / 总结 / 投递 / 存储
│   ├── http/             # 独立网页服务：server / auth / api + static 四页
│   └── summarize/        # 提示词、Markdown 渲染、总结调用
├── doc/                  # 版本变更记录 + 开发计划
└── test/                 # 308 个用例，node:test，零依赖
```

</details>

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

[MIT](./LICENSE) © w2018

本插件以 `dsh.bundle` 组合包形式发布，可经 npm（`dsh plugin add dsh-qq-group-digest`）或 GitHub 源安装。

<sub>本插件不自带 QQ 协议实现，协议能力由 <a href="https://github.com/LLOneBot/LuckyLilliaBot">LuckyLilliaBot</a> 提供</sub>

</div>
