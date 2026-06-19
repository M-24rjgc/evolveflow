# ADR-0002：AI 模型选择 DeepSeek 而非 Claude

- **状态**：已接受
- **日期**：2026-06-19（追溯记录；实际决策更早）
- **相关代码**：`packages/evolveflow-runtime/src/ai/deepseek.ts`、`client.ts`

## 背景

EvolveFlow 的 AI 运行时需要一个能做工具调用的大模型后端。
项目最初（README/ARCHITECTURE）描述的是"Anthropic Claude API 集成"，
但实际代码硬编码为 DeepSeek 的 Anthropic 兼容端点
（`https://api.deepseek.com/anthropic`，模型 `deepseek-v4-flash`）。
本文把这一既成事实正式记录为有意的决策，避免未来误解。

## 决策

**选用 DeepSeek（通过其 Anthropic 兼容端点）作为唯一 AI 后端，不使用 Anthropic 官方 Claude API。**

落地方式：

- `ClientConfig` 里的 `baseUrl`/`model`/`provider` 字段标记为 `@deprecated` 并被忽略。
- 构造函数硬编码 `DEEPSEEK_ANTHROPIC_BASE_URL` 和 `DEEPSEEK_MODEL`。
- 复用 Anthropic Messages API 的请求/响应/SSE 格式（DeepSeek 提供兼容层），
  因此零 SDK 依赖、零协议改动即可切换。

## 后果

- **好处**：
  - 成本：DeepSeek 计费通常低于 Claude。
  - 零 SDK 依赖，HTTP 用原生 fetch，SSE 自解析。
  - 切换/升级模型只需改一处常量（`deepseek.ts`）。
- **代价 / 风险**：
  - 依赖第三方兼容层；DeepSeek 上游模型/行为变化可能不提前告知。
  - `deepseek-v4-flash` 这个模型标识在 DeepSeek 官方资料中难以独立验证，
    存在模型名漂移风险。
  - 工具调用、流式、thinking 等特性的兼容程度取决于 DeepSeek 实现，
    需在实际使用中验证。
- **影响文档**：README、ARCHITECTURE 已于本次重构中从"Claude"更正为"DeepSeek"。

## 备选方案

- **Anthropic 官方 Claude API**：能力更完整、文档更明确，但成本更高，
  且需要有效 API Key 渠道。当时未采用。
- **多 provider 抽象层**：支持运行时切换。增加复杂度，当前 YAGNI，
  待确有多模型需求时再考虑（届时应新写一条 ADR 取代本条）。
