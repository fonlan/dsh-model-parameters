# 变更记录

兼容性一栏列出该版本支持的 DSH 宿主版本区间。

## 0.2.0

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3`（不变）。

**变更**
- 模型目录下载跟随系统代理（含 Windows）：未设置代理环境变量时，自动读取 Windows Internet Settings（注册表 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，`http=…;https=…` 分协议形式）或 macOS `scutil --proxy` 的手动 HTTP/HTTPS 代理与排除列表，并通过 CONNECT 隧道下载；设置了 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 时行为不变，仍由宿主全局 dispatcher 路由。
- 新增 `src/server/system-proxy.ts`：系统代理探测与解析、绕过列表匹配（后缀/通配/端口/`<local>`/loopback）、CONNECT 隧道传输（代理 Basic 认证、重定向、整体超时）；HTTP/HTTPS 代理按系统配置分别取用，不把一个 scheme 的代理套到另一个上。
- 设置页「模型目录」新增「下载经由」（直连 / 环境变量代理 / Windows / macOS 系统代理 + 脱敏代理地址）与上次下载错误；错误同时写入宿主日志。
- 限制：SOCKS 与 PAC 脚本不求值（仅 PAC 时保持直连并告警）；CIDR 形式的绕过条目不匹配；系统凭据管理器中的代理密码不发送。

**验证**：`pnpm install` / `typecheck` / `build` 通过；`pnpm test`（`scripts/verify-proxy.mjs`）29/29 通过（Windows 注册表与 macOS `scutil` 解析、绕过匹配、路由优先级、PAC/SOCKS 降级、真实 CONNECT 隧道端到端含重定向/404/代理认证/拒绝连接、目录缓存与错误上报、失败时记录尝试路由）；真实 `https://models.dev/api.json` 直连下载成功（232 providers）。

## 0.1.9

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2 || ^0.2.1-rc.3` —— 已在 DSH Desktop `0.2.1-rc.3` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-rc.2` 升到 `0.2.1-rc.3`（`@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5` 不变）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.3`。
- 源码零改动：`0.2.1-rc.2 → 0.2.1-rc.3` 的宿主变化是新增 entry 自定义菜单/图标与两个新槽位（`sidebar.panellist.actions`、`conversation.session.header.views.actions`），未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` / `test`全部通过；隔离 profile 冷启动（真 `0.2.1-rc.3` 宿主）通过。

## 0.1.8

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1 || ^0.2.1-rc.2` —— 已在 DSH Desktop `0.2.1-rc.2` 上验证（隔离 profile 冷启动 `pass-timeout-alive`）；dsh web `0.2.1-alpha.2` 仍落在同一 peer 区间内（门禁离线求值 ADMITTED）。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.1-alpha.1` 升到 `0.2.1-rc.2`（含 `@deepseek-ai/cordis` `4.0.5`、`@deepseek-ai/schemastery` `3.18.5`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-rc.2`。
- 源码零改动：`0.2.1-alpha.1 → 0.2.1-rc.2` 的声明面变化未触及本插件消费的 API（typecheck 通过）。

**验证**：`pnpm install` / `typecheck` / `build` 全部通过（仓库无测试脚本）；隔离 profile 冷启动（真 `0.2.1-rc.2` 宿主）通过。

## 0.1.7

**兼容性**：dsh `^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.1` —— 已在 dsh web `0.2.1-alpha.1` 与 DSH Desktop `0.2.0-rc.2` 上验证。

**变更**
- 构建基线 `@deepseek-ai/*` 从 `0.2.0-rc.1` 升到 `0.2.1-alpha.1`（含 `@deepseek-ai/cordis` `4.0.5-alpha.1`、`@deepseek-ai/schemastery` `3.18.5-alpha.1`）。
- 每个 `@deepseek-ai/dsh*` 的 `peerDependencies` 追加 `|| ^0.2.1-alpha.1`。

**验证**：`pnpm install` / `typecheck` / `build` 全部通过；隔离 profile 冷启动（真 `0.2.1-alpha.1` 宿主）通过。
