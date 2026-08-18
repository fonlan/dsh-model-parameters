# dsh-model-parameters

**中文** | [English](README.en.md)

DSH 插件：当 provider 的模型同步（或任何设置写入）留下缺失能力字段的模型条目时，自动从 [models.dev](https://models.dev) 目录补全——显示名称（display name）、上下文窗口（context window）、最大输出 token、推理档位（reasoning efforts）和输入模态（input modalities）。

大多数 provider 的 `/v1/models` 列表只披露一个 id，别无其他。本插件用本地缓存的目录补全这些同步模型的元数据，让它们立即可用，并报告补全了什么、哪些无法匹配。

## 工作原理

1. 插件监听 `llm-pi-ai` 设置命名空间（`settings/updated`）。任何已提交的变更——新同步的 provider、编辑过的 provider 卡片、手动编辑的 `settings.yaml`——都会触发一次 reconcile。
2. 插件启动时还会对现有配置执行一次全量回填。
3. 对每个缺少 `name` / `contextWindow` / `maxTokens` / `reasoningEfforts` / `input` 任一字段的模型条目，解析出最佳目录条目，只补全缺失字段（fill-only：已有值绝不覆盖）。
4. 写入走设置接缝（`ctx.settings.mutate`），即落到 `~/.dsh/settings.yaml`——与你手动编辑的是同一个文件。

reconcile 天然是 fill-only 的，因此它自己的写入不会造成循环：下一次 `settings/updated` 看到字段已存在，不会产生任何操作。

## 匹配逻辑

models.dev 把同一模型挂在许多 provider 名下（`deepseek-v4-flash` 出现在 57 个 provider 下）。解析是确定性的、且 provider 感知：

1. **Provider 匹配** —— 为 dsh provider 映射的 models.dev provider（显式 `providerMap` 覆盖，其次同 id）。你的 `opencode-go` 路由本身也是 models.dev provider，所以它的条目优先。
2. **完整 id 精确匹配** —— 已带 `vendor/` 前缀的 dsh 模型 id 与完全相同的 models.dev key 匹配。
3. **官方 vendor 优先** —— `officialProviders`（deepseek、openai、anthropic、google、xai……）在冲突时偏向厂商自己的条目。
4. **完整性** —— 两个 limit 都已知的条目优于部分已知的。
5. **provider id 字母序** —— 稳定的兜底。

裸 id 对最后一段路径段做大小写不敏感匹配，所以 `qwen3.7-max` 解析到 `Qwen/Qwen3.7-Max`，`kimi-k2.7-code` 解析到 `Kimi-K2.7-Code`。

## 补全字段

| dsh 字段 | models.dev 来源 | 说明 |
|---|---|---|
| `name` | `name` | 显示名称 |
| `contextWindow` | `limit.context` | token 数 |
| `maxTokens` | `limit.output` | token 数 |
| `reasoningEfforts` | `reasoning_options[type=effort].values` | 恒等字典 `{high:"high", max:"max"}`；pi-ai 档位之外的取值（`default`/`none`/……）被过滤；`toggle`/`budget_tokens` 选项忽略 |
| `input` | `modalities.input` | 过滤到 `text`/`image`（pi-ai 仅接受这两种模态；`pdf`/`audio`/`video` 丢弃） |

目录中无匹配的模型（例如本地网关模型 `hy3-paid`）保持原样，并在补全报告中列为 unmatched。

## 目录缓存与更新

- 目录从 `https://models.dev/api.json` 拉取，缓存在 `~/.dsh/model-parameters/catalog.json`（约 4 MB）。
- 缓存超过 `ttlDays`（默认 **7 天**）后，在下一次 reconcile 时惰性刷新。
- 拉取失败则保留上次成功的缓存；完全没有缓存时插件什么都不补，直到刷新成功。
- 设置卡片有 **立即更新目录并补全** 按钮可强制刷新，并显示上次更新时间与新鲜度。

## 设置卡片

在 DSH 设置 → **插件 → 插件配置** 中会出现一张 "模型参数补全 / Model Parameters" 可展开卡片（样式与内置插件卡片一致，默认折叠）：

- 总开关 + 逐字段开关（`fillName`、`fillContext`、`fillMaxTokens`、`fillReasoning`、`fillInput`）；
- 目录 TTL（天）；
- 可选的 `provider → models.dev provider` 映射覆盖；
- 目录新鲜度（条目数、provider 数、上次更新）；
- 上次补全报告：补全的字段、涉及的 provider、未匹配的模型 id 列表。

插件配置保存在 `model-parameters` 设置命名空间（`~/.dsh/settings.yaml`），例如：

```yaml
model-parameters:
  enabled: true
  ttlDays: 7
  fillName: true
  fillContext: true
  fillMaxTokens: true
  fillReasoning: true
  fillInput: true
  providerMap: {}
  officialProviders:
    - deepseek
    - openai
    - anthropic
    - google
    - xai
```

## 安装

通过 `dsh plugin` 命令安装（`web` 换成你的 profile 名）：

**从 npm 安装**：

```bash
dsh plugin --profile web add @fonlan/dsh-model-parameters
```

**直接从 GitHub 安装**：

```bash
dsh plugin --profile web add github:fonlan/dsh-model-parameters
```

**卸载**：

```bash
dsh plugin --profile web remove @fonlan/dsh-model-parameters
```

## 开发

```bash
pnpm install
pnpm build        # tsc 类型 + tsdown host 与 client bundle
pnpm typecheck
node scripts/verify-catalog.mjs   # 用 models.dev dump 校验匹配逻辑
```

## License

MIT
