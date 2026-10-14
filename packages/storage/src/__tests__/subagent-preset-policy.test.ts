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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_SUBAGENT_PRESETS } from '@maka/core/subagent-settings';
import { RuntimePolicyStoreError } from '../runtime-policy/errors.js';
import { RuntimePolicyDocumentOwner } from '../runtime-policy/policy-document.js';

test('patch_subagent_presets writes one preset without clobbering its neighbours', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-subagent-preset-'));
  try {
    const owner = new RuntimePolicyDocumentOwner();
    const first = await owner.mutate(root, {
      expectedRevision: 0,
      operation: {
        kind: 'patch_subagent_presets',
        value: { op: 'upsert', preset: preset('first') },
      },
    });
    assert.equal(first.kind, 'committed');

    // The second write carries only its own preset. The first one survives,
    // which is exactly what a whole-array `set_subagents` cannot promise.
    const second = await owner.mutate(root, {
      expectedRevision: 1,
      operation: {
        kind: 'patch_subagent_presets',
        value: { op: 'upsert', preset: preset('second') },
      },
    });
    assert.equal(second.kind, 'committed');
    assert.deepEqual(
      (await owner.read(root)).policy.subagents.presets.map((candidate) => candidate.id),
      ['first', 'second'],
    );

    // Upsert replaces in place, so the list order is stable across an edit.
    const replaced = await owner.mutate(root, {
      expectedRevision: 2,
      operation: {
        kind: 'patch_subagent_presets',
        value: { op: 'upsert', preset: { ...preset('first'), name: 'Renamed' } },
      },
    });
    assert.equal(replaced.kind, 'committed');
    assert.deepEqual(
      (await owner.read(root)).policy.subagents.presets.map((candidate) => candidate.name),
      ['Renamed', 'second'],
    );

    const removed = await owner.mutate(root, {
      expectedRevision: 3,
      operation: { kind: 'patch_subagent_presets', value: { op: 'delete', presetId: 'first' } },
    });
    assert.equal(removed.kind, 'committed');
    assert.deepEqual(
      (await owner.read(root)).policy.subagents.presets.map((candidate) => candidate.id),
      ['second'],
    );

    // Deleting what is already gone is a no-op, not a revision conflict.
    const again = await owner.mutate(root, {
      expectedRevision: 4,
      operation: { kind: 'patch_subagent_presets', value: { op: 'delete', presetId: 'first' } },
    });
    assert.equal(again.kind, 'committed');
    assert.equal((await owner.read(root)).policy.subagents.presets.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('patch_subagent_presets refuses a preset beyond the stored list limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-subagent-preset-cap-'));
  try {
    const owner = new RuntimePolicyDocumentOwner();
    for (let index = 0; index < MAX_SUBAGENT_PRESETS; index += 1) {
      const result = await owner.mutate(root, {
        expectedRevision: index,
        operation: {
          kind: 'patch_subagent_presets',
          value: { op: 'upsert', preset: preset('preset-' + index) },
        },
      });
      assert.equal(result.kind, 'committed');
    }
    assert.equal((await owner.read(root)).policy.subagents.presets.length, MAX_SUBAGENT_PRESETS);

    // The ceiling lives in storage because it is a property of the stored list,
    // not of one preset. Without it this write would succeed and the next
    // decode would silently drop the extra preset.
    await assert.rejects(
      owner.mutate(root, {
        expectedRevision: MAX_SUBAGENT_PRESETS,
        operation: {
          kind: 'patch_subagent_presets',
          value: { op: 'upsert', preset: preset('preset-overflow') },
        },
      }),
      RuntimePolicyStoreError,
    );
    assert.equal((await owner.read(root)).policy.subagents.presets.length, MAX_SUBAGENT_PRESETS);

    // Replacing an existing preset still fits, so the ceiling is not a
    // read-only freeze at the limit.
    const replaced = await owner.mutate(root, {
      expectedRevision: MAX_SUBAGENT_PRESETS,
      operation: {
        kind: 'patch_subagent_presets',
        value: { op: 'upsert', preset: preset('preset-0', 'Renamed') },
      },
    });
    assert.equal(replaced.kind, 'committed');
    assert.equal((await owner.read(root)).policy.subagents.presets[0]?.name, 'Renamed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function preset(id: string, name = id) {
  return {
    id,
    name,
    description: `${id} role`,
    profile: 'local_read' as const,
    connectionSlug: 'openai-main',
    model: 'gpt-5-mini',
    instructions: { responsibilities: `Act as ${name}.` },
    enabled: true,
  };
}