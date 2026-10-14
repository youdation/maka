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
  buildAgentSystemPrompt,
  IMPLEMENTATION_AGENT_DEFINITION,
  LOCAL_READ_AGENT_DEFINITION,
} from '../agent-catalog.js';

const instructions = {
  responsibilities: 'Review diffs for correctness.',
  procedure: 'Read the diff, then read the tests.',
  constraints: 'Never edit files.',
  outputFormat: 'A flat list of findings.',
  acceptanceCriteria: 'Every finding names a file and a line.',
};

test('with no instructions the profile prompt is returned unchanged', () => {
  assert.equal(
    buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION),
    LOCAL_READ_AGENT_DEFINITION.systemPrompt,
  );
  // An empty block is the same as no block: a preset that cleared every field
  // must not leave a dangling role preamble behind.
  assert.equal(
    buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, {}),
    LOCAL_READ_AGENT_DEFINITION.systemPrompt,
  );
  assert.equal(
    buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, { procedure: '' }),
    LOCAL_READ_AGENT_DEFINITION.systemPrompt,
  );
});

test('the platform prompt stays first and is never replaced', () => {
  const composed = buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, instructions);
  assert.ok(composed.startsWith(LOCAL_READ_AGENT_DEFINITION.systemPrompt));
  assert.ok(composed.length > LOCAL_READ_AGENT_DEFINITION.systemPrompt.length);
  // The profile's own rules survive verbatim, including the tool restriction a
  // user instruction is most likely to contradict.
  assert.ok(composed.includes('Use only the provided Read, Glob, and Grep tools.'));
  assert.ok(composed.includes('Do not use shell, web, browser, write, or nested agent tools.'));
});

test('renders one labelled section per present instruction field', () => {
  const composed = buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, instructions);
  for (const [heading, text] of [
    ['## Role', instructions.responsibilities],
    ['## Working procedure', instructions.procedure],
    ['## Constraints', instructions.constraints],
    ['## Output format', instructions.outputFormat],
    ['## Acceptance criteria', instructions.acceptanceCriteria],
  ]) {
    assert.ok(composed.includes(`${heading}\n${text}`), `missing section: ${heading}`);
  }
});

test('omits absent fields and keeps the section order stable', () => {
  const composed = buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, {
    constraints: 'Never edit files.',
    responsibilities: 'Review diffs.',
  });
  assert.ok(composed.includes('## Role\nReview diffs.'));
  assert.ok(composed.includes('## Constraints\nNever edit files.'));
  assert.equal(composed.includes('## Working procedure'), false);
  assert.equal(composed.includes('## Output format'), false);
  assert.equal(composed.includes('## Acceptance criteria'), false);
  // Declaration order, not the caller's key order.
  assert.ok(composed.indexOf('## Role') < composed.indexOf('## Constraints'));

  // Same input, same prompt: the snapshot hash depends on it.
  assert.equal(composed, buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, {
    constraints: 'Never edit files.',
    responsibilities: 'Review diffs.',
  }));
});

test('states that the role is subordinate to the platform rules and the task', () => {
  const composed = buildAgentSystemPrompt(LOCAL_READ_AGENT_DEFINITION, instructions);
  // Prompt text is not a permission check, so the composition has to say which
  // side wins when a user instruction contradicts the platform section.
  assert.ok(/subordinate to the\s+platform and permission rules/u.test(composed));
  assert.ok(composed.includes('the rules and the available tools win'));
  assert.ok(composed.includes('arrives as the first user message'));
  assert.ok(composed.includes('cannot lift the rules above'));

  const roleAt = composed.indexOf('## Role');
  const boundaryAt = composed.indexOf('arrives as the first user message');
  assert.ok(roleAt > LOCAL_READ_AGENT_DEFINITION.systemPrompt.length);
  assert.ok(boundaryAt > roleAt);
});

test('leaves the definition and the instructions untouched', () => {
  const before = LOCAL_READ_AGENT_DEFINITION.systemPrompt;
  const given = { ...instructions };
  buildAgentSystemPrompt(IMPLEMENTATION_AGENT_DEFINITION, given);
  assert.equal(LOCAL_READ_AGENT_DEFINITION.systemPrompt, before);
  assert.deepEqual(given, instructions);
  assert.ok(
    buildAgentSystemPrompt(IMPLEMENTATION_AGENT_DEFINITION, instructions).startsWith(
      IMPLEMENTATION_AGENT_DEFINITION.systemPrompt,
    ),
  );
});