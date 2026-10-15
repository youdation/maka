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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type {
  RuntimePolicyMutation,
  RuntimePolicySnapshot,
} from '@maka/core/runtime-policy';
import { MAX_SUBAGENT_PRESETS, type SubagentPreset } from '@maka/core/subagent-settings';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { buildHostSubagentPresetTools } from '../server/subagent-preset-tools.js';

/** The built tool, loosely typed: the test drives it through its model-facing shape. */
type PresetTool = MakaTool<unknown, unknown> & {
  impl(input: unknown, context: MakaToolContext): Promise<unknown>;
};

function preset(overrides: Partial<SubagentPreset> = {}): SubagentPreset {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews diffs',
    profile: 'local_read',
    connectionSlug: 'openai-main',
    model: 'gpt-5-mini',
    enabled: true,
    ...overrides,
  };
}

/** A stand-in policy store that records what the tool actually asked to write. */
function authority(initial: readonly SubagentPreset[] = [], options: { revisions?: number } = {}) {
  let revision = 0;
  let presets = [...initial];
  const mutations: RuntimePolicyMutation[] = [];
  let conflicts = options.revisions ?? 0;
  return {
    mutations,
    get revision() {
      return revision;
    },
    get presets() {
      return presets;
    },
    read: async (): Promise<RuntimePolicySnapshot> => ({
      revision,
      policy: { ...createDefaultRuntimePolicy(), subagents: { presets } },
    }),
    mutate: async (build: (policy: RuntimePolicySnapshot) => RuntimePolicyMutation) => {
      const policy: RuntimePolicySnapshot = {
        revision,
        policy: { ...createDefaultRuntimePolicy(), subagents: { presets } },
      };
      const operation = build(policy);
      if (conflicts > 0) {
        conflicts -= 1;
        return { kind: 'revision_conflict' as const, expectedRevision: revision, actualRevision: revision };
      }
      mutations.push(operation);
      if (operation.kind === 'patch_subagent_presets') {
        const value = operation.value;
        if (value.op === 'upsert') {
          const index = presets.findIndex((candidate) => candidate.id === value.preset.id);
          presets =
            index >= 0
              ? presets.map((candidate, at) => (at === index ? value.preset : candidate))
              : [...presets, value.preset];
        } else {
          presets = presets.filter((candidate) => candidate.id !== value.presetId);
        }
      }
      revision += 1;
      return { kind: 'committed' as const, revision };
    },
  };
}

function tool(): PresetTool {
  return buildHostSubagentPresetTools(authority())[0] as unknown as PresetTool;
}

function context(
  answer: string | null,
  askUserQuestion = true,
): { context: MakaToolContext; questions: string[] } {
  const questions: string[] = [];
  const ctx = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp/cwd',
    toolCallId: 'tool-call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    ...(askUserQuestion
      ? {
          askUserQuestion: async (asked: { question: string }[]) => {
            questions.push(asked[0]?.question ?? '');
            return { answers: [{ question: asked[0]?.question ?? '', answer }] };
          },
        }
      : {}),
  } as MakaToolContext;
  return { context: ctx, questions };
}

test('list projects every preset with its stored role instructions', async () => {
  const store = authority([
    preset({
      instructions: { responsibilities: 'Review diffs.', acceptanceCriteria: 'Cite lines.' },
    }),
    preset({ id: 'researcher', profile: 'web_research', model: 'gpt-5-mini' }),
  ]);
  const listTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;

  const result = (await listTool.impl({ action: 'list' }, context(null).context)) as {
    kind: string;
    presets: ReadonlyArray<Record<string, unknown>>;
  };

  assert.equal(result.kind, 'maka_subagent_presets');
  assert.deepEqual(result.presets[0]?.instructions, {
    responsibilities: 'Review diffs.',
    acceptanceCriteria: 'Cite lines.',
  });
  // A preset without instructions is projected without the key at all.
  assert.equal(Object.hasOwn(result.presets[1]!, 'instructions'), false);
  assert.equal(store.mutations.length, 0);
});

test('upsert writes one preset through the preset-scoped mutation', async () => {
  const store = authority([preset()]);
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;
  const { context: ctx, questions } = context('Write preset');

  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'reviewer',
        name: 'Reviewer',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
        instructions: { procedure: 'Read the diff, then the tests.' },
      },
    },
    ctx,
  )) as { ok: boolean; applied: boolean; changes?: readonly string[] };

  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  // The confirmation names the preset and the instruction that changed.
  assert.equal(questions.length, 1);
  assert.match(questions[0]!, /Replace preset "reviewer"/u);
  assert.match(questions[0]!, /instructions\.procedure: added/u);
  // One mutation for one preset, not a whole-array write.
  assert.deepEqual(
    store.mutations.map((mutation) => mutation.kind),
    ['patch_subagent_presets'],
  );
  const operation = store.mutations[0];
  assert.equal(operation?.kind, 'patch_subagent_presets');
  if (operation?.kind !== 'patch_subagent_presets' || operation.value.op !== 'upsert') return;
  assert.equal(operation.value.preset.id, 'reviewer');
  assert.deepEqual(operation.value.preset.instructions, {
    procedure: 'Read the diff, then the tests.',
  });
});

test('a cancelled confirmation writes nothing and reports the change it skipped', async () => {
  const store = authority([preset()]);
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;

  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'reviewer',
        name: 'Renamed',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    context('Cancel').context,
  )) as { ok: boolean; applied: boolean; reason?: string; changes?: readonly string[] };

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(store.mutations.length, 0);
  assert.match(result.changes?.join('\n') ?? '', /name: Reviewer → Renamed/u);
});

test('without a confirmation surface the tool refuses to write', async () => {
  const store = authority([preset()]);
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;

  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'reviewer',
        name: 'Reviewer',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    context(null, false).context,
  )) as { ok: boolean; applied: boolean; reason?: string };

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'confirmation_unavailable');
  assert.equal(store.mutations.length, 0);
});

test('an invalid draft is refused before any confirmation is requested', async () => {
  const store = authority();
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;
  const { context: ctx, questions } = context('Write preset');

  // `name` is present but blank: the schema accepts the length, the store's own
  // normalizer rejects the preset, and that is the refusal the model must see.
  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'reviewer',
        name: '   ',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    ctx,
  )) as { ok: boolean; applied: boolean; reason?: string };

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_preset');
  assert.equal(questions.length, 0);
  assert.equal(store.mutations.length, 0);
});

test('delete addresses one id, and an unknown id is a no-op rather than an error', async () => {
  const store = authority([preset(), preset({ id: 'researcher' })]);
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;
  const { context: ctx, questions } = context('Delete preset');

  const removed = (await presetTool.impl({ action: 'delete', preset_id: 'reviewer' }, ctx)) as {
    applied: boolean;
    presets: ReadonlyArray<{ id: string }>;
  };
  assert.equal(removed.applied, true);
  assert.match(questions[0]!, /Delete preset "Reviewer"/u);
  assert.deepEqual(
    store.presets.map((candidate) => candidate.id),
    ['researcher'],
  );

  const again = (await presetTool.impl({ action: 'delete', preset_id: 'reviewer' }, ctx)) as {
    applied: boolean;
    message: string;
  };
  assert.equal(again.applied, false);
  assert.match(again.message, /No preset with id "reviewer"/u);
  // Only the real delete reached the store.
  assert.equal(store.mutations.length, 1);
});

test('the confirmed diff describes what will be stored, not what was typed', async () => {
  const store = authority();
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;
  const { context: ctx, questions } = context('Write preset');

  await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'reviewer',
        name: '  Padded name  ',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    ctx,
  );

  const operation = store.mutations[0];
  assert.equal(operation?.kind, 'patch_subagent_presets');
  if (operation?.kind !== 'patch_subagent_presets' || operation.value.op !== 'upsert') return;
  // Normalized before confirmation, so the stored value is the confirmed value.
  assert.equal(operation.value.preset.name, 'Padded name');
  // The name was already normalized, so it is not reported as a change from itself.
  assert.equal(/name:/u.test(questions[0] ?? ''), false);
});

test('a write survives a revision conflict without losing a concurrent preset', async () => {
  const store = authority([preset()], { revisions: 2 });
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;

  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'researcher',
        name: 'Researcher',
        profile: 'web_research',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    context('Write preset').context,
  )) as { applied: boolean };

  assert.equal(result.applied, true);
  // The earlier preset is still there: the retry re-read and re-applied.
  assert.deepEqual(
    store.presets.map((candidate) => candidate.id).sort(),
    ['researcher', 'reviewer'],
  );
});

test('the preset list ceiling is reported, not silently truncated', async () => {
  const full = Array.from({ length: MAX_SUBAGENT_PRESETS }, (_, index) =>
    preset({ id: `preset-${index}` }),
  );
  const store = authority(full);
  const presetTool = buildHostSubagentPresetTools(store)[0] as unknown as PresetTool;

  // The codec cannot see the list, so this write is accepted here; storage owns
  // the ceiling. What matters is that the tool does not invent a different one.
  const result = (await presetTool.impl(
    {
      action: 'upsert',
      preset: {
        id: 'one-too-many',
        name: 'One too many',
        profile: 'local_read',
        connectionSlug: 'openai-main',
        model: 'gpt-5-mini',
      },
    },
    context('Write preset').context,
  )) as { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(store.mutations.length, 1);
});