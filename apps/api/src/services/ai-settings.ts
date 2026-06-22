// Operator-tunable AI / model settings (local Ollama vision knobs, OCR
// rasterization, and the OCR-error safety net). Each setting resolves
// DB (system_settings) → env var → built-in default, so the env vars keep
// working as deploy-time defaults while the admin UI can override live.
//
// The registry is the single source of truth: the resolver feeds the provider
// factory + extraction worker, listAiSettings() drives the admin UI generically
// (one control per `kind`), and setAiSetting() validates + persists + drops the
// provider cache so a change takes effect on the next extraction.

import { inArray, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { systemSettings } from '../db/schema.js';
import { ValidationError } from '../lib/errors.js';

export type AiSettingKind = 'int' | 'float' | 'string' | 'bool' | 'enum';
export type AiSettingGroup = 'vision' | 'ocr' | 'extraction' | 'safety';

export interface AiSettingDef {
  id: string; // stable id used by the API + UI
  key: string; // system_settings key
  env: string; // env-var fallback
  kind: AiSettingKind;
  group: AiSettingGroup;
  label: string;
  help: string;
  default: string; // default as a string ('' = unset/optional)
  min?: number;
  max?: number;
  enumValues?: readonly string[];
  unit?: string; // shown in the UI (e.g. 'ms')
}

export const AI_SETTINGS: readonly AiSettingDef[] = [
  // --- Vision performance ---
  {
    id: 'visionTimeoutMs',
    key: 'llm.vision.timeout_ms',
    env: 'OLLAMA_VISION_TIMEOUT_MS',
    kind: 'int',
    group: 'vision',
    label: 'Vision call timeout',
    help: 'Per-call OCR/vision timeout. Raise for a large -VL model on CPU or a cold model load.',
    default: '300000',
    min: 1000,
    max: 1_800_000,
    unit: 'ms',
  },
  {
    id: 'visionMaxTokens',
    key: 'llm.vision.max_tokens',
    env: 'OLLAMA_VISION_MAX_TOKENS',
    kind: 'int',
    group: 'vision',
    label: 'Vision max output tokens',
    help: 'Hard cap on vision output (Ollama num_predict). Bounds runaway generation that would blow past the timeout.',
    default: '8192',
    min: 256,
    max: 64_000,
  },
  {
    id: 'visionThink',
    key: 'llm.vision.think',
    env: 'OLLAMA_VISION_THINK',
    kind: 'enum',
    group: 'vision',
    label: 'Vision reasoning',
    help: 'Thinking models: "off" roughly halves latency; a schema-constrained OCR pass rarely needs it. Blank = the model default.',
    default: '',
    enumValues: ['', 'on', 'off'],
  },
  {
    id: 'keepAlive',
    key: 'llm.ollama.keep_alive',
    env: 'OLLAMA_KEEP_ALIVE',
    kind: 'string',
    group: 'vision',
    label: 'Model keep-alive',
    help: 'How long Ollama keeps the model resident between calls (e.g. 30m, 1h, or -1 for forever). Longer avoids cold reloads.',
    default: '30m',
  },
  {
    id: 'numCtx',
    key: 'llm.ollama.num_ctx',
    env: 'OLLAMA_NUM_CTX',
    kind: 'int',
    group: 'vision',
    label: 'Context window (num_ctx)',
    help: 'Override the Ollama context window for long statements. Blank = the model default.',
    default: '',
    min: 512,
    max: 131_072,
  },
  // --- Text extraction ---
  {
    id: 'localStructuredOutput',
    key: 'llm.local.structured_output',
    env: 'LLM_LOCAL_STRUCTURED_OUTPUT',
    kind: 'enum',
    group: 'extraction',
    label: 'Local structured output',
    help: '"grammar" constrains the local model with the JSON-schema grammar and auto-falls-back to plain JSON if the grammar dead-ends; "json_object" skips the grammar entirely — faster when your scanned statements reliably trip it (no wasted grammar pass), relying on the prompt + validation.',
    default: 'grammar',
    enumValues: ['grammar', 'json_object'],
  },
  // --- OCR fidelity ---
  {
    id: 'ocrDpi',
    key: 'ocr.raster_dpi',
    env: 'VIBETC_OCR_RASTER_DPI',
    kind: 'int',
    group: 'ocr',
    label: 'OCR raster DPI',
    help: 'Resolution scanned pages are rasterized at. Higher = sharper small text (better OCR) but slower/larger calls and more timeout risk.',
    default: '200',
    min: 72,
    max: 600,
  },
  {
    id: 'ocrJpegQuality',
    key: 'ocr.raster_jpeg_quality',
    env: 'VIBETC_OCR_RASTER_JPEG_QUALITY',
    kind: 'int',
    group: 'ocr',
    label: 'OCR JPEG quality',
    help: 'JPEG quality (30–100) for rasterized page images.',
    default: '80',
    min: 30,
    max: 100,
  },
  // --- OCR safety net ---
  {
    id: 'reviewConfidence',
    key: 'review.confidence_threshold',
    env: 'VIBETC_REVIEW_CONFIDENCE_THRESHOLD',
    kind: 'float',
    group: 'safety',
    label: 'Review confidence threshold',
    help: 'Hold a statement for human review before export when any transaction is below this confidence (0–1). Set 0 to disable.',
    default: '0.7',
    min: 0,
    max: 1,
  },
  {
    id: 'checkPayeeAuto',
    key: 'check.payee_auto',
    env: 'VIBETC_CHECK_PAYEE_AUTO',
    kind: 'bool',
    group: 'safety',
    label: 'Auto-read check payees',
    help: 'After extraction, read check payees off the cancelled-check images for any check row left without one.',
    default: 'true',
  },
];

const byId = (id: string): AiSettingDef | undefined => AI_SETTINGS.find((s) => s.id === id);

export interface ResolvedAiSettings {
  visionTimeoutMs: number;
  visionMaxTokens: number;
  visionThink: boolean | undefined;
  keepAlive: string;
  numCtx: number | undefined;
  localStructuredOutput: 'grammar' | 'json_object';
  ocrDpi: number;
  ocrJpegQuality: number;
  reviewConfidence: number;
  checkPayeeAuto: boolean;
}

// One batched read of all keys, then DB → env → default per setting.
const loadRaw = async (db: Db): Promise<(def: AiSettingDef) => string> => {
  const rows = await db
    .select({ key: systemSettings.key, v: systemSettings.valuePlaintext })
    .from(systemSettings)
    .where(
      inArray(
        systemSettings.key,
        AI_SETTINGS.map((s) => s.key),
      ),
    );
  const dbMap = new Map(rows.map((r) => [r.key, r.v ?? '']));
  return (def: AiSettingDef): string => {
    const dbv = dbMap.get(def.key);
    if (dbv != null && dbv.length > 0) return dbv;
    const ev = process.env[def.env];
    if (ev != null && ev.length > 0) return ev;
    return def.default;
  };
};

export const resolveAiSettings = async (db: Db): Promise<ResolvedAiSettings> => {
  const raw = await loadRaw(db);
  // Guard a garbage *env var* (the DB path is validated by setAiSetting, the env
  // path is not): an unparseable value falls back to the built-in default rather
  // than poisoning the provider with NaN (e.g. OLLAMA_VISION_TIMEOUT_MS=abc).
  const intOf = (id: string): number => {
    const def = byId(id)!;
    const n = Number.parseInt(raw(def), 10);
    return Number.isFinite(n) ? n : Number.parseInt(def.default, 10);
  };
  const floatOf = (id: string): number => {
    const def = byId(id)!;
    const n = Number.parseFloat(raw(def));
    return Number.isFinite(n) ? n : Number.parseFloat(def.default);
  };
  const optIntOf = (id: string): number | undefined => {
    const v = raw(byId(id)!);
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const thinkRaw = raw(byId('visionThink')!);
  return {
    visionTimeoutMs: intOf('visionTimeoutMs'),
    visionMaxTokens: intOf('visionMaxTokens'),
    visionThink: thinkRaw === 'on' ? true : thinkRaw === 'off' ? false : undefined,
    keepAlive: raw(byId('keepAlive')!),
    numCtx: optIntOf('numCtx'),
    localStructuredOutput:
      raw(byId('localStructuredOutput')!) === 'json_object' ? 'json_object' : 'grammar',
    ocrDpi: intOf('ocrDpi'),
    ocrJpegQuality: intOf('ocrJpegQuality'),
    reviewConfidence: floatOf('reviewConfidence'),
    checkPayeeAuto: raw(byId('checkPayeeAuto')!) !== 'false',
  };
};

export interface AiSettingView extends AiSettingDef {
  value: string; // effective value (DB → env → default)
  source: 'db' | 'env' | 'default';
}

// Per-setting effective value + provenance for the admin UI.
export const listAiSettings = async (db: Db): Promise<AiSettingView[]> => {
  const rows = await db
    .select({ key: systemSettings.key, v: systemSettings.valuePlaintext })
    .from(systemSettings)
    .where(
      inArray(
        systemSettings.key,
        AI_SETTINGS.map((s) => s.key),
      ),
    );
  const dbMap = new Map(rows.map((r) => [r.key, r.v ?? '']));
  return AI_SETTINGS.map((def) => {
    const dbv = dbMap.get(def.key);
    if (dbv != null && dbv.length > 0) return { ...def, value: dbv, source: 'db' as const };
    const ev = process.env[def.env];
    if (ev != null && ev.length > 0) return { ...def, value: ev, source: 'env' as const };
    return { ...def, value: def.default, source: 'default' as const };
  });
};

// Validate a raw string value against the setting's kind/bounds. Throws
// ValidationError with a clear message; returns the normalized string to store
// (or null to clear the override back to env/default).
const validate = (def: AiSettingDef, raw: unknown): string | null => {
  const s = String(raw ?? '').trim();
  // Empty clears the override (back to env/default) for every setting.
  if (s.length === 0) return null;
  switch (def.kind) {
    case 'int':
    case 'float': {
      const n = def.kind === 'int' ? Number.parseInt(s, 10) : Number.parseFloat(s);
      if (!Number.isFinite(n)) throw new ValidationError(`${def.label} must be a number`);
      if (def.min != null && n < def.min)
        throw new ValidationError(`${def.label} must be ≥ ${def.min}`);
      if (def.max != null && n > def.max)
        throw new ValidationError(`${def.label} must be ≤ ${def.max}`);
      return String(n);
    }
    case 'bool': {
      if (s !== 'true' && s !== 'false')
        throw new ValidationError(`${def.label} must be true or false`);
      return s;
    }
    case 'enum': {
      if (!(def.enumValues ?? []).includes(s))
        throw new ValidationError(
          `${def.label} must be one of ${(def.enumValues ?? []).join(', ')}`,
        );
      return s;
    }
    case 'string':
      return s.slice(0, 200);
  }
};

// Persist (or clear, when the value is empty) one setting. Returns the new
// effective value. The caller invalidates the provider cache so the vision
// knobs take effect on the next extraction (OCR/safety settings are read fresh
// by the worker each run).
export const setAiSetting = async (
  db: Db,
  id: string,
  rawValue: unknown,
  actorId: string,
): Promise<AiSettingView> => {
  const def = byId(id);
  if (!def) throw new ValidationError(`unknown setting: ${id}`);
  const value = validate(def, rawValue);
  if (value === null) {
    await db.delete(systemSettings).where(eq(systemSettings.key, def.key));
  } else {
    await db
      .insert(systemSettings)
      .values({ key: def.key, valuePlaintext: value, isSecret: false })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { valuePlaintext: value, updatedAt: sql`now()`, updatedByUserId: actorId },
      });
  }
  const [view] = await listAiSettings(db).then((all) => all.filter((v) => v.id === id));
  return view!;
};
