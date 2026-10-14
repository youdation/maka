---
doc_id: subagent-preset-plan
title: "Reusable custom subagents: persistent instructions and composable capabilities"
language: en
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
# Reusable custom subagents: persistent instructions and composable capabilities

[中文](./subagent-preset-plan.zh-CN.md)

Status: **proposal — not started**. Plan for [#5971](https://github.com/apache/maka/issues/5971).
Written 2026-10 for maka.

The issue is an umbrella discussion with three stages. This document turns it
into an ordered implementation plan: what exists today, what each stage
changes, in which files, and how it is verified. It keeps the issue's staging —
each stage ships on its own and is validated in use before the next one starts.

## 1. What exists today

### 1.1 Preset storage: two homes, one authority

| Store | File | Authority |
| --- | --- | --- |
| `FileSettingsStore` (`packages/storage/src/settings-store.ts:149`) | `<workspaceRoot>/settings.json` | Desktop mirror only |
| `RuntimePolicyDocumentOwner` (`packages/storage/src/runtime-policy/policy-document.ts:46`) | `<storageRoot>/runtime-policy.json` | **Authoritative for the runtime** |

The runtime never reads `settings.json` for presets:
`createConfiguredSubagentCatalog`'s `getPresets` reads `runtime-policy.json`
(`packages/runtime-host/src/server/execution-composition.ts:1524`). Desktop main
projects policy → settings for the UI (`runtime-host-settings-ipc-main.ts:303`)
and writes settings → policy mutations (`:448`). `settings-ownership.ts:80`
marks `subagents` Host-owned, so it is not client-owned state.

Consequence for every stage below: **a new preset field is only truly persisted
through `runtime.policy.mutate`.** `SettingsStore.update({ subagents })` alone
never reaches a child. `settings.json` has no document-level schema version or
migration (`AppSettings.schemaVersion: 1` is a literal at
`packages/core/src/settings.ts:594` that nothing branches on); only
`runtime-policy.json` has a real `SCHEMA_VERSION = 4` with v2/v3 upgrade paths.

### 1.2 Preset schema and its three normalizers

`SubagentPreset` (`packages/core/src/subagent-settings.ts:36`) is five facts plus
a route:

```
id, name, description, profile, connectionSlug, model, thinkingLevel?, enabled
```

`normalizeSubagentSettings` (`:64`) is a **dropping** normalizer: a candidate
failing any rule is skipped, an over-long `description` is truncated, an
over-long `name` kills the preset, unknown fields are stripped entirely.
Limits live next to the type and are exported so editors can pre-clamp:
`MAX_SUBAGENT_PRESETS = 64`, `SUBAGENT_PRESET_ID_MAX_CHARS = 128` (charset
`^[A-Za-z0-9._:-]+$`), `SUBAGENT_PRESET_NAME_MAX_CHARS = 128`,
`SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1_000`.

It is called from **five** places, and three of them have to change in lockstep
with the schema:

1. `packages/core/src/settings.ts:993` — `mergeSettings`, whole-section replace.
2. `packages/core/src/settings.ts:1131` — `normalizeSettings`, the only path a
   hand-edited `settings.json` goes through.
3. `packages/core/src/runtime-policy/policy-codec.ts:68` — `decodeRuntimePolicyV2`.
4. `packages/core/src/runtime-policy/policy-codec.ts:209` — `normalizeRuntimePolicy`
   (canonical v4, reached through `decodeCanonicalRuntimePolicy` at `:48`).
5. `packages/core/src/runtime-policy/policy-codec.ts:260` — the
   `set_subagents` mutation decode. **This is the wire validator for a preset
   write.**

Critically, `policy-codec.ts` validates the policy document against
**exact-record key allow-lists** — canonical at `:181-206`, legacy v2/v3 at
`:56-65` and `:189-205` — and `decodeCanonicalRuntimePolicy` additionally
`assertCanonicalValue`s the round trip. A new preset field that is not added to
those lists makes an existing `runtime-policy.json` **throw on decode** rather
than be ignored. Same for `SUBAGENT_SESSION_RUNTIME_SHAPE`
(`packages/core/src/session.ts:519`) on the child-header side.

The whole policy document is size-capped twice: `POLICY_DOCUMENT_MAX_BYTES`
(`policy-document.ts:121`) and `RUNTIME_POLICY_SNAPSHOT_MAX_BYTES` = 48 KB on
the protocol read (`packages/runtime-host/src/protocol/runtime-policy.ts:87`).
Per-preset text lives inside that budget. Snapshots are deep-frozen
(`policy-document.ts:139`).

### 1.3 Write path today

- `apps/desktop/src/renderer/settings/subagent-settings-page.tsx:161` calls
  `props.onUpdate({ subagents: { presets: nextPresets } })` — **the whole array,
  every time**, including for a single `enabled` toggle (`:305`) and delete
  (`:193`).
- `runtime-host-settings-ipc-main.ts:448` turns that into
  `{ kind: 'set_subagents', value: patch.subagents }`.
- `client.updateRuntimePolicy(fn)` (`apps/desktop/src/main/runtime-host-client.ts:447`)
  applies the function against the current policy, so the revision is fresh; the
  mutation itself replaces the array wholesale
  (`packages/storage/src/runtime-policy/policy-document.ts:161`).
- The revision primitive already exists: `RuntimePolicyMutation`
  (`packages/core/src/runtime-policy.ts:186-201`) includes `set_subagents` and
  `patch_agent_settings`; `MutateRuntimePolicyInput` carries `expectedRevision`
  (`:203`); `prepareMutation` enforces it (`policy-document.ts:109-115`).
- Protocol: `runtime.policy.query` / `runtime.policy.mutate`
  (`packages/runtime-host/src/protocol/runtime-policy.ts:302`, `:313`) →
  `HostRuntimePolicyCoordinator`
  (`packages/runtime-host/src/server/runtime-policy-coordinator.ts:97`). There
  is **no** dedicated subagent/preset operation anywhere in
  `packages/runtime-host/src/protocol/*`.

There is **no** model-facing tool for presets. The only conversation-driven
settings tool is `MakaSettingsGet` / `MakaSettingsUpdate`
(`packages/runtime-host/src/server/agent-settings-tools.ts:93`), covering
`personalization`, `memory`, `workspaceInstructions`, `privacy`, `webSearch`
only (`:41-49`), requiring `askUserQuestion` confirmation (`:121`, `:131`),
using `recoveryMode: 'never_auto_retry'` and retrying up to three times against
a moving revision (`:151`). It is exposed as
`HostRuntimePolicyCoordinator.modelTools` (`runtime-policy-coordinator.ts:124`).

### 1.4 Catalog and preset resolution

- Built-in definitions are code, not data: `LOCAL_READ_AGENT_DEFINITION`
  (`packages/runtime/src/agent-catalog.ts:137`, `permissionMode: 'explore'`,
  tools `Read`/`Glob`/`Grep`), `WEB_RESEARCH_AGENT_DEFINITION` (`:161`, `'ask'`,
  `WebSearch`), `IMPLEMENTATION_AGENT_DEFINITION` (`:186`, `'ask'`, worktree
  contract, `toolGroups: ['file_edit']`). Each carries a `contract`
  (capability, invocation, context, workspace, supported write-back),
  `permissionMode`, an exact `tools` array and a `systemPrompt` string.
- A preset contributes **routing and naming only**. It has no runtime definition
  of its own.
- `SubagentPresetListItem` (`:128`) wraps a preset with availability;
  `createConfiguredSubagentCatalog`
  (`packages/runtime/src/configured-subagent-catalog.ts:34`) computes the
  availability ladder in `inspect` (`:44`): `disabled` → `missing_connection` →
  `provider_retired` → `connection_disabled` → `model_disabled` → `available`.
  `resolve(id)` refuses anything not available (`:108`) and drops the
  `availability` wrapper in the result (`:114`).
- `SessionManager.listChildAgents` (`packages/runtime/src/session-manager.ts:3711`)
  lists built-in definitions with availability plus the catalog's presets
  (`:3720`). `agent_list` projects that into the model-visible page
  (`packages/runtime/src/subagent-tools.ts:395`, preset rows `:440-456`,
  `legacy_profiles` `:460-503`, paginated `:458`/`:505-524`), and
  `resolvePresetDefinition` (`:282`) maps a `subagent_id` back to the built-in
  definition of its profile (`:318`).

### 1.5 Spawn and the durable snapshot

This is the mechanism every stage reuses.

1. `agent_spawn` (`packages/runtime/src/subagent-tools.ts:93`) validates the
   profile's contract (write-back mode, isolation — `:199`, `:207`) and calls
   `ctx.spawnChildSession({ agentProfile, subagentId?, prompt })` (`:248`).
2. `SessionManager.resolveChildSessionSelector` (`session-manager.ts:2683`)
   resolves the preset through the catalog and refuses a profile mismatch
   (`:2691`).
3. `spawnChildSessionOnce` (`:3334`) resolves the definition by profile
   (`:3353`), computes `resolvedToolNames` through `resolveChildToolNames`
   (`:1064`) — `assertAgentDefinitionRunnable` then
   `buildToolsForAgentDefinition(availableChildTools, definition)` — and
   persists the durable child header (`:3368-3427`):
   - `permissionMode: definition.permissionMode` (`:3396`; the graph path adds
     `bypass` inheritance at `:2761-2762`, the foreground path does not)
   - `subagentRuntime.systemPrompt = definition.systemPrompt` (`:3414`)
   - `subagentRuntime.toolNames = resolvedToolNames` (`:3415`)
   - `subagentRuntime.definitionVersion` (`:3409`), `presetId` (`:3413`)
4. `SubagentSessionRuntime` (`packages/core/src/session.ts:145`) is validated as
   an **exact shape** (`:519`) with `systemPrompt` bounded by
   `SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS` (`:597`) and `toolNames` bounded
   and deduplicated (`:600-602`).
5. At activation `RuntimeKernel.resolveSubagentActivation`
   (`packages/runtime/src/runtime-kernel.ts:2674`) reads **only the snapshot**,
   rebuilds tools from `snapshot.toolNames` (`:2695`), throws when the snapshot
   cannot be satisfied (`:2700`), and passes `snapshot.systemPrompt` to the
   backend (`:2632`).
6. `AiSdkTurn.resolveSystemPrompt` (`packages/runtime/src/ai-sdk-turn.ts:2928`)
   hands that string to the provider. The backend option is documented as
   "skills + workspace AGENTS.md merged upstream"
   (`packages/runtime/src/ai-sdk-backend.ts:163`).

Two consequences shape the design:

- **The user's `task` is not in the system prompt.** It is the child's first
  user message (`session-manager.ts:3157-3163`). "Role instructions vs this
  task" is therefore already the system-prompt vs first-user-message boundary;
  nothing new is needed for that separation.
- **A preset cannot influence a child's prompt or tools at all today.** Every
  capability below is a new wire from the preset into step 3.

### 1.6 The child tool ceiling

`resolveChildTools` (`execution-composition.ts:1505`) rebuilds the child
composition per session (`createHostChildAgentToolComposition`,
`packages/runtime-host/src/server/child-agent-composition.ts:48`), which unions
every built-in definition's tools against the builtin + host tool set
(`buildChildAgentTools`, `subagent-tools.ts:80`), then narrows it through
`resolveInteractiveToolSurface({ hostTools: [], childTools })` (`:1515`, routing
at `interactive-run-composer.ts:353-391`). `resolveAvailableToolNames` for a
linked child re-derives the same way from `header.subagentRuntime.toolNames`
with a hard length check (`execution-composition.ts:1298-1305`).

So the ceiling today is **host-supplied tool union ∩ model/connection
capability**, with the per-profile `tools` array as the only thing that makes
one child narrower than another. The parent's own authorized tool set is *not*
the bound — see §8, decision 1.

### 1.7 Desktop surface

- `apps/desktop/src/renderer/settings/subagent-settings-page.tsx` — list +
  editor, two levels, owns no CSS. Fields: name, description, id (create only),
  profile, connection, model, thinking, enabled. Save commits the whole preset.
- `apps/desktop/src/renderer/settings/subagent-preset-presentation.ts` — route
  resolution, id suggestion from name, availability projection.
- `apps/desktop/src/renderer/locales/settings-subagents-copy.ts` — typed
  per-locale catalog (`UiCatalog`), zh-CN / zh-TW / en.
- `apps/desktop/src/main/__tests__/subagent-preset-presentation.test.ts` — the
  existing test for that layer.

## 2. Design rules

These hold for every stage; a stage that cannot satisfy one does not ship.

1. **Reuse `SubagentPreset` and the existing mechanisms.** No second
   configuration system, no second catalog, no second spawn path.
2. **Instructions and Skills never grant authority.** They add text and narrow
   availability. Runtime permission checks are unchanged.
3. **Tool selection is always a subset.** Stage 2: subset of the selected
   profile's `tools`. Stage 3: subset of what the host can actually supply.
4. **Everything a child depends on is frozen in its `subagentRuntime`
   snapshot.** Reopen, resume and graph retry reproduce the same prompt and tool
   list or fail loudly.
5. **Unavailable configurations are reported, not silently downgraded.** New
   reasons extend `SubagentPresetAvailability` (`agent-catalog.ts:116`) and
   surface in the editor, in `agent_list view=catalog`, and in `agent_spawn`.
6. **Both editors share one validator.** The Desktop form and the conversation
   tool call the same helpers from `packages/core/src/subagent-settings.ts`;
   neither re-implements a rule.
7. **A schema addition touches every allow-list.** New preset fields must be
   added to the canonical and legacy key lists in `policy-codec.ts` and to
   `SUBAGENT_SESSION_RUNTIME_SHAPE` where a snapshot field is involved, or
   existing documents stop decoding.

## 3. Stage 1 — persistent subagent instructions

**Goal:** a preset holds the role's responsibilities, procedure, behavioral
bounds, output format and acceptance criteria, and every child spawned from it
receives all of it.

### 3.1 Schema

Extend `packages/core/src/subagent-settings.ts`:

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

plus `instructions?: SubagentPresetInstructions` on `SubagentPreset`, and
`SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS` per field (~8_000) exported beside the
existing limits.

Named sub-fields rather than one free-form blob: the issue names five distinct
concerns, the Desktop form needs five labelled fields, and a per-field cap is
answerable ("which part is too long"). All optional, so an existing preset keeps
working unchanged.

Normalization, in the same style as the file:

- each field trimmed; absent, empty or non-string → omitted;
- over the cap → **truncate**, matching `description` — the reasoning at `:27-32`
  (a silently dropped preset the user just saved is the worst outcome) still
  applies;
- reject a field containing control characters other than `\n` / `\t`;
- `instructions` whose every field is empty → omitted entirely.

Because `normalizeSubagentSettings` rebuilds an explicit allow-list object
(`:98-110`), a new field is silently discarded on every read and write until it
is added there. It also does **not** exact-check preset keys, so no
policy-level allow-list change is needed for a preset-level field.

### 3.2 Allow-lists and validators that must move with it

- `normalizeSubagentSettings` itself (`subagent-settings.ts:64`) — the only
  gate, and the reason a new field disappears without a test.
- No `policy-codec.ts` policy-level allow-list change: `subagents` is already a
  permitted policy key (`:189`, `:202`) and presets are rebuilt rather than
  exact-checked. A new *operation kind* (see §3.7) does need a case in
  `normalizeMutationOperation` (`:241`), which throws on an unknown kind.
- No `SUBAGENT_SESSION_RUNTIME_SHAPE` change: instructions are composed into the
  existing `systemPrompt` string, which is already a snapshot field and is
  already bounded (`packages/core/src/session.ts:519`, `:597`).

### 3.3 Prompt composition

Add to `packages/runtime/src/agent-catalog.ts`:

```ts
export function buildAgentSystemPrompt(
  definition: AgentDefinition,
  instructions?: SubagentPresetInstructions,
): string
```

Contract:

- the definition's `systemPrompt` is **always first and never replaced** — it is
  the platform and execution-rule layer;
- user instructions are appended under explicit headings (Responsibilities,
  Procedure, Constraints, Output format, Acceptance criteria), each rendered
  only when present;
- one fixed framing line states that these are the role's standing instructions
  and that the platform and permission rules above them still apply;
- deterministic and order-stable, so a snapshot hash is stable;
- bounded: if the composed prompt would exceed
  `SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS` (`packages/core/src/session.ts:597`),
  truncate the **user** sections with a marker and never the platform section.

### 3.4 Wiring

- `spawnChildSessionOnce` (`session-manager.ts:3414`):
  `systemPrompt: buildAgentSystemPrompt(definition, input.resolvedPreset?.instructions)`.
- `provisionAgentGraphOperatorFromParentSnapshot` (`:2787` and `:2873`): same
  call, and extend the `definition` sub-object of `provisionFingerprint`
  (`:2779`) with the instructions so two graph provisions that differ only in
  instructions get different fingerprints. (The foreground path already keys its
  spawn on the preset id via `childSessionSpawnKey` /
  `childSessionRequestFingerprint`, `:2655-2656`.)
- No `RuntimeKernel` change — it already threads `snapshot.systemPrompt`.

### 3.5 Snapshot and recovery

No new snapshot field: the composed prompt *is* the snapshot. An already-created
child keeps its old prompt after a preset edit — desired, and exactly the
property the existing "changed catalog prompt must not leak" test asserts
(`packages/runtime/src/__tests__/session-manager.test.ts:3171`). Assert it
explicitly for instructions.

`definitionVersion` needs no bump: it describes the code definition, and the
durable prompt no longer tracks the live catalog.

### 3.6 Editors

Desktop (`subagent-settings-page.tsx`): a new `SettingsSection` between purpose
and route, five `TextArea`s, each clamped client-side the way `description` is
(`:509-517`, including the `leadingSpace` trick), with counters from
`SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS`. Extend `settings-subagents-copy.ts` for
all three locales — the `satisfies UiCatalog<SubagentSettingsCopy>` marker makes
a missing locale a compile error.

Conversation: add tools beside `MakaSettingsGet` / `MakaSettingsUpdate` in
`packages/runtime-host/src/server/agent-settings-tools.ts`, in the same style
(zod `.strict()`, `askUserQuestion` confirmation, `recoveryMode:
'never_auto_retry'`, bounded revision retry):

- `MakaSubagentPresetRead` — list presets with their instructions (id, name,
  profile, instruction fields). `categoryHint: 'read'`, `replay_safe`.
- `MakaSubagentPresetWrite` — upsert or delete **one** preset by id, showing the
  user the diff before applying.

The write tool must **not** go through `set_subagents`: two editors doing
whole-array writes lose each other's updates. The Desktop path has the same
defect today — `runtime-host-settings-ipc-main.ts:448` builds the mutation from
the patch and ignores the policy it was just handed, and the optimistic retry
loop re-sends the same stale array. Fix it in the same change (§3.7).

Do not extend `AgentRuntimeSettingsPatch` (`packages/core/src/runtime-policy.ts:178`)
with a subagents key: that patch type is the `patch_agent_settings` payload and
is shaped for scalar field merges, not for a list of presets.

### 3.7 Policy mutation (shared prerequisite)

Add one mutation in `packages/core/src/runtime-policy.ts:186`:

```ts
| {
    readonly kind: 'patch_subagent_presets';
    readonly value:
      | { readonly op: 'upsert'; readonly preset: SubagentPreset }
      | { readonly op: 'delete'; readonly presetId: string };
  }
```

- apply in `applyMutation` (`packages/storage/src/runtime-policy/policy-document.ts:143`):
  upsert replaces by id or appends within `MAX_SUBAGENT_PRESETS`; delete is a
  no-op when absent;
- normalize in `normalizeMutationOperation`
  (`packages/core/src/runtime-policy/policy-codec.ts:241`) with an `exactRecord`
  on `{ op, preset | presetId }`, round-tripping the single preset through
  `normalizeSubagentSettings({ presets: [preset] })` and **rejecting when the
  result is empty** — this is what makes "the store dropped it" impossible to
  miss, in contrast to the silent `set_subagents` path;
- switch the Desktop preset write and the conversation tool onto it; keep
  `set_subagents` for existing clients;
- watch the byte caps (§1.2): an instruction-heavy policy must produce a clear
  error, not a failed write.

### 3.8 Tests

- `packages/core/src/__tests__/settings.test.ts` (extends the preset case at
  `:55`): instruction normalization, truncation at the cap, control-character
  rejection, `instructions` omitted when empty, backward compatibility for a
  preset with no `instructions`.
- `packages/core/src/__tests__/runtime-policy-codec.test.ts` (extends the
  `set_subagents` case at `:114-120`): `patch_subagent_presets` upsert, delete,
  cap, rejection of a preset the normalizer would drop, and that an existing
  policy document containing `instructions` still decodes.
- `packages/runtime/src/__tests__/agent-catalog.test.ts`: composition order, the
  platform section never dropped, truncation, determinism.
- `packages/runtime/src/__tests__/session-manager.test.ts`: a spawned child's
  snapshot contains the composed prompt; a preset without instructions yields
  exactly today's prompt; editing afterwards does not change an existing child;
  graph provision fingerprints differ when only instructions differ (near
  `:749`).
- `apps/desktop/src/main/__tests__/`: follow the `external-agents-settings-page.test.ts`
  pattern (linkedom + `createRoot` + `act`, `node --test` over `dist/main`) —
  there is currently no test that mounts `SubagentSettingsPage`, and
  `renderer/settings/` has no `testing.ts` entry point, so this is the first one.

### 3.9 Acceptance

A user creates a "code reviewer" preset on `local_read` with a procedure and an
output format, sees it in Settings, spawns it from a conversation without
restating any of it, and the child obeys. Editing the instructions afterwards
does not alter an already-created child.

## 4. Stage 2 — tool selection inside the three profiles

**Goal:** a preset narrows the tool set its profile already allows. No
cross-profile composition yet.

### 4.1 Schema

```ts
/** Subset of the selected profile's tools. Absent = the profile's full set. */
toolNames?: string[];
```

Normalization: trimmed, deduplicated, order-preserving; each entry a non-empty
safe id. Unknown names are **kept**, not dropped — they may be tools this host
cannot supply yet, and dropping them would widen the child's surface. They are
reported through availability instead.

### 4.2 Resolution and availability

`buildToolsForAgentDefinition` (`packages/runtime/src/agent-catalog.ts:340`)
gains an optional selection so the spawn path and the activation path filter
identically:

```ts
buildToolsForAgentDefinition(tools, definition, selectedToolNames?)
```

`toolGroups` semantics stay intact: `file_edit` is satisfied by `Write`+`Edit`
*or* `apply_patch`; a selection that leaves a group unsatisfiable is a
validation error, not a silent partial.

Extend `SubagentPresetAvailability` (`agent-catalog.ts:116`) with
`{ status: 'unavailable'; reason: 'unsupported_tool_selection' }` and
`{ status: 'unavailable'; reason: 'missing_tools'; missingTools: string[] }`,
computed in `createConfiguredSubagentCatalog`'s `inspect`
(`configured-subagent-catalog.ts:44`) after the model check. `inspect` already
takes injected dependencies, so it can take a
`getAvailableChildToolNames`-style dependency the same way `getConnection` works.

The spawn path already fails closed through `assertAgentDefinitionRunnable`
(`session-manager.ts:1070`); validate the subset against the same
`availableChildTools` there.

**Fail closed on drift.** `RuntimeKernel.resolveSubagentActivation`
(`runtime-kernel.ts:2700`) throws when the snapshot's tool count cannot be
rebuilt. With selection, a resumed child whose selected tool vanished must hit
that path with a message naming the missing tools — not a quietly narrower
child. `resolveAvailableToolNames` (`execution-composition.ts:1298-1305`) has
the same hard check and needs the same message.

### 4.3 Wiring

- `resolveChildToolNames` (`session-manager.ts:1064`): pass
  `resolvedPreset?.toolNames`.
- `spawnChildSessionOnce` (`:3357`) and the graph provision path (`:2758`):
  same. The result lands in `subagentRuntime.toolNames` (`:3415`) and in
  `resolvedToolNames` / `provisionFingerprint` — no schema change, those fields
  already exist.
- `resolveSubagentActivation` (`runtime-kernel.ts:2695`): filter by the snapshot
  names as today; only the error message changes.
- Worktree contract: unchanged. An `implementation` preset that selects no write
  tools is still a worktree profile; selecting fewer tools never loosens
  isolation.
- Executor children (`:3354`, `:2754`): `resolvedToolNames` is `[]` today; the
  selection must not change that, and the editor must say so.
- `agent_spawn`'s `write_back` / `isolation` validation (`subagent-tools.ts:199`,
  `:207`) keys off the profile contract, not the selection. Leave it.

### 4.4 Editors

Desktop: a tool picker in the route/detail group, populated from the same host
catalog the agent path uses so the two cannot disagree, all selected by default,
`toolGroups` rendered as groups. Available primitives include `CheckboxList` /
`CheckboxListItem` from `@maka/ui`. Changing the profile re-seeds the selection
and warns that the previous selection does not carry over. Render the new
unavailable reasons.

Conversation: `MakaSubagentPresetWrite` accepts `toolNames`; validation errors
name the offending tool and reason, in the spirit of `agent_spawn`'s existing
schema messages.

### 4.5 Tests

- `packages/runtime/src/__tests__/agent-catalog.test.ts`: subsetting, group
  alternatives, missing-tool detection, deterministic ordering.
- `packages/runtime/src/__tests__/configured-subagent-catalog.test.ts`: both new
  unavailable reasons.
- `packages/runtime/src/__tests__/session-manager.test.ts`: child
  `subagentRuntime.toolNames` equals selection ∩ host surface; a resumed child
  keeps the frozen selection; making a selected tool unavailable fails the
  resume with a named error instead of narrowing.
- `packages/runtime-host/src/__tests__/execution-model-composition.test.ts`
  (child composition starts near `:4748`) and `execution-composition.test.ts`:
  the host still supplies the union, and selection only ever narrows it.
- Desktop: picker round-trip, profile-change re-seed, unavailable-reason copy in
  all three locales.

### 4.6 Acceptance

A user clones the `implementation` preset into a "formatter" that may edit files
and run the formatter but not reach the network, and a "reader" that may only
`Read`/`Grep`. Both spawn correctly, refuse to widen after resume, and the
editor explains every configuration it cannot run.


## 5. Stage 3 — composition beyond the three profiles

**Goal:** a preset composes tools, MCP tools and Skills without fitting one of
three fixed combinations.

Start only after Stage 2 has been used and its failure modes are known. Stage 3
has two independent pieces; ship tools first, then MCP.

### 5.1 Tool composition across profiles

Move the effective tool set from "the profile's array" to "an explicit selection
validated against the host's child surface":

- Keep `profile` as the **default template** and add an explicit override that is
  validated, rather than inventing a fourth profile. `agent_spawn`'s `profile`
  enum is derived from `agentProfilesForDefinitions` (`agent-catalog.ts:257`)
  and `requireBuiltinAgentDefinitionByProfile` (`:289`) is on every spawn and
  activation path, so widening the enum is a protocol change; a preset-level
  override is not.
- A composed preset must still declare a contract: workspace mode and
  write-back mode explicitly, validated by `evaluateAgentDefinitionAvailability`
  (`:314`). Worktree isolation stays fail-closed when no worktree executor
  exists.
- `definitionVersion` and the snapshot keep working unchanged — the snapshot is
  names, not a definition.
- `agent_list`'s `legacy_profiles` section (`subagent-tools.ts:460`) and the
  built-in profile path stay as they are; presets simply stop being constrained
  to one profile's array.

### 5.2 MCP scopes

- The preset gains an explicit MCP scope: per connection, an allow-list of tool
  names. No "all tools from this server" default — a server adding a tool must
  not silently widen a saved role.
- Resolution goes through the existing host MCP surface. MCP tools are host
  tools (`execution-composition.ts:1512`), named `mcp__<server>__<tool>`
  (`packages/runtime/src/mcp-tools.ts:233`). Only the user-visible tool name is
  persisted into policy; the internal `McpToolBinding` is opaque and must never
  reach `runtime-policy.json`.
- An unavailable MCP connection produces a new availability reason
  (`mcp_unavailable`) listing the affected scope, never a silent skip.
- MCP access follows the child's snapshot like any other tool, so a resumed child
  cannot gain a server added later.

### 5.3 Skills

- The preset gains an opt-in skill scope (refs or ids). Effect: the child's Skill
  surface is restricted to that set, and the skill block in the child's prompt is
  the opted-in set ∩ what the host can load.
- **Skills never grant tools.** `gateSkillsByHostCapabilities`
  (`packages/runtime/src/skills-context.ts:230`) already hides a skill whose
  declared tools the host lacks; the child's tool set is decided by §5.1/§5.2
  only. A skill declaring a tool the preset did not select stays hidden, and the
  reason is reported.
- A skill's instructions are inlined into the prompt on load, so the preset's own
  instructions and the skill's must be distinguishable — same heading discipline
  as §3.3.

### 5.4 Validation and reporting

Everything in Rules 2-7 applies with more force here, so this stage adds one
shared validator used by both editors and by the spawn path:

```ts
validateSubagentPreset(preset, {
  availableChildTools,
  worktreeChildExecutorAvailable,
  mcpCatalog,
  skillCatalog,
}) → { ok: true } | { ok: false; issues: SubagentPresetIssue[] }
```

Each issue carries the field, a machine reason, and a human sentence; the editor
renders them and `agent_spawn` refuses with the same reasons.

### 5.5 Tests

- Composition: cross-profile selections resolve, stay bounded by the host
  surface, and fail closed on missing tools.
- MCP: allow-list enforcement, a server gaining a tool does not widen a saved
  preset, a removed connection reports a reason, the binding never reaches
  policy.
- Skills: opted-in intersection, a skill's declared tools cannot add a tool,
  prompt separation, resume stability.
- Migration: every Stage-2 configuration keeps working untouched.

## 6. Cross-cutting: what must not regress

| Invariant | Enforced today at | Impact |
| --- | --- | --- |
| A child cannot silently widen after its parent or preset changes | `RuntimeKernel.resolveSubagentActivation` reads only the snapshot (`runtime-kernel.ts:2674`) | Every stage passes only snapshot data |
| An unsatisfiable snapshot fails loudly | `runtime-kernel.ts:2700`; `execution-composition.ts:1298-1305` | Stage 2 extends the message, never weakens the check |
| Snapshot shape is exact and bounded | `SUBAGENT_SESSION_RUNTIME_SHAPE` (`session.ts:519`) | Avoid new snapshot fields; reuse `systemPrompt` / `toolNames` |
| Policy decode is exact-record | `policy-codec.ts:178-206`, `:56-65`, `:463`; `assertCanonicalValue` | Only top-level policy keys need allow-list edits; preset keys are rebuilt |
| Retry and recovery are fingerprint-keyed | `childSessionSpawnKey` / `childSessionRequestFingerprint` (`session-manager.ts:2655`) | Behavior-affecting preset content belongs in the graph fingerprint (§3.4) |
| Permission mode is a floor, not a promise | `definition.permissionMode` (`:3396`), graph `bypass` inheritance (`:2761`) | Instructions and selection never raise it |
| Policy document is size-capped | `policy-document.ts:121`; 48 KB protocol cap (`protocol/runtime-policy.ts:87`) | Budget instruction text; fail with a clear error |
| A normalized preset is the only valid preset | `normalizeSubagentSettings` is the single gate | Both editors and the new mutation route through it |
| `set_subagents` has no Host-side semantic validation | `execution-composition.ts:488-497` validates only `set_shell` | New preset validation must live in the shared normalizer, not the Host |

## 7. Verification

```
npm run build:test
node scripts/run-workspace-tests-parallel.mjs --concurrency=3
npm run typecheck
npm run lint
npm run check:renderer-architecture
```

Targeted during development:

```
npm --workspace @maka/core run build && npm --workspace @maka/core run test:dist
npm --workspace @maka/runtime run build && npm --workspace @maka/runtime run test:dist
npm --workspace @maka/runtime-host run build && npm --workspace @maka/runtime-host run test:dist
npm --workspace @maka/desktop run test:dist
```

The repo is npm workspaces (not pnpm). Tests are `node:test` with
`node:assert/strict`, run against compiled `dist` (`packages/*/package.json`
`test:dist`, and `apps/desktop`'s `node --test --test-force-exit
"dist/main/**/*.test.js"`), so a source change needs a rebuild before its test
is meaningful.

Two gaps worth closing in this work:

- There is **no** test that exercises a fully populated `subagents` section end
  to end — Stage 1 should add the first one, on the `runtime-policy.json` side
  where it matters.
- No test mounts `SubagentSettingsPage`, and `renderer/settings/` has no
  `testing.ts` entry point. Follow `external-agents-settings-page.test.ts`
  (linkedom + `createRoot` + `act`, globals saved and restored, per-locale
  loops); the renderer-architecture checker only lets tests import a feature's
  `index|testing|stories`, so a mount test needs that seam.

New copy must exist in zh-CN, zh-TW and en: `UiCatalog<T> = Record<UiLocale, T>`
makes a missing locale a compile error, and `check-renderer-architecture.mjs`
(`:3871-3935`) validates every `locales/*-copy.ts` for the `satisfies
UiCatalog<…>` marker, zero React/hook/bridge capabilities, and bare package
specifiers only. Desktop renderer changes also need the Storybook settings
stories that `docs/computer-use-ui-coverage.md` tracks for this page.

Manual acceptance per stage is the §3.9 / §4.6 / §5.5 scenario run through the
Desktop app on a real Session, including one resume and one graph retry.

## 8. Decisions still needed

1. **Is the parent's tool set the child's ceiling?** §1.6 shows it is not today:
   child tools come from the host union, narrowed by profile and model
   capability. If "the parent agent's currently authorized capabilities should
   form the upper bound" is to hold literally, that changes `resolveChildTools`
   (`execution-composition.ts:1505`) for **all** children, not just preset ones —
   a behavior change deserving its own issue. Recommended: land the presets work
   against the existing ceiling, which already cannot exceed what the host can
   run and the session's permission mode, and treat parent-derived narrowing
   separately.
2. **Per-field instructions vs one blob** (§3.1). Recommended: per-field.
3. **Does removing write tools from an `implementation` preset change its
   workspace contract?** Recommended: no — isolation follows the contract.
4. **Should an existing child follow a preset edit?** Recommended: no (snapshot
   semantics), which the current tests already assert.
5. **MCP scope granularity** (§5.2): per connection + allow-list, or per
   connection only? Recommended: allow-list.
6. **Where do custom presets live** — Runtime Policy (one global list, as today)
   or per project/workspace? The issue does not say. Recommended: global, as
   today; project scoping is a separate proposal.
7. **The foreground spawn path does not apply the graph path's `bypass`
   inheritance** (`session-manager.ts:3396` vs `:2761`). Pre-existing and
   unrelated, but Stage 2 touches both lines — worth confirming which behavior
   is intended rather than accidentally harmonising it.
8. **Should `MakaSubagentPresetWrite` be Host-owned or Desktop-owned?** The
   preset list lives in the Runtime Policy (Host), so Host-owned beside
   `MakaSettingsGet`/`MakaSettingsUpdate` is the natural fit; the Desktop-owned
   pair (`client-settings-tools.ts`) is client state only. Recommended:
   Host-owned.

## 9. Suggested issue breakdown

| Order | Scope | Depends on |
| --- | --- | --- |
| 1 | `patch_subagent_presets` mutation + codec/normalizer tests | — |
| 2 | `SubagentPresetInstructions` schema + normalization + tests | — |
| 3 | `buildAgentSystemPrompt` + spawn/graph wiring + snapshot tests | 2 |
| 4 | Desktop editor section + copy (3 locales) + stories + first mount test | 2 |
| 5 | Conversation tools `MakaSubagentPresetRead` / `Write`; switch Desktop writes onto the new mutation | 1, 2 |
| 6 | `toolNames` schema + availability reasons + catalog tests | 1 |
| 7 | Spawn/activation/provision wiring for selection + resume tests | 6 |
| 8 | Desktop tool picker | 6 |
| 9 | Cross-profile composition + contract declaration + validation | 6, 7 |
| 10 | MCP scopes | 9 |
| 11 | Skill scopes | 9 |

Steps 1-5 are Stage 1; 6-8 are Stage 2; 9-11 are Stage 3. Each row is
independently reviewable.
