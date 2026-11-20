# AGENTS.md — workbuddy-relay

WorkBuddy（国内版）模型的 OpenCode 服务端插件：进程内 loopback shim + 动态
provider 注册 + 每日签到。纯 Node ESM，零运行时依赖。与 dsh-connect-workbuddy
（DSH 插件）同构。

## 架构

- `plugin/index.js`：入口。setup 里用 `node:http` 起 loopback shim（127.0.0.1
  随机端口），`ctx.provider.transform` 注册 `workbuddy` provider（baseURL 指向
  shim），cleanup 关闭 shim 与定时器。
- `plugin/lib/*.mjs`：协议模块（constants/store/login/auth/catalog/chat/checkin），
  与 shim 共用。
- 每个项目目录（location）一个插件实例 = 一个 shim，随机端口互不冲突。
- 生命周期随宿主：OpenCode 服务进程活着 shim 就在，进程退出即关。无开机自启、
  无独立进程。

## 约定

- 不加第三方 npm 运行时依赖；写 JSON 用 UTF-8 无 BOM；日期用
  `new Date().toLocaleDateString("sv")` 得 `YYYY-MM-DD`。
- 状态目录 `%USERPROFILE%\.workbuddy-relay\`（可 `WB_RELAY_HOME` 覆盖）：
  `credential.json`（登录凭据）、`catalog.json`（目录缓存）、`checkin.json`
  （当日签到）。
- shim 鉴权：任意 Bearer 放行到 chat；`/wb/*` 管理端点要求插件内 secret。
  bearer == secret 时用 vault 凭据，否则视为桌面端注入的 JWT 透传网关。

## 协议要点（实测）

- 聊天强制 `stream:true`，非流式由 shim 聚合 SSE。
- 必填 `X-Conversation-ID` / `-Request-ID` / `-Message-ID`（UUID）；首条消息必须
  system；否则 `11128`。system/assistant 内容有渠道指纹校验，命中则插零宽空格重试。
- 目录用 `PRODUCT_UA` 读 `https://www.workbuddy.cn/v3/config`；聊天主机是
  `copilot.tencent.com`。徽章由 `lib/catalog.mjs` 的 `attachDisplayName` 拼接。
- 签到在计费主机 `www.codebuddy.cn`，上游幂等（`code 10001`）。

## 当前集成

`opencode.json`：`plugins` 指向本项目 `plugin/`；无静态 `providers.workbuddy`
（插件动态注册）。MCP 为 `context7` + `websearch`。

## 命令

```powershell
node plugin/login-cli.mjs   # 登录（首次或凭据失效时）
# 插件日志：OpenCode 服务日志（~/.local/share/opencode/log/opencode.log）搜 [workbuddy]
```
