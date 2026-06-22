// Operator-editable transaction-extraction system prompt. Mirrors the
// enrichment-prompt pattern (system_settings keys → resolver → admin GET/PUT →
// admin UI). The effective prompt is resolved at extraction time and passed to
// the provider via ExtractOptions.systemPromptOverride. An empty override falls
// back to the built-in default, so a blank field can never break extraction.
//
// Unlike enrichment, extraction results are not prompt-version-cached, so there
// is no cache-invalidation/hash machinery here.

import {
  SYSTEM_PROMPT,
  extractionSystemPromptFor,
  type ExtractionPromptMode,
} from '@vibe-tx-converter/extractor';

import type { Db } from '../db/client.js';
import { writeAudit } from './audit.js';
import { readSettingPlain, upsertSetting } from './system-settings.js';

const KEY_MODE = 'extraction.prompt.mode';
const KEY_EXTRA = 'extraction.prompt.extra_instructions';
const KEY_FULL = 'extraction.prompt.full_system_prompt';

interface ExtractionPromptOverrides {
  mode: ExtractionPromptMode;
  extraInstructions: string | null;
  fullSystemPrompt: string | null;
}

const readOverrides = async (db: Db): Promise<ExtractionPromptOverrides> => {
  const [modeRaw, extraInstructions, fullSystemPrompt] = await Promise.all([
    readSettingPlain(db, KEY_MODE),
    readSettingPlain(db, KEY_EXTRA),
    readSettingPlain(db, KEY_FULL),
  ]);
  const mode: ExtractionPromptMode = modeRaw === 'full' ? 'full' : 'rules';
  return { mode, extraInstructions, fullSystemPrompt };
};

export interface ExtractionPromptField {
  current: string;
  isOverride: boolean;
  defaultValue: string;
}

export interface ExtractionPromptStatus {
  mode: ExtractionPromptMode;
  // 'rules' mode: extra instructions appended to the built-in default (default '').
  extraInstructions: ExtractionPromptField;
  // 'full' mode: the entire system prompt (default = the built-in SYSTEM_PROMPT).
  fullSystemPrompt: ExtractionPromptField;
  // What the model will actually receive given the current mode + overrides.
  effectivePreview: string;
}

export const extractionPromptStatus = async (db: Db): Promise<ExtractionPromptStatus> => {
  const o = await readOverrides(db);
  return {
    mode: o.mode,
    extraInstructions: {
      current: o.extraInstructions ?? '',
      isOverride: o.extraInstructions !== null,
      defaultValue: '',
    },
    fullSystemPrompt: {
      current: o.fullSystemPrompt ?? SYSTEM_PROMPT,
      isOverride: o.fullSystemPrompt !== null,
      defaultValue: SYSTEM_PROMPT,
    },
    effectivePreview: extractionSystemPromptFor(o),
  };
};

export interface ExtractionPromptUpdate {
  mode?: ExtractionPromptMode | undefined;
  // Empty string or null clears the override (revert to default); undefined
  // leaves the field untouched.
  extraInstructions?: string | null | undefined;
  fullSystemPrompt?: string | null | undefined;
}

export const setExtractionPrompt = async (
  db: Db,
  update: ExtractionPromptUpdate,
  actorUserId: string,
): Promise<ExtractionPromptStatus> => {
  // Empty-string ⇒ "clear the override" — "delete the contents and save" should
  // revert to the default, not persist an empty prompt that would break the LLM.
  const normalize = (v: string | null | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return v.trim().length === 0 ? null : v;
  };
  const extraInstructions = normalize(update.extraInstructions);
  const fullSystemPrompt = normalize(update.fullSystemPrompt);

  if (update.mode !== undefined) await upsertSetting(db, KEY_MODE, update.mode, actorUserId);
  if (extraInstructions !== undefined) {
    await upsertSetting(db, KEY_EXTRA, extraInstructions, actorUserId);
  }
  if (fullSystemPrompt !== undefined) {
    await upsertSetting(db, KEY_FULL, fullSystemPrompt, actorUserId);
  }

  await writeAudit(db, {
    actorUserId,
    entityType: 'system_settings',
    entityId: 'extraction.prompt',
    action: 'extraction.prompt-update',
    payload: {
      modeSet: update.mode ?? null,
      extraInstructionsChanged: extraInstructions !== undefined,
      fullSystemPromptChanged: fullSystemPrompt !== undefined,
    },
  });

  return extractionPromptStatus(db);
};

// Resolve the effective extraction system prompt — the worker passes this into
// provider.extract({ systemPromptOverride }).
export const resolveExtractionSystemPrompt = async (db: Db): Promise<string> =>
  extractionSystemPromptFor(await readOverrides(db));
