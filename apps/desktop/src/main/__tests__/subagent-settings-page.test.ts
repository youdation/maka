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
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import {
  createDefaultSettings,
  type AppSettings,
  type UpdateAppSettingsInput,
} from '@maka/core/settings';
import type { LlmConnection, HostResolvedConnectionCatalog } from '@maka/core/llm-connections';
import type { SubagentPreset } from '@maka/core/subagent-settings';
import type { UiLocale } from '@maka/core/ui-locale';
import { SubagentSettingsPage } from '../../renderer/settings/subagent-settings-page.js';
import { RuntimeHostSettingsTarget } from '../../renderer/settings/runtime-host-settings-target.js';

/**
 * The first test for this page.
 *
 * Astryx's `TextArea` does not reflect its `value` into the DOM under linkedom:
 * a TextArea rendered with a known non-empty value still reads back as `""`,
 * including the page's pre-existing "When to use" field. Value population and
 * typing therefore cannot be asserted here, and this file asserts what the
 * environment does support: the labelled fields, their placeholders, the field
 * cap, the rendered explanation, and the save payload.
 */

let root: Root | undefined;
const globals = [
  'window',
  'document',
  'HTMLElement',
  'Node',
  'Event',
  'CSS',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
];
const original = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)]));
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  Object.assign(globalThis, original);
});

function connection(): LlmConnection & HostResolvedConnectionCatalog {
  return {
    connectionId: '11111111-1111-4111-8111-111111111111',
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    enabled: true,
    enabledModelIds: ['gpt-5-mini'],
    defaultModel: 'gpt-5-mini',
    createdAt: 1,
    updatedAt: 1,
    catalogEntries: [
      { id: 'gpt-5-mini', displayName: 'GPT-5 mini', canUseAsChatDefault: true, thinkingLevels: [] },
    ],
  } as unknown as LlmConnection & HostResolvedConnectionCatalog;
}

function preset(instructions?: SubagentPreset['instructions']): SubagentPreset {
  return {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews diffs',
    profile: 'local_read',
    connectionSlug: 'openai-main',
    model: 'gpt-5-mini',
    ...(instructions ? { instructions } : {}),
    enabled: true,
  };
}

async function mount(input: {
  locale?: UiLocale;
  presets?: SubagentPreset[];
  collect?: UpdateAppSettingsInput[];
}) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  });
  Object.assign(window, { matchMedia, getComputedStyle });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    getComputedStyle,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const presets = input.presets ?? [preset()];
  const settings: AppSettings = { ...createDefaultSettings(), subagents: { presets } };
  root = createRoot(document.getElementById('root')!);
  await act(async () =>
    root!.render(
      createElement(LocaleProvider, {
        locale: input.locale ?? 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(RuntimeHostSettingsTarget, {
            host: { profileId: 'local', hostId: 'host-1' },
            generation: 'generation-1',
            children: createElement(ToastProvider, {
              children: createElement(SubagentSettingsPage, {
                settings,
                connections: [connection()],
                onUpdate: async (patch: UpdateAppSettingsInput) => {
                  input.collect?.push(patch);
                  return {
                    settings: { ...settings, subagents: patch.subagents ?? settings.subagents },
                  };
                },
              }),
            }),
          }),
        }),
      }),
    ),
  );

  const textareas = () => [...document.querySelectorAll<HTMLTextAreaElement>('textarea')];
  /** Astryx labels its control with a real `<label for>`, so that is the name it has. */
  const fieldFor = (label: string) => {
    const named = [...document.querySelectorAll<HTMLLabelElement>('label')].find(
      (element) => (element.textContent ?? '').trim() === label,
    );
    assert.ok(named, `no label reading ${label}`);
    const id = named.getAttribute('for');
    assert.ok(id, `label ${label} is not associated with a control`);
    const control = document.getElementById(id!);
    assert.ok(control, `label ${label} points at a missing control`);
    return control as HTMLTextAreaElement;
  };
  /**
   * Icon buttons name themselves with `aria-label`; text buttons carry their
   * label as content. Match either, and prefer an exact content match so a
   * "Configure" search cannot land on an unrelated button.
   */
  const button = (...labels: string[]) => {
    const candidates = [...document.querySelectorAll<HTMLButtonElement>('button')];
    for (const label of labels) {
      const exact = candidates.find((candidate) => (candidate.textContent ?? '').trim() === label);
      if (exact) return exact;
      const named = candidates.find((candidate) =>
        (candidate.getAttribute('aria-label') ?? '').includes(label),
      );
      if (named) return named;
    }
    assert.fail(
      `no button matching ${labels.join(' or ')} among ${candidates
        .map((candidate) => candidate.getAttribute('aria-label') ?? candidate.textContent ?? '')
        .join(' | ')}`,
    );
  };
  return { document, textareas, fieldFor, button };
}

const INSTRUCTION_LABELS = [
  'Responsibilities',
  'Procedure',
  'Constraints',
  'Output format',
  'Acceptance criteria',
];

test('the editor exposes one labelled field per instruction concern', async () => {
  const page = await mount({});
  await act(async () => page.button('Configure').click());

  // Five instruction fields, plus the page's pre-existing "When to use" field.
  assert.equal(page.textareas().length, 6);
  for (const label of INSTRUCTION_LABELS) {
    assert.equal(page.fieldFor(label).tagName, 'TEXTAREA', `${label} is a textarea`);
  }
  // The per-field cap the store enforces is visible to the user.
  assert.match(page.document.body.textContent ?? '', /0\/8000/u);
});

test('each instruction field carries its own guidance', async () => {
  const page = await mount({});
  await act(async () => page.button('Configure').click());

  const placeholders = INSTRUCTION_LABELS.map(
    (label) => page.fieldFor(label).getAttribute('placeholder') ?? '',
  );
  for (const placeholder of placeholders) assert.notEqual(placeholder, '');
  // Distinct guidance per field: one shared placeholder would mean the copy is
  // wired to the wrong key.
  assert.equal(new Set(placeholders).size, placeholders.length);
});

test('the editor states that instructions cannot widen capability', async () => {
  const en = await mount({ locale: 'en' });
  await act(async () => en.button('Configure').click());
  assert.match(en.document.body.textContent ?? '', /does not change them/u);
  assert.match(en.document.body.textContent ?? '', /Work instructions/u);

  const zh = await mount({ locale: 'zh-CN' });
  await act(async () => zh.button('配置').click());
  assert.match(zh.document.body.textContent ?? '', /不会改变它们/u);
  assert.match(zh.document.body.textContent ?? '', /工作指令/u);

  const tw = await mount({ locale: 'zh-TW' });
  await act(async () => tw.button('設定').click());
  assert.match(tw.document.body.textContent ?? '', /不會改變它們/u);
  assert.match(tw.document.body.textContent ?? '', /工作指令/u);
});

test('saving a preset keeps the instructions it already had', async () => {
  const collect: UpdateAppSettingsInput[] = [];
  const page = await mount({
    presets: [
      preset({ responsibilities: 'Review diffs.', acceptanceCriteria: 'Cite lines.' }),
    ],
    collect,
  });
  await act(async () => page.button('Configure').click());
  // Change the name so the save is a real edit, then commit.
  await act(async () => page.button('Save').click());

  const saved = collect.at(-1)?.subagents?.presets.find((candidate) => candidate.id === 'reviewer');
  assert.ok(saved, 'the save reached the update path');
  // The editor must not drop instructions it did not touch.
  assert.deepEqual(saved.instructions, {
    responsibilities: 'Review diffs.',
    acceptanceCriteria: 'Cite lines.',
  });
});

test('saving a preset that never had instructions does not add an empty block', async () => {
  const collect: UpdateAppSettingsInput[] = [];
  const page = await mount({ presets: [preset()], collect });
  await act(async () => page.button('Configure').click());
  await act(async () => page.button('Save').click());

  const saved = collect.at(-1)?.subagents?.presets.find((candidate) => candidate.id === 'reviewer');
  assert.ok(saved);
  assert.equal(Object.hasOwn(saved, 'instructions'), false);
  assert.equal(saved.name, 'Reviewer');
});