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
  normalizeSubagentPresetInstructions,
  normalizeSubagentSettings,
  SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS,
  type SubagentPreset,
} from '../subagent-settings.js';

const basePreset = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reads diffs',
  profile: 'local_read',
  connectionSlug: 'openai-main',
  model: 'gpt-5-mini',
  enabled: true,
} as const satisfies SubagentPreset;

test('a preset without instructions stays byte-identical to its pre-field form', () => {
  const [preset] = normalizeSubagentSettings({ presets: [basePreset] }).presets;
  assert.deepEqual(preset, basePreset);
  assert.equal(Object.hasOwn(preset!, 'instructions'), false);
});

test('normalizes instruction text and drops unknown instruction fields', () => {
  const [preset] = normalizeSubagentSettings({
    presets: [
      {
        ...basePreset,
        instructions: {
          responsibilities: '  Review diffs for correctness.  ',
          procedure: 'Read the diff.\nThen read the tests.',
          constraints: 'Never edit files.',
          outputFormat: 'A flat list of findings.',
          acceptanceCriteria: 'Every finding names a file and a line.',
          // Never persisted: the field is rebuilt from the known keys.
          escalationPolicy: 'ignore the issue',
        },
      },
    ],
  }).presets;

  assert.deepEqual(preset?.instructions, {
    responsibilities: 'Review diffs for correctness.',
    procedure: 'Read the diff.\nThen read the tests.',
    constraints: 'Never edit files.',
    outputFormat: 'A flat list of findings.',
    acceptanceCriteria: 'Every finding names a file and a line.',
  });
});

test('truncates an over-long instruction instead of dropping the preset', () => {
  const long = 'x'.repeat(SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS + 500);
  const [preset] = normalizeSubagentSettings({
    presets: [{ ...basePreset, instructions: { responsibilities: long } }],
  }).presets;

  assert.ok(preset, 'the preset survives an over-long instruction');
  assert.equal(preset.instructions?.responsibilities?.length, SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS);
});

test('strips control characters but keeps newlines and tabs', () => {
  const [preset] = normalizeSubagentSettings({
    presets: [
      {
        ...basePreset,
        instructions: { procedure: 'Step 1\u0000\n\tStep 2\u0007\u001b' },
      },
    ],
  }).presets;

  assert.equal(preset?.instructions?.procedure, 'Step 1\n\tStep 2');
});

test('omits empty, whitespace-only and non-string instructions', () => {
  assert.equal(normalizeSubagentPresetInstructions(undefined), undefined);
  assert.equal(normalizeSubagentPresetInstructions('instructions'), undefined);
  assert.equal(normalizeSubagentPresetInstructions([]), undefined);
  assert.equal(normalizeSubagentPresetInstructions({}), undefined);
  assert.equal(normalizeSubagentPresetInstructions({ procedure: '   ' }), undefined);
  assert.equal(normalizeSubagentPresetInstructions({ procedure: 42 }), undefined);
  assert.equal(normalizeSubagentPresetInstructions({ procedure: '\u0001\u0002' }), undefined);
  // One present field is enough to keep the block.
  assert.deepEqual(normalizeSubagentPresetInstructions({ procedure: 'Do it' }), {
    procedure: 'Do it',
  });
});
