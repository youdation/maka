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
import {
  createDefaultRuntimePolicy,
  decodeCanonicalRuntimePolicy,
  normalizeRuntimePolicyMutation,
  RuntimePolicyDomainDecodeError,
} from '../runtime-policy.js';
import {
  normalizeSubagentSettings,
  SUBAGENT_PRESET_INSTRUCTION_FIELDS,
  SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS,
  type SubagentPreset,
} from '../subagent-settings.js';

const basePreset = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews diffs',
  profile: 'local_read',
  connectionSlug: 'openai-main',
  model: 'gpt-5-mini',
  enabled: true,
} as const satisfies SubagentPreset;

function outOfBand(value: unknown) {
  return normalizeRuntimePolicyMutation({
    expectedRevision: 0,
    operation: { kind: 'patch_subagent_presets', value },
  });
}

test('an instruction at the cap still fits the child snapshot budget', () => {
  // Two limits meet here: the per-field character cap that the preset
  // normalizer enforces, and the length the child-session snapshot accepts.
  // Together they bound the worst case a single preset can produce.
  const atCap = 'x'.repeat(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS);
  const [preset] = normalizeSubagentSettings({
    presets: [
      {
        ...basePreset,
        instructions: Object.fromEntries(
          SUBAGENT_PRESET_INSTRUCTION_FIELDS.map((field) => [field, atCap]),
        ),
      },
    ],
  }).presets;

  assert.ok(preset?.instructions, 'a capped instruction block is kept, not dropped');
  for (const field of SUBAGENT_PRESET_INSTRUCTION_FIELDS) {
    assert.equal(preset.instructions[field]?.length, SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS);
  }
  const total = SUBAGENT_PRESET_INSTRUCTION_FIELDS.length * SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS;
  assert.ok(
    total < 100_000,
    `five capped fields (${total}) must stay under the child snapshot prompt limit`,
  );
  // The boundary the normalize produces is the boundary the codec accepts.
  const policy = { ...createDefaultRuntimePolicy(), subagents: { presets: [preset] } };
  assert.deepEqual(decodeCanonicalRuntimePolicy(policy).subagents.presets, [preset]);
});

test('a delete of an unknown preset id is accepted and changes nothing else', () => {
  // The codec cannot see the list, so it must not pretend to know whether the
  // id exists; storage owns that (a missing id is a no-op there).
  assert.deepEqual(outOfBand({ op: 'delete', presetId: 'never-saved' }).operation, {
    kind: 'patch_subagent_presets',
    value: { op: 'delete', presetId: 'never-saved' },
  });
});

test('an upsert accepts a preset with no instructions and one with only some', () => {
  const partial = {
    ...basePreset,
    instructions: { responsibilities: 'Review diffs.', outputFormat: 'A list.' },
  };
  assert.deepEqual(
    (outOfBand({ op: 'upsert', preset: basePreset }).operation as { value: unknown }).value,
    { op: 'upsert', preset: basePreset },
  );
  assert.deepEqual(
    (outOfBand({ op: 'upsert', preset: partial }).operation as { value: unknown }).value,
    { op: 'upsert', preset: partial },
  );
});

test('an upsert rejects spare keys at every level of the mutation', () => {
  const reject = (value: unknown) => assert.throws(() => outOfBand(value), RuntimePolicyDomainDecodeError);
  // On the operation
  reject({ op: 'upsert', preset: basePreset, extra: true });
  // On the delete form
  reject({ op: 'delete', presetId: 'reviewer', extra: true });
  // On the preset
  reject({ op: 'upsert', preset: { ...basePreset, surprise: 1 } });
  // On the instruction block
  reject({
    op: 'upsert',
    preset: { ...basePreset, instructions: { responsibilities: 'ok', surprise: 1 } },
  });
  // A missing discriminator is not "some other operation".
  reject({ preset: basePreset });
  reject({});
});

test('an upsert rejects a preset id that the store would refuse to key on', () => {
  for (const id of ['', 'has space', '../escape', 'a'.repeat(129)]) {
    assert.throws(
      () => outOfBand({ op: 'upsert', preset: { ...basePreset, id } }),
      RuntimePolicyDomainDecodeError,
      `id ${JSON.stringify(id)} must be refused`,
    );
  }
});

test('patch_subagent_presets composes with the rest of the policy surface', () => {
  // A mutation must not disturb unrelated policy sections, and an unrelated
  // section must decode unchanged alongside presets that carry instructions.
  const withInstructions = {
    ...basePreset,
    instructions: { responsibilities: 'Review diffs.', constraints: 'Never edit files.' },
  };
  const policy = { ...createDefaultRuntimePolicy(), subagents: { presets: [withInstructions] } };
  const decoded = decodeCanonicalRuntimePolicy(policy);
  assert.deepEqual(decoded.subagents.presets, [withInstructions]);
  assert.deepEqual(decoded.shell, policy.shell);
  assert.deepEqual(decoded.webSearch, policy.webSearch);
  assert.deepEqual(decoded.privacy, policy.privacy);
});