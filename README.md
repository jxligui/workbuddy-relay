# workbuddy-relay

把 WorkBuddy（国内版）的模型接入 OpenCode：一个 **OpenCode 服务端插件**，进程内
直连 WorkBuddy 云网关——动态模型目录（带折扣徽章）+ 网页登录。
没有独立本地服务，没有任何需要手动启动的进程。

## 架构

```
OpenCode 服务进程
  └─ 插件（setup，随 OpenCode 加载/卸载）
       ├─ loopback shim（127.0.0.1 随机端口，仅进程内可见）
       │    OpenAI 兼容入口 → 翻译为 WorkBuddy 网关协议：
       │    会话三件套头 + CLI UA + system 头 + 渠道校验救援 + 强制流式 + SSE
       └─ ctx.provider.transform 注册 `workbuddy` provider（baseURL 指向 shim）
           模型目录实时来自 /v3/config（App 通道 UA），折扣徽章进显示名
  → https://copilot.tencent.com/v2/chat/completions（WorkBuddy 云网关，SSE）
```

## 生命周期

- 插件随 OpenCode 服务加载：shim 监听、provider 注册全部就绪。
- 所有 OpenCode 客户端关闭、服务进程退出时，插件 cleanup 自动关闭 shim。
- 无开机自启、无独立进程、无窗口弹框。每个 OpenCode 项目目录一个 shim 实例
  （随机端口互不冲突）。

## 功能

- **动态模型目录**：实时投影 `/v3/config`，显示名带倍率与活动徽章
  （如 `GLM-5.3-Flash · x0.08 · 订阅优先`），夜间折扣等按时段自动生效；
  每 30 分钟自动刷新。
- **凭据管理**：桌面端注入的 WorkBuddy JWT 优先透传；命令行场景用本地凭据
  （`credential.json`），过期自动刷新。

## 关键协议事实

- 聊天只支持流式：强制 `stream:true`，非流式由 shim 聚合 SSE（网关拒绝非流式 `11101`）。
- 必填会话三件套头（`X-Conversation-ID` / `-Request-ID` / `-Message-ID`）；首条消息
  必须 system；否则 `11128`。
- 渠道校验（`11128` 家族）：网关对 system/assistant 内容做指纹匹配，命中时句边界
  插零宽空格重试一次。
- 目录必须用 App 通道 UA（`PRODUCT_UA`）读 `https://www.workbuddy.cn/v3/config`；
  聊天主机是 `copilot.tencent.com`。

## 安装

环境要求：Windows、Node.js 20+（仅登录脚本需要；插件由 OpenCode 自己运行）。

```powershell
# 1. 克隆
git clone https://github.com/jxligui/workbuddy-relay.git
cd workbuddy-relay

# 2. 在 ~/.config/opencode/opencode.json 里注册插件
#    "plugins": ["<克隆路径>/plugin"]

# 3. 登录（首次或凭据失效时；浏览器授权，写 credential.json）
node plugin/login-cli.mjs

# 4. 重启 OpenCode——模型选择器即出现 WorkBuddy 及其模型
```

状态文件在 `%USERPROFILE%\.workbuddy-relay\`：`credential.json`（登录凭据）、
`catalog.json`（目录缓存）。

## 使用

打开 OpenCode 即用。模型选择器选择 WorkBuddy 下的模型。
手动刷新目录/换账号时可用 shim 的管理端点（见 `plugin/index.js` 路由，
loopback + 插件内 secret 鉴权）。

## 风险提示（务必阅读）

WorkBuddy 限制非官方客户端，上游 `11140` 账号级限制已有报告。本项目依赖客户端
自身的接口（非官方开放 API），上游一旦收紧即可能失效。每次调用消耗你自己账号
的真实积分。请自行评估账号风险，使用官方 WorkBuddy 客户端始终是最安全的选择。

## 文件

- `plugin/index.js` — 插件入口（进程内 shim + provider 注册）
- `plugin/login-cli.mjs` — 独立网页登录脚本
- `plugin/lib/constants.mjs` — 网关 URL / UA / 指纹黑名单等协议常量
- `plugin/lib/store.mjs` — `%USERPROFILE%\.workbuddy-relay\` 状态
- `plugin/lib/login.mjs` — 网页登录三步流程
- `plugin/lib/auth.mjs` — token 刷新 + 请求头构造
- `plugin/lib/catalog.mjs` — `/v3/config` 投影 + 活动徽章计算
- `plugin/lib/chat.mjs` — 请求体准备、渠道校验救援、SSE 透传/聚合
