# workbuddy-relay

把 WorkBuddy（国内版）的模型接入 OpenCode：本地 OpenAI 兼容中继 + 网页登录 +
带折扣徽章的模型目录。

## 架构

```
OpenCode（providers.workbuddy，openai-compatible）
  → http://127.0.0.1:41142/v1/chat/completions     （本地中继，Bearer 鉴权）
  → 中继翻译：会话三件套头 + CLI UA + system 头 + 渠道校验救援
  → https://copilot.tencent.com/v2/chat/completions（WorkBuddy 云网关，SSE）
```

## 生命周期（常驻服务）

- 开机自动启动：Windows 启动文件夹里的 `workbuddy-relay.cmd`（幂等——端口已有
  健康中继应答时不重复启动）。
- 不自动退出：OpenCode 关闭后中继继续在后台运行（只监听 127.0.0.1，无风险）。
  想停就结束对应的 node 进程或重启机器。
- 单实例锁：`~/.workbuddy-relay/relay.lock`（原子创建 + pid 存活检查 + 死锁接管）。

**认证（双通道，自动选择）**

1. **桌面端 JWT 透传**（推荐）：OpenCode 桌面版自动向发往本中继的请求注入
   WorkBuddy 桌面 App 的 keychain JWT（`app_type=codebuddy`），中继原样转发，
   token 生命周期由桌面端管理。该 JWT 会覆盖配置里的 Authorization。
2. **网页登录凭据**（兜底）：`POST /wb/login/start` 拿授权页 URL → 浏览器登录
   → `GET /wb/login/poll` 取 token → 存 `%USERPROFILE%\.workbuddy-relay\credential.json`；
   过期自动调 `POST /v2/plugin/auth/token/refresh` 刷新（`X-Refresh-Token` 头）。

## 端点

| 路由 | 说明 |
|---|---|
| `GET /healthz` | 无鉴权；登录/目录状态 |
| `GET /v1/models` | OpenAI 模型列表（来自 `/v3/config` 目录投影） |
| `POST /v1/chat/completions` | OpenAI 聊天；流式透传 / 非流式聚合 |
| `POST /wb/login/start` · `GET /wb/login/poll` | 网页登录（需 relay secret） |
| `POST /wb/refresh` | 强制刷新 token |
| `POST /wb/catalog` · `GET /wb/catalog` | 刷新/读取模型目录（含活动徽章计算） |
| `GET /wb/opencode-config` | 生成可粘贴的 providers 配置段 |
| `GET /wb/checkin` | 立即签到（幂等，当天只生效一次） |
| `GET /wb/checkin-status` | 签到状态（本地记录 + 上游状态） |

管理端点要求 relay secret（`relay.json`）；`/v1/*` 接受 secret 或任意 Bearer
（桌面端注入的 JWT）。中继只监听 `127.0.0.1`。

## 关键协议事实

- **聊天只支持流式**：非流式请求被网关以 `11101` 拒绝；中继强制 `stream:true`，
  为非流式客户端聚合 SSE。
- **会话三件套必须**：`X-Conversation-ID` / `X-Conversation-Request-ID` /
  `X-Conversation-Message-ID`（任意合法 UUID），否则 `11128 conversation id missing`。
- **首条消息必须是 system**（同一 11128 门的另一条腿）。
- **渠道校验（11128 家族）**：网关对 system/assistant 内容做指纹匹配
  （"You are an AI agent powered by …"、"You are Claude Code…" 等前缀+子串）。
  被拒时句边界插零宽空格扰动后重试一次。
- **目录必须用 App 通道 UA**：`WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` 读
  `/v3/config` 才有完整模型 + `modelPromotions`/`modelTiers`；CLI UA 只有子集。
  目录主机 `https://www.workbuddy.cn`（与聊天主机 `copilot.tencent.com` 不同）。
- **促销数据结构**：`data.modelPromotions[]` = `{modelIds, badge.label,
  discount.discountedCredits, schedule:{daily:[{start,end}], validFrom, validUntil,
  timezone}}`；`data.modelTiers[]` = 常驻徽章（订阅优先）。徽章是时钟的函数：
  夜间折扣 23:00–7:50 生效时倍率自动变 `x0.50`，白天自动回 `x0.79`。
- **usage 带 `credit`**：每次请求真实扣积分（如 glm-5.3-flash 一次小对话 0.01）。

## 自动签到

- 启动时 `startupCheckin()` + 每 30 分钟 `startCheckinTimer()`（首轮立即执行，覆盖
  跨午夜的长运行）。
- 当天去重：`~/.workbuddy-relay/checkin.json` 单条当日记录（当天已有则零网络请求）
  + 上游幂等（`code 10001`）。
- 签到接口在计费主机 `www.codebuddy.cn`（非网关主机），上游幂等。

## 安装

环境要求：Windows、Node.js 20+。无需 `npm install`（零运行时依赖）。

```powershell
# 1. 克隆
git clone https://github.com/jxligui/workbuddy-relay.git
cd workbuddy-relay

# 2. 启动中继（幂等；端口已有健康实例时不会重复拉起）
node server.mjs

# 3. 生成 OpenCode providers 配置（写入 ~/.config/opencode/opencode.json）
node refresh-models.mjs

# 4. 验证
curl http://127.0.0.1:41142/healthz
```

认证：优先使用 OpenCode 桌面端注入的 WorkBuddy JWT；需要网页登录时调用
`POST /wb/login/start`，在浏览器打开返回的 `verificationUri` 完成登录。

开机自启（可选）：把 `start-relay.cmd` 复制到启动文件夹。

```powershell
Copy-Item start-relay.cmd "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\workbuddy-relay.cmd"
```

## 使用

```powershell
# 已注册到开机启动项 workbuddy-relay.cmd；手动启动也一样（幂等）
node server.mjs

# 模型/折扣变化后刷新 OpenCode 配置（模型名自动带新徽章）
node refresh-models.mjs

# 重新网页登录（换账号/凭据失效时）
# POST /wb/login/start → 浏览器打开 verificationUri → GET /wb/login/poll?id=...
```

OpenCode 侧配置在 `~/.config/opencode/opencode.json` 的
`providers.workbuddy`（由 refresh-models.mjs 维护）。选模型时即见
`GLM-5.3-Flash · x0.08 · 订阅优先` 这类名字。

## 风险提示（务必阅读）

WorkBuddy 限制非官方客户端，上游 `11140` 账号级限制已有报告。本项目依赖客户端
自身的接口（非官方开放 API），上游一旦收紧即可能失效。每次调用消耗你自己账号
的真实积分。请自行评估账号风险，使用官方 WorkBuddy 客户端始终是最安全的选择。

## 文件

- `server.mjs` — 入口（端口 41142，被占用时向上扫描；端口与 secret 存 relay.json；单实例锁防重复拉起；签到调度）
- `lib/constants.mjs` — 网关 URL / UA / 指纹黑名单等协议常量
- `lib/store.mjs` — `%USERPROFILE%\.workbuddy-relay\` 状态（credential/catalog/relay.json）
- `lib/login.mjs` — 网页登录三步流程（`/v2/plugin/auth/*`）
- `lib/auth.mjs` — token 刷新 + 请求头构造（三件套、UA、Origin/Referer）
- `lib/catalog.mjs` — `/v3/config` 投影 + 活动徽章计算（时区/每日窗口/日期范围）
- `lib/chat.mjs` — 请求体准备（system 头、强制流式）、渠道校验救援、SSE 透传/聚合
- `lib/checkin.mjs` — 每日签到（状态查询、幂等领取、当日去重）
- `refresh-models.mjs` — 一键刷新目录并重写 opencode.json
- `start-relay.cmd` — 幂等启动脚本（已复制到 Windows 启动文件夹）
