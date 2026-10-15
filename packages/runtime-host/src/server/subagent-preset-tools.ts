/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  isSafeSubagentPresetId,
  isSubagentProfile,
  normalizeSubagentSettings,
  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
  SUBAGENT_PRESET_ID_MAX_CHARS,
  SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS,
  SUBAGENT_PRESET_NAME_MAX_CHARS,
  type SubagentPreset,
  type SubagentPresetInstructions,
} from '@maka/core/subagent-settings';
import type {
  Revision,
  RuntimePolicyMutation,
  RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';

/**
 * Preset writes go through the preset-scoped mutation rather than
 * `set_subagents`. A whole-array write from this tool would silently drop a
 * preset the user added in Settings while the conversation was open, and both
 * entry points are required to act on the same presets.
 */
export interface HostSubagentPresetMutationAuthority {
  read(): Promise<RuntimePolicySnapshot>;
  mutate(
    buildOperation: (policy: RuntimePolicySnapshot) => RuntimePolicyMutation,
  ): Promise<
    | { readonly kind: 'committed'; readonly revision: Revision }
    | {
        readonly kind: 'revision_conflict';
        readonly expectedRevision: Revision;
        readonly actualRevision: Revision;
      }
  >;
}

const instructionSchema = z
  .object({
    responsibilities: z.string().max(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS).optional(),
    procedure: z.string().max(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS).optional(),
    constraints: z.string().max(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS).optional(),
    outputFormat: z.string().max(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS).optional(),
    acceptanceCriteria: z.string().max(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS).optional(),
  })
  .strict();

const presetWriteSchema = z
  .object({
    id: z
      .string()
      .max(SUBAGENT_PRESET_ID_MAX_CHARS)
      .refine(isSafeSubagentPresetId)
      .describe('Stable preset id: letters, digits, dot, colon, underscore, dash.'),
    name: z.string().min(1).max(SUBAGENT_PRESET_NAME_MAX_CHARS),
    description: z.string().max(SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS).optional(),
    profile: z
      .string()
      .refine(isSubagentProfile)
      .describe('One of local_read, web_research, implementation.'),
    connectionSlug: z.string().min(1).max(128),
    model: z.string().min(1).max(512),
    thinkingLevel: z.string().min(1).max(32).optional(),
    instructions: instructionSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// One tool, three actions. A separate read and write tool made the model pick
// between them before it knew what it needed, and one discriminator keeps the
// confirmation path in a single place. `strip` drops the other actions' fields,
// so a stray `preset_id` on `list` is ignored rather than rejected.
const presetToolParameters = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strip(),
  z.object({ action: z.literal('upsert'), preset: presetWriteSchema }).strip(),
  z
    .object({
      action: z.literal('delete'),
      preset_id: z.string().max(SUBAGENT_PRESET_ID_MAX_CHARS).refine(isSafeSubagentPresetId),
    })
    .strip(),
]);

type PresetToolInput = z.infer<typeof presetToolParameters>;

export interface SubagentPresetProjection {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly profile: string;
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel?: string;
  readonly enabled: boolean;
  readonly instructions?: SubagentPresetInstructions;
}

type PresetListResult = {
  readonly kind: 'maka_subagent_presets';
  readonly presets: readonly SubagentPresetProjection[];
};

type PresetUpdateResult =
  | {
      readonly kind: 'maka_subagent_preset_update';
      readonly ok: true;
      readonly applied: boolean;
      readonly reason?: 'cancelled';
      readonly changes?: readonly string[];
      readonly message: string;
      readonly presets: readonly SubagentPresetProjection[];
    }
  | {
      readonly kind: 'maka_subagent_preset_update';
      readonly ok: false;
      readonly applied: false;
      readonly reason: 'confirmation_unavailable' | 'invalid_preset';
      readonly message: string;
      readonly presets: readonly SubagentPresetProjection[];
    };

type PresetToolResult = PresetListResult | PresetUpdateResult;

type PresetToolContext = Parameters<NonNullable<MakaTool<PresetToolInput, PresetToolResult>['impl']>>[1];

/** Model-visible subagent preset surface (issue #5971, stage 1). */
export function buildHostSubagentPresetTools(
  authority: HostSubagentPresetMutationAuthority,
): readonly MakaTool[] {
  const tool: MakaTool<PresetToolInput, PresetToolResult> = {
    name: 'MakaSubagentPreset',
    displayName: 'Manage subagent presets',
    description:
      'Read and change the reusable subagent presets the main agent may delegate to. ' +
      'action=list returns every preset with its stored role instructions; action=upsert creates or ' +
      'replaces ONE preset by id; action=delete removes one by id. Every write requires confirmation, ' +
      'and replacing a preset keeps its id, so sessions already referencing it keep working. ' +
      'Use only when the user asks to create, review, or change a subagent role.',
    parameters: presetToolParameters,
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    executionSemantics: 'exclusive_step',
    impl: async (input, context) => {
      const initial = await authority.read();
      if (input.action === 'list') {
        return { kind: 'maka_subagent_presets', presets: projectPresets(initial) };
      }
      if (input.action === 'delete') {
        const existing = findPreset(initial, input.preset_id);
        if (!existing) {
          return unchanged(initial, `No preset with id "${input.preset_id}" exists; nothing was removed.`);
        }
        return deletePreset(authority, context, initial, existing, input.preset_id);
      }
      const stored = normalizedPreset(input.preset);
      if (!stored) {
        return {
          kind: 'maka_subagent_preset_update',
          ok: false,
          applied: false,
          reason: 'invalid_preset',
          message:
            'That preset is not valid, so nothing was written. Check the id, profile, connection, ' +
            'model, and the text limits, then retry.',
          presets: projectPresets(initial),
        };
      }
      return upsertPreset(authority, context, initial, stored);
    },
  };
  return [tool];
}

async function upsertPreset(
  authority: HostSubagentPresetMutationAuthority,
  context: PresetToolContext,
  initial: RuntimePolicySnapshot,
  preset: SubagentPreset,
): Promise<PresetToolResult> {
  const existing = findPreset(initial, preset.id);
  const changes = describePresetWrite(existing, preset);
  const confirmed = await confirm(
    context,
    `Apply this subagent preset change?\n${changes.map((change) => `• ${change}`).join('\n')}`,
    'Write preset',
  );
  if (confirmed === 'unavailable') return confirmationUnavailable(initial, 'written');
  if (confirmed === 'cancelled') return cancelled(await authority.read(), changes);
  return commit(authority, changes, () => ({
    kind: 'patch_subagent_presets',
    value: { op: 'upsert', preset },
  }));
}

async function deletePreset(
  authority: HostSubagentPresetMutationAuthority,
  context: PresetToolContext,
  initial: RuntimePolicySnapshot,
  existing: SubagentPreset,
  presetId: string,
): Promise<PresetToolResult> {
  const changes = [`Delete preset "${existing.name}" (${presetId})`];
  const confirmed = await confirm(
    context,
    `Delete this subagent preset?\n${changes.map((change) => `• ${change}`).join('\n')}`,
    'Delete preset',
  );
  if (confirmed === 'unavailable') return confirmationUnavailable(initial, 'deleted');
  if (confirmed === 'cancelled') return cancelled(await authority.read(), changes);
  return commit(authority, changes, () => ({
    kind: 'patch_subagent_presets',
    value: { op: 'delete', presetId },
  }));
}

async function commit(
  authority: HostSubagentPresetMutationAuthority,
  changes: readonly string[],
  build: (policy: RuntimePolicySnapshot) => RuntimePolicyMutation,
): Promise<PresetToolResult> {
  // The preset list can move between the read that produced the confirmation
  // text and the commit. Each attempt re-reads, and because the mutation
  // addresses ONE preset, a concurrent edit to a different preset survives.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await authority.mutate(build);
    if (result.kind !== 'committed') continue;
    return {
      kind: 'maka_subagent_preset_update',
      ok: true,
      applied: true,
      changes,
      message: `Updated ${changes.length} subagent preset change${changes.length === 1 ? '' : 's'}.`,
      presets: projectPresets(await authority.read()),
    };
  }
  throw new Error('Runtime Policy kept changing while the subagent preset was written');
}

async function confirm(
  context: PresetToolContext,
  question: string,
  applyLabel: string,
): Promise<'applied' | 'cancelled' | 'unavailable'> {
  if (!context.askUserQuestion) return 'unavailable';
  const answer = await context.askUserQuestion([
    {
      question,
      options: [
        { label: applyLabel, description: 'Write the listed change to the stored presets now.' },
        { label: 'Cancel', description: 'Leave every stored preset unchanged.' },
      ],
    },
  ]);
  return answer.answers[0]?.answer === applyLabel ? 'applied' : 'cancelled';
}

function confirmationUnavailable(
  snapshot: RuntimePolicySnapshot,
  verb: 'written' | 'deleted',
): PresetUpdateResult {
  return {
    kind: 'maka_subagent_preset_update',
    ok: false,
    applied: false,
    reason: 'confirmation_unavailable',
    message: `The preset was not ${verb} because confirmation is unavailable.`,
    presets: projectPresets(snapshot),
  };
}

function cancelled(
  snapshot: RuntimePolicySnapshot,
  changes: readonly string[],
): PresetUpdateResult {
  return {
    kind: 'maka_subagent_preset_update',
    ok: true,
    applied: false,
    reason: 'cancelled',
    changes,
    message: 'The subagent preset was not changed.',
    presets: projectPresets(snapshot),
  };
}

function unchanged(snapshot: RuntimePolicySnapshot, message: string): PresetUpdateResult {
  return {
    kind: 'maka_subagent_preset_update',
    ok: true,
    applied: false,
    message,
    presets: projectPresets(snapshot),
  };
}

function findPreset(snapshot: RuntimePolicySnapshot, id: string): SubagentPreset | undefined {
  return snapshot.policy.subagents.presets.find((preset) => preset.id === id);
}

function projectPresets(snapshot: RuntimePolicySnapshot): SubagentPresetProjection[] {
  return snapshot.policy.subagents.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    profile: preset.profile,
    connectionSlug: preset.connectionSlug,
    model: preset.model,
    ...(preset.thinkingLevel !== undefined ? { thinkingLevel: preset.thinkingLevel } : {}),
    enabled: preset.enabled,
    ...(preset.instructions !== undefined ? { instructions: preset.instructions } : {}),
  }));
}

/**
 * Run the model's draft through the store's own normalizer, so the confirmed
 * diff describes what will actually be stored rather than what was typed.
 */
function normalizedPreset(draft: z.infer<typeof presetWriteSchema>): SubagentPreset | undefined {
  const [preset] = normalizeSubagentSettings({
    presets: [
      {
        id: draft.id,
        name: draft.name,
        description: draft.description ?? '',
        profile: draft.profile,
        connectionSlug: draft.connectionSlug,
        model: draft.model,
        ...(draft.thinkingLevel !== undefined ? { thinkingLevel: draft.thinkingLevel } : {}),
        ...(draft.instructions !== undefined ? { instructions: draft.instructions } : {}),
        enabled: draft.enabled ?? true,
      },
    ],
  }).presets;
  return preset;
}

function describePresetWrite(existing: SubagentPreset | undefined, next: SubagentPreset): string[] {
  const changes = [
    `${existing ? 'Replace' : 'Create'} preset "${next.id}" (${next.profile}, ${next.model})`,
  ];
  for (const field of ['name', 'description', 'connectionSlug', 'model', 'profile'] as const) {
    const before = existing?.[field];
    if (before !== undefined && before !== next[field]) {
      changes.push(`${field}: ${before} → ${next[field]}`);
    }
  }
  if (existing?.enabled !== next.enabled) {
    changes.push(`enabled: ${String(existing?.enabled ?? false)} → ${String(next.enabled)}`);
  }
  for (const [field, text] of Object.entries(next.instructions ?? {})) {
    const before = existing?.instructions?.[field as keyof SubagentPresetInstructions];
    if (before === text) continue;
    changes.push(before === undefined ? `instructions.${field}: added` : `instructions.${field}: revised`);
  }
  for (const field of Object.keys(existing?.instructions ?? {})) {
    if (!(field in (next.instructions ?? {}))) changes.push(`instructions.${field}: cleared`);
  }
  return changes;
}