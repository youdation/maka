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

import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';

export const SUBAGENT_PROFILES = ['local_read', 'web_research', 'implementation'] as const;
export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];

export const MAX_SUBAGENT_PRESETS = 64;
export const SUBAGENT_PRESET_ID_MAX_CHARS = 128;
// Normalization DROPS a preset whose name is too long and TRUNCATES a
// description that is, so any editor writing these fields has to enforce the
// same numbers — silently losing the preset the user just saved is the
// alternative. Exported for exactly that.
export const SUBAGENT_PRESET_NAME_MAX_CHARS = 128;
export const SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1_000;
// Instruction text follows the `description` half of the rule above: it is
// TRUNCATED at this limit, never used to drop the preset. Exported so every
// editor pre-clamps, because Astryx's TextArea `maxLength` only styles its
// counter and the store would cut the text without saying so.
export const SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS = 8_000;
// `satisfies` rather than `as const` on the element type: the loop below has to
// index the instruction object with these names, and a literal union would make
// that a union of assignments instead of a `string` one.
export const SUBAGENT_PRESET_INSTRUCTION_FIELDS = [
  'responsibilities',
  'procedure',
  'constraints',
  'outputFormat',
  'acceptanceCriteria',
] as const satisfies readonly (keyof SubagentPresetInstructions)[];
const SAFE_SUBAGENT_PRESET_ID = /^[A-Za-z0-9._:-]+$/;
// Role text is prose, so newlines and tabs are legal. Every other control
// character is stripped rather than rejected: a stray escape pasted from a
// document degrades to plain text instead of silently losing the whole field.
const UNSAFE_INSTRUCTION_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * One preset's standing work instructions (issue #5971, stage 1).
 *
 * They reach a child session as text appended after its profile's platform
 * prompt. They never grant a tool, widen a permission, or change a workspace
 * contract — those stay owned by the selected profile's definition and by the
 * runtime's permission checks.
 */
export interface SubagentPresetInstructions {
  /** What this role is for, beyond the selection-facing `description`. */
  responsibilities?: string;
  /** Ordered working procedure for the role. */
  procedure?: string;
  /** Hard behavioral bounds for the role. */
  constraints?: string;
  /** Required output shape. */
  outputFormat?: string;
  /** What "done" means for this role. Model-followed, not enforced. */
  acceptanceCriteria?: string;
}

/** User-approved model route for one catalog subagent capability. */
export interface SubagentPreset {
  id: string;
  name: string;
  description: string;
  profile: SubagentProfile;
  connectionSlug: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  /** Standing role instructions. Absent means the profile prompt alone. */
  instructions?: SubagentPresetInstructions;
  enabled: boolean;
}

export interface SubagentSettings {
  presets: SubagentPreset[];
}

export function isSubagentProfile(value: unknown): value is SubagentProfile {
  return typeof value === 'string' && (SUBAGENT_PROFILES as readonly string[]).includes(value);
}

export function isSafeSubagentPresetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SUBAGENT_PRESET_ID_MAX_CHARS &&
    SAFE_SUBAGENT_PRESET_ID.test(value)
  );
}

/**
 * Normalize one preset's standing instructions.
 *
 * Absent, non-object or wholly empty input is `undefined`, so a preset that
 * never had instructions stays byte-identical to what it was before this field
 * existed. Otherwise unknown keys are dropped (the field is rebuilt like the
 * preset itself, which is also what makes a stored document canonical) and each
 * field is trimmed and truncated to `SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS`.
 */
export function normalizeSubagentPresetInstructions(
  input: unknown,
): SubagentPresetInstructions | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const instructions: SubagentPresetInstructions = {};
  for (const field of SUBAGENT_PRESET_INSTRUCTION_FIELDS) {
    const text = normalizeInstructionText(value[field]);
    if (text === undefined) continue;
    instructions[field] = text;
  }
  return Object.keys(instructions).length > 0 ? instructions : undefined;
}

function normalizeInstructionText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(UNSAFE_INSTRUCTION_TEXT, '').trim();
  if (text.length === 0) return undefined;
  return text.slice(0, SUBAGENT_PRESET_INSTRUCTION_MAX_CHARS);
}

export function normalizeSubagentSettings(input: unknown): SubagentSettings {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray((input as { presets?: unknown }).presets)
  ) {
    return { presets: [] };
  }
  const presets: SubagentPreset[] = [];
  const seen = new Set<string>();
  for (const candidate of (input as { presets: unknown[] }).presets) {
    if (presets.length >= MAX_SUBAGENT_PRESETS) break;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (
      !isSafeSubagentPresetId(value.id) ||
      seen.has(value.id) ||
      !isSubagentProfile(value.profile) ||
      typeof value.name !== 'string' ||
      value.name.trim().length < 1 ||
      value.name.trim().length > SUBAGENT_PRESET_NAME_MAX_CHARS ||
      typeof value.connectionSlug !== 'string' ||
      value.connectionSlug.trim().length < 1 ||
      value.connectionSlug.trim().length > 128 ||
      typeof value.model !== 'string' ||
      value.model.trim().length < 1 ||
      value.model.trim().length > 512 ||
      (value.enabled !== true && value.enabled !== false) ||
      (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel))
    ) {
      continue;
    }
    const id = value.id;
    seen.add(id);
    const instructions = normalizeSubagentPresetInstructions(value.instructions);
    presets.push({
      id,
      name: value.name.trim(),
      description:
        typeof value.description === 'string'
          ? value.description.trim().slice(0, SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS)
          : '',
      profile: value.profile,
      connectionSlug: value.connectionSlug.trim(),
      model: value.model.trim(),
      ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      enabled: value.enabled,
    });
  }
  return { presets };
}
