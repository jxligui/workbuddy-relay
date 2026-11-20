# AGENTS.md — workbuddy-relay

本地 OpenAI 兼容中继，把 WorkBuddy（国内版）模型接入 OpenCode。纯 Node ESM，
零运行时依赖，入口 `server.mjs`。

## 约定

- 不加第三方 npm 运行时依赖；写 JSON 用 UTF-8 无 BOM；日期用
  `new Date().toLocaleDateString("sv")` 得 `YYYY-MM-DD`。
- 端口 `41142`，仅监听 `127.0.0.1`；长驻服务，与 OpenCode 生命周期无关；
  单实例靠 `~/.workbuddy-relay/relay.lock`。
- 状态目录 `%USERPROFILE%\.workbuddy-relay\`（可 `WB_RELAY_HOME` 覆盖）：
  `relay.json`(port/secret/pid)、`credential.json`、`catalog.json`、`checkin.json`、
  `relay-crash.log`。管理端点需 `Authorization: Bearer <secret>`。

## 认证

优先透传 OpenCode 桌面端注入的 WorkBuddy JWT（覆盖配置里的 Authorization）；
兜底用 `credential.json` 网页登录凭据 + token 刷新。

## 协议要点（实测）

- 聊天强制 `stream:true`，非流式由中继聚合 SSE。
- 必填 `X-Conversation-ID` / `-Request-ID` / `-Message-ID`（UUID）；首条消息必须
  system；否则 `11128`。system/assistant 内容有渠道指纹校验，命中则插零宽空格重试。
- 目录用 `PRODUCT_UA` 读 `https://www.workbuddy.cn/v3/config`；聊天主机是
  `copilot.tencent.com`。徽章由 `lib/catalog.mjs` 的 `attachDisplayName` 拼接。
- 签到在计费主机 `www.codebuddy.cn`，上游幂等（`code 10001`）。

## 自动签到

启动 `startupCheckin()` + 每 30 分钟 `startCheckinTimer()`；`checkin.json` 当日记录
去重（零网络）。端点 `GET /wb/checkin`、`GET /wb/checkin-status`（`{ today, upstream }`，
无积分）。

## 当前集成

`opencode.json` 维持 `providers.workbuddy`、`plugins: []`；MCP 为 `context7` +
`websearch`。Windows 环境：深信服 `SangforSP` 已禁用（恢复脚本
`sangfor-restore.ps1`）；MySQL/Redis 默认 Stopped。

## 命令

```powershell
node server.mjs            # 启动（幂等）
node refresh-models.mjs    # 刷新目录并重写 opencode.json（BOM 安全）
# 管理端点：GET /healthz /wb/catalog /wb/checkin-status /wb/checkin
```
