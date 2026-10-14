---
doc_id: subagent-preset-plan.zh-CN
title: "可复用的自定义子 Agent：持久工作指令与可组合能力"
language: zh-CN
source_language: en
implementation_status: proposal
document_status: current
translation_status: synced
last_verified: 2026-10-06
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 可复用的自定义子 Agent：持久工作指令与可组合能力

[English](./subagent-preset-plan.md)

状态：**提案 — 尚未开始**。本文是 [#5971](https://github.com/apache/maka/issues/5971) 的实施计划。
写于 2026-10。

该 issue 是一个分三阶段的总体讨论。本文把它整理成一份有序的实施计划：现状是什么、每个阶段改什么、改在哪些文件、以及如何验证。计划沿用 issue 的阶段划分——每个阶段独立交付，并在实际使用中被验证之后才进入下一阶段。

## 1. 现状

### 1.1 预设存储：两处落盘，一个权威

| 存储 | 文件 | 权威性 |
| --- | --- | --- |
| `FileSettingsStore` (`packages/storage/src/settings-store.ts:149`) | `<workspaceRoot>/settings.json` | 仅供桌面端镜像 |
| `RuntimePolicyDocumentOwner` (`packages/storage/src/runtime-policy/policy-document.ts:46`) | `<storageRoot>/runtime-policy.json` | **运行时权威** |

运行时从不为了预设去读 `settings.json`：`createConfiguredSubagentCatalog` 的 `getPresets` 读的是 `runtime-policy.json`（`packages/runtime-host/src/server/execution-composition.ts:1524`）。桌面端 main 进程把 policy 投影成 settings 供 UI 使用（`runtime-host-settings-ipc-main.ts:303`），并把 settings 写入转成 policy mutation（`:448`）。`settings-ownership.ts:80` 把 `subagents` 标记为 Host 所有，因此它不属于 client-owned 状态。

由此得到贯穿后续每个阶段的结论：**新增的预设字段只有经过 `runtime.policy.mutate` 才真正落盘。** 只调用 `SettingsStore.update({ subagents })` 永远不会到达子 Agent。`settings.json` 没有文档级 schema 版本，也没有迁移机制（`AppSettings.schemaVersion: 1` 是 `packages/core/src/settings.ts:594` 的字面量类型，没有任何代码对它分支判断）；只有 `runtime-policy.json` 有真正的 `SCHEMA_VERSION = 4` 以及 v2/v3 升级路径。

### 1.2 预设 schema 与必须同步修改的归一化点

`SubagentPreset`（`packages/core/src/subagent-settings.ts:36`）是五个事实加一条路由：

```
id, name, description, profile, connectionSlug, model, thinkingLevel?, enabled
```

`normalizeSubagentSettings`（`:64`）是一个**丢弃式**归一化器：任何一条规则不通过的候选项会被跳过，超长的 `description` 被截断，超长的 `name` 会让整个预设被丢弃，未知字段被整体剥离。各项上限就定义在类型旁边并导出，方便编辑器提前裁剪：`MAX_SUBAGENT_PRESETS = 64`、`SUBAGENT_PRESET_ID_MAX_CHARS = 128`（字符集 `^[A-Za-z0-9._:-]+$`）、`SUBAGENT_PRESET_NAME_MAX_CHARS = 128`、`SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1_000`。

它有**五处**调用点，其中三处必须随 schema 同步修改：

1. `packages/core/src/settings.ts:993` — `mergeSettings`，整节替换。
2. `packages/core/src/settings.ts:1131` — `normalizeSettings`，手工编辑过的 `settings.json` 唯一必经之路。
3. `packages/core/src/runtime-policy/policy-codec.ts:68` — `decodeRuntimePolicyV2`。
4. `packages/core/src/runtime-policy/policy-codec.ts:209` — `normalizeRuntimePolicy`（规范 v4，经由 `:48` 的 `decodeCanonicalRuntimePolicy` 到达）。
5. `packages/core/src/runtime-policy/policy-codec.ts:260` — `set_subagents` 这条 mutation 的解码。**这是预设写入的线上校验器。**

关键点在于 `policy-codec.ts` 会用**精确键白名单**（canonical 在 `:181-206`，legacy v2/v3 在 `:56-65` 与 `:189-205`）校验 policy 文档，并且 `decodeCanonicalRuntimePolicy` 还会对往返结果做 `assertCanonicalValue`。没有加进这些列表的新预设字段，会让既有的 `runtime-policy.json` 在解码时**直接抛错**，而不是被忽略。子会话 header 一侧的 `SUBAGENT_SESSION_RUNTIME_SHAPE`（`packages/core/src/session.ts:519`）同理。

整个 policy 文档有两处体积上限：`POLICY_DOCUMENT_MAX_BYTES`（`policy-document.ts:121`），以及协议读取时的 `RUNTIME_POLICY_SNAPSHOT_MAX_BYTES` = 48 KB（`packages/runtime-host/src/protocol/runtime-policy.ts:87`）。每个预设的文本都消耗这份预算。快照经 `policy-document.ts:139` 深度冻结。

### 1.3 当前的写入路径

- `apps/desktop/src/renderer/settings/subagent-settings-page.tsx:161` 调用 `props.onUpdate({ subagents: { presets: nextPresets } })`——**每次都是整份数组**，包括只切换一个 `enabled`（`:305`）和删除（`:193`）。
- `runtime-host-settings-ipc-main.ts:448` 把它转成 `{ kind: 'set_subagents', value: patch.subagents }`。
- `client.updateRuntimePolicy(fn)`（`apps/desktop/src/main/runtime-host-client.ts:447`）会针对当前 policy 应用该函数，所以 revision 是新鲜的；但 mutation 本身是整份数组覆盖（`packages/storage/src/runtime-policy/policy-document.ts:161`）。
- revision 原语已经存在：`RuntimePolicyMutation`（`packages/core/src/runtime-policy.ts:186-201`）已包含 `set_subagents` 与 `patch_agent_settings`；`MutateRuntimePolicyInput` 携带 `expectedRevision`（`:203`）；`prepareMutation` 会强制校验（`policy-document.ts:109-115`）。
- 协议：`runtime.policy.query` / `runtime.policy.mutate`（`packages/runtime-host/src/protocol/runtime-policy.ts:302`、`:313`）→ `HostRuntimePolicyCoordinator`（`packages/runtime-host/src/server/runtime-policy-coordinator.ts:97`）。`packages/runtime-host/src/protocol/*` 中**没有**任何专门的子 Agent／预设操作。

目前**没有**面向模型的预设工具。唯一由对话驱动的设置工具是 `MakaSettingsGet` / `MakaSettingsUpdate`（`packages/runtime-host/src/server/agent-settings-tools.ts:93`），只覆盖 `personalization`、`memory`、`workspaceInstructions`、`privacy`、`webSearch`（`:41-49`），要求 `askUserQuestion` 确认（`:121`、`:131`），使用 `recoveryMode: 'never_auto_retry'`，并在 revision 变动时最多重试三次（`:151`）。它以 `HostRuntimePolicyCoordinator.modelTools` 的形式暴露（`runtime-policy-coordinator.ts:124`）。

### 1.4 目录（catalog）与预设解析

- 内置定义是代码而非数据：`LOCAL_READ_AGENT_DEFINITION`（`packages/runtime/src/agent-catalog.ts:137`，`permissionMode: 'explore'`，工具 `Read`/`Glob`/`Grep`）、`WEB_RESEARCH_AGENT_DEFINITION`（`:161`，`'ask'`，`WebSearch`）、`IMPLEMENTATION_AGENT_DEFINITION`（`:186`，`'ask'`，worktree 契约，`toolGroups: ['file_edit']`）。每个定义都带 `contract`（capability、invocation、context、workspace、支持的 write-back）、`permissionMode`、精确的 `tools` 数组以及一个 `systemPrompt` 字符串。
- 预设只贡献**路由与命名**，本身没有运行时定义。
- `SubagentPresetListItem`（`:128`）把预设与可用性包在一起；`createConfiguredSubagentCatalog`（`packages/runtime/src/configured-subagent-catalog.ts:34`）在 `inspect`（`:44`）中计算可用性阶梯：`disabled` → `missing_connection` → `provider_retired` → `connection_disabled` → `model_disabled` → `available`。`resolve(id)` 拒绝任何不可用的预设（`:108`），并在结果中去掉 `availability` 包装（`:114`）。
- `SessionManager.listChildAgents`（`packages/runtime/src/session-manager.ts:3711`）列出带可用性的内置定义，外加 catalog 中的预设（`:3720`）。`agent_list` 把它投影成模型可见的分页（`packages/runtime/src/subagent-tools.ts:395`，预设行 `:440-456`，`legacy_profiles` `:460-503`，分页 `:458`/`:505-524`），而 `resolvePresetDefinition`（`:282`）把 `subagent_id` 映射回其 profile 对应的内置定义（`:318`）。

### 1.5 子会话的创建与持久快照

这是每个阶段都要复用的核心机制。

1. `agent_spawn`（`packages/runtime/src/subagent-tools.ts:93`）校验 profile 的契约（write-back 模式、isolation——`:199`、`:207`）并调用 `ctx.spawnChildSession({ agentProfile, subagentId?, prompt })`（`:248`）。
2. `SessionManager.resolveChildSessionSelector`（`session-manager.ts:2683`）通过 catalog 解析预设，并拒绝 profile 不一致的情况（`:2691`）。
3. `spawnChildSessionOnce`（`:3334`）按 profile 解析定义（`:3353`），通过 `resolveChildToolNames`（`:1064`）计算 `resolvedToolNames`——`assertAgentDefinitionRunnable` 之后接 `buildToolsForAgentDefinition(availableChildTools, definition)`——然后持久化子会话 header（`:3368-3427`）：
   - `permissionMode: definition.permissionMode`（`:3396`；graph 路径在 `:2761-2762` 追加 `bypass` 继承，前台路径没有）
   - `subagentRuntime.systemPrompt = definition.systemPrompt`（`:3414`）
   - `subagentRuntime.toolNames = resolvedToolNames`（`:3415`）
   - `subagentRuntime.definitionVersion`（`:3409`）、`presetId`（`:3413`）
4. `SubagentSessionRuntime`（`packages/core/src/session.ts:145`）按**精确形状**校验（`:519`），其中 `systemPrompt` 受 `SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS` 限制（`:597`），`toolNames` 受长度限制且去重（`:600-602`）。
5. 激活时 `RuntimeKernel.resolveSubagentActivation`（`packages/runtime/src/runtime-kernel.ts:2674`）**只读快照**，从 `snapshot.toolNames` 重建工具（`:2695`），当快照无法满足时抛错（`:2700`），并把 `snapshot.systemPrompt` 交给 backend（`:2632`）。
6. `AiSdkTurn.resolveSystemPrompt`（`packages/runtime/src/ai-sdk-turn.ts:2928`）把这个字符串交给 provider。该 backend 选项的文档说明是「skills + workspace AGENTS.md 已在上游合并」（`packages/runtime/src/ai-sdk-backend.ts:163`）。

由此有两点会直接影响设计：

- **用户的 `task` 不在 system prompt 里。** 它是子会话的第一条 user message（`session-manager.ts:3157-3163`）。所以「固定角色指令 vs 本次 task」这条分界，本来就是 system prompt 与首条 user message 的分界，无需为此新增机制。
- **目前预设完全无法影响子 Agent 的提示词或工具。** 下面每一项能力，都是从预设接到第 3 步的新接线。

### 1.6 子 Agent 的工具上限

`resolveChildTools`（`execution-composition.ts:1505`）按会话重建子 Agent 的工具组合（`createHostChildAgentToolComposition`，`packages/runtime-host/src/server/child-agent-composition.ts:48`），它把每个内置定义的工具对 builtin + host 工具集取并集（`buildChildAgentTools`，`subagent-tools.ts:80`），再经 `resolveInteractiveToolSurface({ hostTools: [], childTools })`（`:1515`，路由逻辑在 `interactive-run-composer.ts:353-391`）收窄。对已链接的子会话，`resolveAvailableToolNames` 会从 `header.subagentRuntime.toolNames` 以同样方式重新推导，并带一处硬性的长度校验（`execution-composition.ts:1298-1305`）。

因此目前的上限是**宿主可提供工具并集 ∩ 模型/连接能力**，而让某个子 Agent 比另一个更窄的唯一因素就是 profile 的 `tools` 数组。主 Agent 自己的授权工具集**不是**这个上界——见 §8 决策 1。

### 1.7 桌面端界面

- `apps/desktop/src/renderer/settings/subagent-settings-page.tsx`——列表 + 编辑器两级结构，自身不拥有任何 CSS。字段：name、description、id（仅新建时）、profile、connection、model、thinking、enabled。保存会提交整份预设。
- `apps/desktop/src/renderer/settings/subagent-preset-presentation.ts`——路由解析、由名称推导 id、可用性投影。
- `apps/desktop/src/renderer/locales/settings-subagents-copy.ts`——按 locale 组织的强类型文案目录（`UiCatalog`），zh-CN / zh-TW / en。
- `apps/desktop/src/main/__tests__/subagent-preset-presentation.test.ts`——该层现有的测试。

## 2. 设计规则

以下规则适用于每个阶段；任何阶段只要无法满足其中一条，就不能交付。

1. **复用 `SubagentPreset` 与既有机制。** 不引入第二套配置体系、第二个 catalog、第二条子会话创建路径。
2. **指令与 Skills 永不授予权限。** 它们只增加文本并收窄可用性。运行时权限检查保持不变。
3. **工具选择永远只做减法。** 第二阶段：所选 profile 的 `tools` 的子集。第三阶段：宿主实际可提供工具的子集。
4. **子 Agent 依赖的一切都冻结在它的 `subagentRuntime` 快照里。** 重新打开、恢复和 graph 重试必须复现同样的提示词与工具列表，否则就要明确报错。
5. **不可用的配置要如实报告，不能静默降级。** 新增原因要扩展 `SubagentPresetAvailability`（`agent-catalog.ts:116`），并出现在编辑器、`agent_list view=catalog` 以及 `agent_spawn` 的报错中。
6. **两个入口共用同一份校验。** 桌面端表单与对话工具都调用 `packages/core/src/subagent-settings.ts` 中的同一组辅助函数，任何一方都不重复实现规则。
7. **新增 schema 字段必须同步所有白名单。** 新的预设字段必须加入 `policy-codec.ts` 的 canonical 与 legacy 键列表；若涉及快照字段，还要加入 `SUBAGENT_SESSION_RUNTIME_SHAPE`，否则既有文档将无法解码。

## 3. 第一阶段——持久工作指令

**目标：** 预设能够保存角色的工作职能、执行步骤、行为边界、输出格式与验收标准，且由它创建的每个子 Agent 都能完整收到这些内容。

### 3.1 Schema

扩展 `packages/core/src/subagent-settings.ts`：

```ts
export interface SubagentPresetInstructions {
  /** What this role is for; when to pick it beyond `description`. */
  responsibilities?: string;
  /** Ordered working procedure. */
  procedure?: string;
  /** Hard behavioral bounds for the role. */
  constraints?: string;
  /** Required output shape. */
  outputFormat?: string;
  /** What "done" means for this role; model-followed, not enforced. */
  acceptanceCriteria?: string;
}
```

并在 `SubagentPreset` 上增加 `instructions?: SubagentPresetInstructions`，同时按字段导出 `SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS`（约 8_000），与现有上限放在一起。

采用具名子字段而不是一个自由文本块，原因有三：issue 明确列出了五个不同关注点；桌面端表单需要五个带标签的字段；按字段设上限才能回答「究竟是哪一部分太长」。这些字段全部可选，因此既有预设的行为完全不变。

归一化沿用该文件既有的风格：

- 每个字段先 trim；缺失、空串或非字符串 → 省略；
- 超出上限 → **截断**，与 `description` 一致——`:27-32` 的理由（用户刚保存的预设被静默丢弃是最糟的结果）依然成立；
- 拒绝包含除 `\n` / `\t` 以外控制字符的字段；
- `instructions` 的所有字段都为空 → 整体省略。

由于 `normalizeSubagentSettings` 会重建一个显式白名单对象（`:98-110`），新字段在加入它之前，会在每次读写时被静默丢弃。它**不会**对预设的键做精确校验，因此预设级字段不需要改动 policy 层的白名单。

### 3.2 必须同步修改的白名单与校验器

- `normalizeSubagentSettings` 本身（`subagent-settings.ts:64`）——唯一的闸门，也是新字段在没有测试时悄然消失的原因。
- `policy-codec.ts` 的 policy 层白名单无需改动：`subagents` 已经是允许的 policy 键（`:189`、`:202`），而预设是被重建而非精确校验的。但**新增一种操作类型**（见 §3.7）需要在 `normalizeMutationOperation`（`:241`）中加一个分支，因为该 switch 遇到未知类型会抛错。
- `SUBAGENT_SESSION_RUNTIME_SHAPE` 无需改动：指令被合成进既有的 `systemPrompt` 字符串，而该字段本来就是受长度限制的快照字段（`packages/core/src/session.ts:519`、`:597`）。

### 3.3 提示词合成

在 `packages/runtime/src/agent-catalog.ts` 中新增：

```ts
export function buildAgentSystemPrompt(
  definition: AgentDefinition,
  instructions?: SubagentPresetInstructions,
): string
```

契约如下：

- 定义的 `systemPrompt` **永远在最前且永不替换**——它是平台与执行规则层；
- 用户指令以明确的标题追加在其后（职责、执行步骤、行为边界、输出格式、验收标准），只有存在的字段才渲染；
- 有一段固定说明：这些是本角色的常驻工作指令，其上的平台规则与权限规则依然有效；
- 结果确定且顺序稳定，使快照哈希稳定；
- 有界：若合成后的提示词将超过 `SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS`（`packages/core/src/session.ts:597`），则截断**用户**部分并留下标记，绝不截断平台部分。

### 3.4 接线

- `spawnChildSessionOnce`（`session-manager.ts:3414`）：`systemPrompt: buildAgentSystemPrompt(definition, input.resolvedPreset?.instructions)`。
- `provisionAgentGraphOperatorFromParentSnapshot`（`:2787` 与 `:2873`）：同样调用，并把 instructions 加入 `provisionFingerprint`（`:2779`）的 `definition` 子对象，使两个仅在指令上不同的 graph provision 得到不同的指纹。（前台路径已经通过 `childSessionSpawnKey` / `childSessionRequestFingerprint` 把 spawn 绑定到预设 id，`:2655-2656`。）
- `RuntimeKernel` 无需改动——它已经在传递 `snapshot.systemPrompt`。

### 3.5 快照与恢复

不需要新增快照字段：合成后的提示词**就是**快照。已创建的子会话在预设被编辑后仍保留旧提示词——这是期望行为，也正是现有「catalog 提示词变更不得泄漏」测试所断言的性质（`packages/runtime/src/__tests__/session-manager.test.ts:3171`）。要为 instructions 显式补一条同样的断言。

`definitionVersion` 不需要提升：它描述的是代码定义，而持久提示词已不再跟随线上 catalog。

### 3.6 编辑器

桌面端（`subagent-settings-page.tsx`）：在「用途」与「路由」之间新增一个 `SettingsSection`，包含五个 `TextArea`，每个都按 `description` 的方式在客户端裁剪（`:509-517`，包含 `leadingSpace` 那个技巧），计数器使用 `SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS`。为三个 locale 补齐 `settings-subagents-copy.ts`——`satisfies UiCatalog<SubagentSettingsCopy>` 标记会让缺少某个 locale 直接变成编译错误。

对话入口：在 `packages/runtime-host/src/server/agent-settings-tools.ts` 中紧邻 `MakaSettingsGet` / `MakaSettingsUpdate` 增加工具，风格保持一致（zod `.strict()`、`askUserQuestion` 确认、`recoveryMode: 'never_auto_retry'`、有界的 revision 重试）：

- `MakaSubagentPresetRead`——列出预设及其指令（id、name、profile、各指令字段）。`categoryHint: 'read'`、`replay_safe`。
- `MakaSubagentPresetWrite`——按 id 新增或更新**单个**预设、或删除单个预设，并在应用前向用户展示差异。

写入工具**不能**走 `set_subagents`：两个编辑入口都用整份数组写入，会互相覆盖。桌面端今天就有同样的缺陷——`runtime-host-settings-ipc-main.ts:448` 用 patch 构造 mutation，完全忽略刚刚拿到的 policy，而乐观重试还会重发同一份陈旧数组。请在同一处一并修掉（§3.7）。

不要把 `AgentRuntimeSettingsPatch`（`packages/core/src/runtime-policy.ts:178`）扩展出 subagents 键：该 patch 类型是 `patch_agent_settings` 的载荷，形态是为标量字段合并设计的，不适合承载预设列表。

### 3.7 Policy mutation（共享前置）

在 `packages/core/src/runtime-policy.ts:186` 增加一条 mutation：

```ts
| {
    readonly kind: 'patch_subagent_presets';
    readonly value:
      | { readonly op: 'upsert'; readonly preset: SubagentPreset }
      | { readonly op: 'delete'; readonly presetId: string };
  }
```

- 在 `applyMutation`（`packages/storage/src/runtime-policy/policy-document.ts:143`）中实现：upsert 按 id 替换或追加，并遵守 `MAX_SUBAGENT_PRESETS`；delete 在不存在时是无操作；
- 在 `normalizeMutationOperation`（`packages/core/src/runtime-policy/policy-codec.ts:241`）中用 `exactRecord` 校验 `{ op, preset | presetId }`，把单个预设经 `normalizeSubagentSettings({ presets: [preset] })` 往返一遍，**结果为空时直接报错**——这正是让「存储把预设悄悄丢了」不可能被忽略的关键，与静默的 `set_subagents` 路径形成对比；
- 把桌面端预设写入与对话工具都切到这条 mutation；`set_subagents` 保留给既有客户端；
- 注意 §1.2 的体积上限：指令很多的 policy 必须给出清晰错误，而不是一次失败的写入。

### 3.8 测试

- `packages/core/src/__tests__/settings.test.ts`（扩展 `:55` 处的预设用例）：指令归一化、超限截断、控制字符拒绝、空 `instructions` 被省略、无 `instructions` 预设的向后兼容。
- `packages/core/src/__tests__/runtime-policy-codec.test.ts`（扩展 `:114-120` 的 `set_subagents` 用例）：`patch_subagent_presets` 的 upsert、delete、上限，以及归一化器会丢弃的预设必须被拒绝；另外验证包含 `instructions` 的既有 policy 文档仍可解码。
- `packages/runtime/src/__tests__/agent-catalog.test.ts`：合成顺序、平台段永不被丢弃、截断、确定性。
- `packages/runtime/src/__tests__/session-manager.test.ts`：新建子会话的快照包含合成后的提示词；无指令的预设产出与今天完全一致的提示词；事后编辑不影响已存在的子会话；仅指令不同时 graph provision 指纹不同（`:749` 附近）。
- `apps/desktop/src/main/__tests__/`：沿用 `external-agents-settings-page.test.ts` 的模式（linkedom + `createRoot` + `act`，`node --test` 跑 `dist/main`）——目前没有任何测试挂载 `SubagentSettingsPage`，且 `renderer/settings/` 没有 `testing.ts` 入口，所以这会是第一个。

### 3.9 验收

用户基于 `local_read` 创建一个「代码审查员」预设，写入执行步骤与输出格式，在设置页看到它，然后直接通过对话派发而无需重复任何要求，子 Agent 遵循这些要求。事后编辑指令不会改变已创建的子会话。

## 4. 第二阶段——在现有 profile 范围内选择工具

**目标：** 预设能够收窄其 profile 本已允许的工具集合。此阶段不做跨 profile 组合。

### 4.1 Schema

```ts
/** Subset of the selected profile's tools. Absent = the profile's full set. */
toolNames?: string[];
```

归一化：trim、去重、保持顺序；每一项必须是非空的安全 id。未知名称要**保留**而非丢弃——它们可能是该宿主暂时无法提供的工具，而丢弃它们反而会放宽子 Agent 的工具面。这类情况通过可用性如实报告。

### 4.2 解析与可用性

`buildToolsForAgentDefinition`（`packages/runtime/src/agent-catalog.ts:340`）增加一个可选的工具选择参数，使创建路径与激活路径以完全一致的方式过滤：

```ts
buildToolsForAgentDefinition(tools, definition, selectedToolNames?)
```

`toolGroups` 语义保持不变：`file_edit` 可由 `Write`+`Edit` **或** `apply_patch` 满足；若某个选择使该组无法满足，应作为校验错误处理，而不是静默地部分满足。

扩展 `SubagentPresetAvailability`（`agent-catalog.ts:116`），增加 `{ status: 'unavailable'; reason: 'unsupported_tool_selection' }` 与 `{ status: 'unavailable'; reason: 'missing_tools'; missingTools: string[] }`，并在 `createConfiguredSubagentCatalog` 的 `inspect`（`configured-subagent-catalog.ts:44`）中于模型检查之后计算。`inspect` 本来就接受依赖注入，因此可以像 `getConnection` 那样再接受一个 `getAvailableChildToolNames` 之类的依赖。

创建路径已经通过 `assertAgentDefinitionRunnable`（`session-manager.ts:1070`）失败闭合；请在那里针对同一份 `availableChildTools` 校验所选子集。

**漂移时必须失败闭合。** 当快照的工具数量无法重建时，`RuntimeKernel.resolveSubagentActivation`（`runtime-kernel.ts:2700`）会抛错。有了工具选择之后，恢复一个所选工具已消失的子会话，必须走到同一条报错路径并指名缺失的工具，而不是悄悄变窄。`resolveAvailableToolNames`（`execution-composition.ts:1298-1305`）持有同样的硬性校验，也需要给出同样的信息。

### 4.3 接线

- `resolveChildToolNames`（`session-manager.ts:1064`）：传入 `resolvedPreset?.toolNames`。
- `spawnChildSessionOnce`（`:3357`）与 graph provision 路径（`:2758`）：同样处理。结果会落到 `subagentRuntime.toolNames`（`:3415`）以及 `resolvedToolNames` / `provisionFingerprint`——无需 schema 改动，这些字段已存在。
- `resolveSubagentActivation`（`runtime-kernel.ts:2695`）：仍按快照名称过滤；只有错误信息需要变化。
- worktree 契约：不变。一个不选任何写入工具的 `implementation` 预设仍是 worktree profile；选择更少的工具绝不会放宽隔离。
- executor 子会话（`:3354`、`:2754`）：如今 `resolvedToolNames` 为 `[]`；工具选择不能改变这一点，且编辑器必须说明。
- `agent_spawn` 的 `write_back` / `isolation` 校验（`subagent-tools.ts:199`、`:207`）依据的是 profile 契约而非工具选择。保持不动。

### 4.4 编辑器

桌面端：在路由/详情分组中加入工具选择器，数据来自 agents 路径所用的同一个宿主 catalog，使两者不可能不一致；默认全选，并按 `toolGroups` 分组渲染。可用原语包括 `@maka/ui` 的 `CheckboxList` / `CheckboxListItem`。切换 profile 时重新初始化选择，并提示之前的选择不会沿用到新 profile。渲染新增的不可用原因。

对话入口：`MakaSubagentPresetWrite` 接受 `toolNames`；校验错误要指名出错工具及原因，风格与 `agent_spawn` 现有的 schema 提示信息一致。

### 4.5 测试

- `packages/runtime/src/__tests__/agent-catalog.test.ts`：取子集、tool group 备选、缺失工具检测、顺序确定性。
- `packages/runtime/src/__tests__/configured-subagent-catalog.test.ts`：两个新增的不可用原因。
- `packages/runtime/src/__tests__/session-manager.test.ts`：子会话的 `subagentRuntime.toolNames` 等于「所选子集 ∩ 宿主工具面」；恢复后的子会话保留冻结的选择；让某个已选工具不可用后，恢复应以指名报错失败而不是变窄。
- `packages/runtime-host/src/__tests__/execution-model-composition.test.ts`（子会话组合测试从 `:4748` 附近开始）与 `execution-composition.test.ts`：宿主仍提供并集，而选择只会收窄它。
- 桌面端：选择器往返、切换 profile 后重初始化、三个 locale 的不可用原因文案。

### 4.6 验收

用户基于 `implementation` 预设复制出两个角色：一个「格式化工具」允许改文件并运行格式化器但不能联网；一个「阅读器」只允许 `Read`/`Grep`。两者都能正常派发，恢复后都不会变宽，且编辑器能解释每一种无法运行的配置。

## 5. 第三阶段——突破三个 profile 的能力组合

**目标：** 预设可以按需组合工具、MCP 工具与 Skills，而不必落入三种固定组合之一。

只有在第二阶段已被实际使用、其失败模式已知之后才启动。第三阶段包含两个相互独立的部分；先交付工具部分，再做 MCP。

### 5.1 跨 profile 的工具组合

把「有效工具集」从「profile 的数组」改造成「一份经过显式校验、面向宿主子会话工具面的选择」：

- 保留 `profile` 作为**默认模板**，另外增加一份经过校验的显式覆盖，而不是发明第四种 profile。因为 `agent_spawn` 的 `profile` 枚举由 `agentProfilesForDefinitions`（`agent-catalog.ts:257`）派生，而 `requireBuiltinAgentDefinitionByProfile`（`:289`）出现在每一条创建与激活路径上，所以放宽该枚举属于协议变更；而预设级的覆盖不是。
- 组合式预设仍必须声明契约：显式声明 workspace 模式与 write-back 模式，并由 `evaluateAgentDefinitionAvailability`（`:314`）校验。当不存在 worktree executor 时，worktree 隔离依然失败闭合。
- `definitionVersion` 与快照保持可用——快照是名称列表，不是定义。
- `agent_list` 的 `legacy_profiles` 段（`subagent-tools.ts:460`）与内置 profile 路径保持不变；预设只是不再被限制在某个 profile 的数组之内。

### 5.2 MCP 范围

- 预设增加显式的 MCP 范围：针对每个连接，给出工具名白名单。不提供「该服务端的全部工具」这种默认值——服务端新增一个工具不得悄悄放宽既有角色。
- 解析必须走既有的宿主 MCP 工具面。MCP 工具属于宿主工具（`execution-composition.ts:1512`），命名为 `mcp__<server>__<tool>`（`packages/runtime/src/mcp-tools.ts:233`）。只有用户可见的工具名会被持久化进 policy；内部的 `McpToolBinding` 是不透明句柄，绝不能进入 `runtime-policy.json`。
- 不可用的 MCP 连接要产生新的可用性原因（`mcp_unavailable`）并列出受影响的范围，不能静默跳过。
- MCP 访问与其他工具一样受子会话快照约束，因此恢复后的子会话无法获得后来新增的服务端。

### 5.3 Skills

- 预设增加可选的 skill 范围（ref 或 id）。效果是：子 Agent 的 Skill 工具面被限制在该集合内，子会话提示词中的 skill 区块是「已选集合 ∩ 宿主可加载集合」。
- **Skills 永不授予工具。** `gateSkillsByHostCapabilities`（`packages/runtime/src/skills-context.ts:230`）已经会隐藏宿主缺少其声明工具的 skill；子 Agent 的工具集只由 §5.1/§5.2 决定。一个声明了预设未选择工具的 skill 会保持隐藏，并报告原因。
- skill 的说明在加载时会被内联进提示词，因此预设自身的指令与 skill 的指令必须可区分——沿用 §3.3 的标题规范。

### 5.4 校验与报告

规则 2-7 在此阶段只会更严格，因此本阶段引入一个共享校验器，供两个编辑入口与创建路径共同使用：

```ts
validateSubagentPreset(preset, {
  availableChildTools,
  worktreeChildExecutorAvailable,
  mcpCatalog,
  skillCatalog,
}) → { ok: true } | { ok: false; issues: SubagentPresetIssue[] }
```

每个 issue 携带字段、机器可读原因与一句人话说明；编辑器渲染它们，`agent_spawn` 以同样的原因拒绝执行。

### 5.5 测试

- 组合：跨 profile 的工具选择可以解析、仍受宿主工具面约束、缺失工具时失败闭合。
- MCP：白名单强制生效、服务端新增工具不会放宽已保存的预设、连接被移除时报告原因、binding 绝不进入 policy。
- Skills：已选集合的交集、skill 声明的工具无法新增工具、提示词中两者可区分、恢复后保持稳定。
- 迁移：所有第二阶段配置原样继续可用。

## 6. 横切关注点：不允许回退的不变量

| 不变量 | 当前强制位置 | 影响 |
| --- | --- | --- |
| 父会话或预设变更后，子 Agent 不会静默变宽 | `RuntimeKernel.resolveSubagentActivation` 只读快照（`runtime-kernel.ts:2674`） | 每个阶段都只传递快照数据 |
| 无法满足的快照必须明确报错 | `runtime-kernel.ts:2700`；`execution-composition.ts:1298-1305` | 第二阶段只扩展报错信息，绝不削弱检查 |
| 快照形状精确且有界 | `SUBAGENT_SESSION_RUNTIME_SHAPE`（`session.ts:519`） | 避免新增快照字段；复用 `systemPrompt` / `toolNames` |
| Policy 解码是精确键校验 | `policy-codec.ts:178-206`、`:56-65`、`:463`；`assertCanonicalValue` | 只有 policy 顶层键需要改白名单；预设键是被重建的 |
| 重试与恢复以指纹为键 | `childSessionSpawnKey` / `childSessionRequestFingerprint`（`session-manager.ts:2655`） | 影响行为的预设内容要进入 graph 指纹（§3.4） |
| permissionMode 是下界而非承诺 | `definition.permissionMode`（`:3396`）、graph 的 `bypass` 继承（`:2761`） | 指令与工具选择都不会提升它 |
| Policy 文档有体积上限 | `policy-document.ts:121`；协议侧 48 KB 上限（`protocol/runtime-policy.ts:87`） | 要为指令文本留预算；失败要给出清晰错误 |
| 只有归一化后的预设才是合法预设 | `normalizeSubagentSettings` 是唯一闸门 | 两个编辑入口与新增 mutation 都必须经过它 |
| `set_subagents` 没有 Host 侧语义校验 | `execution-composition.ts:488-497` 只校验 `set_shell` | 新的预设校验必须放在共享归一化器里，而不是 Host |

## 7. 验证

```
npm run build:test
node scripts/run-workspace-tests-parallel.mjs --concurrency=3
npm run typecheck
npm run lint
npm run check:renderer-architecture
```

开发期间的定向验证：

```
npm --workspace @maka/core run build && npm --workspace @maka/core run test:dist
npm --workspace @maka/runtime run build && npm --workspace @maka/runtime run test:dist
npm --workspace @maka/runtime-host run build && npm --workspace @maka/runtime-host run test:dist
npm --workspace @maka/desktop run test:dist
```

本仓库使用 npm workspaces（不是 pnpm）。测试是 `node:test` 搭配 `node:assert/strict`，针对编译产物 `dist` 运行（`packages/*/package.json` 的 `test:dist`，以及 `apps/desktop` 的 `node --test --test-force-exit "dist/main/**/*.test.js"`），因此改动源码后必须先重新构建，测试才有意义。

本次工作值得顺手补上两个缺口：

- 目前**没有**任何测试端到端地验证一份内容完整的 `subagents` 配置——第一阶段应该补上第一个，而且应该补在真正起作用的 `runtime-policy.json` 一侧。
- 没有任何测试挂载 `SubagentSettingsPage`，`renderer/settings/` 也没有 `testing.ts` 入口。请沿用 `external-agents-settings-page.test.ts`（linkedom + `createRoot` + `act`，保存并恢复全局对象，按 locale 循环）；由于 renderer 架构检查器只允许测试导入某个 feature 的 `index|testing|stories`，挂载测试需要这个接缝。

新文案必须同时存在于 zh-CN、zh-TW 与 en：`UiCatalog<T> = Record<UiLocale, T>` 会让缺少某个 locale 直接变成编译错误，而 `check-renderer-architecture.mjs`（`:3871-3935`）会校验每个 `locales/*-copy.ts` 是否保留 `satisfies UiCatalog<…>` 标记、是否不含任何 React/hook/bridge 能力、以及是否只导入裸包名。桌面端 renderer 改动还需要补上 `docs/computer-use-ui-coverage.md` 为该页面记录的 Storybook settings stories。

每个阶段的手工验收，就是在桌面端真实 Session 上跑一遍 §3.9 / §4.6 / §5.5 的场景，其中包含一次恢复和一次 graph 重试。

## 8. 仍需决策的问题

1. **主 Agent 的工具集是否是子 Agent 的上限？** §1.6 表明今天并不是：子 Agent 的工具来自宿主并集，再由 profile 与模型能力收窄。如果要字面落实「以主 Agent 当前已获授权的能力为上限」，那会改动 `resolveChildTools`（`execution-composition.ts:1505`），影响**所有**子会话而不只是预设子会话——这是一项值得单独立 issue 的行为变更。建议：先让预设相关能力在现有上限下落地（该上限本身已经不会超过宿主能运行的范围与会话的 permissionMode），把「以父会话为准收窄」单独处理。
2. **按字段拆分指令还是单个文本块**（§3.1）。建议：按字段拆分。
3. **从 `implementation` 预设中移除写入工具，是否改变它的 workspace 契约？** 建议：不改变——隔离由契约决定。
4. **已创建的子会话是否应跟随预设编辑？** 建议：不跟随（快照语义），现有测试已经断言了这一点。
5. **MCP 范围粒度**（§5.2）：按连接 + 工具白名单，还是仅按连接？建议：白名单。
6. **自定义预设存放在哪里**——Runtime Policy（今天的单一全局列表）还是按项目/工作区？issue 未说明。建议：暂时保持全局；按项目作用域是另一个独立提案。
7. **前台创建路径没有套用 graph 路径的 `bypass` 继承**（`session-manager.ts:3396` 对 `:2761`）。这是既有差异且与本 issue 无关，但第二阶段会同时改到这两行——建议先确认哪种行为才是预期，而不是顺手把它们「统一」掉。
8. **`MakaSubagentPresetWrite` 归 Host 所有还是桌面端所有？** 预设列表存放在 Runtime Policy（Host）中，因此与 `MakaSettingsGet`/`MakaSettingsUpdate` 并列做为 Host 所有最自然；桌面端那一对（`client-settings-tools.ts`）只管理客户端状态。建议：Host 所有。

## 9. 建议的 issue 拆分

| 顺序 | 范围 | 依赖 |
| --- | --- | --- |
| 1 | `patch_subagent_presets` mutation + codec/归一化测试 | — |
| 2 | `SubagentPresetInstructions` schema + 归一化 + 测试 | — |
| 3 | `buildAgentSystemPrompt` + 创建/graph 接线 + 快照测试 | 2 |
| 4 | 桌面端编辑区 + 三个 locale 文案 + stories + 第一个挂载测试 | 2 |
| 5 | 对话工具 `MakaSubagentPresetRead` / `Write`；把桌面端写入切到新 mutation | 1, 2 |
| 6 | `toolNames` schema + 可用性原因 + catalog 测试 | 1 |
| 7 | 工具选择的创建/激活/provision 接线 + 恢复测试 | 6 |
| 8 | 桌面端工具选择器 | 6 |
| 9 | 跨 profile 组合 + 契约声明 + 校验 | 6, 7 |
| 10 | MCP 范围 | 9 |
| 11 | Skill 范围 | 9 |

第 1-5 步属于第一阶段；6-8 属于第二阶段；9-11 属于第三阶段。每一行都可以独立评审。
