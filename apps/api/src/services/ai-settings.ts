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
export type AiSettingGroup =
  | 'vision'
  | 'ocr'
  | 'extraction'
  | 'safety'
  | 'proc-extraction'
  | 'proc-cleanse'
  | 'proc-category'
  | 'proc-check';

// The four LLM processes the operator can route independently (provider / model
// / tokens), via the per-process settings generated below.
export const PROCESS_IDS = ['extraction', 'cleanse', 'category', 'check'] as const;
export type ProcessId = (typeof PROCESS_IDS)[number];

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

const BASE_AI_SETTINGS: readonly AiSettingDef[] = [
  // --- Check-payee vision fallback (Ollama qwen3-vl) ---
  // These govern ONLY the check-payee fallback vision call (callOllamaVision).
  // Scanned-statement OCR runs on GLM-OCR (ADR-025), not an Ollama vision model.
  {
    id: 'visionTimeoutMs',
    key: 'llm.vision.timeout_ms',
    env: 'OLLAMA_VISION_TIMEOUT_MS',
    kind: 'int',
    group: 'vision',
    label: 'Vision call timeout',
    help: 'Per-call timeout for the check-payee fallback vision model (qwen3-vl). Raise for a large model on CPU or a cold load.',
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
    help: 'Hard cap on the check-payee vision model output (Ollama num_predict). Bounds runaway generation that would blow past the timeout.',
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
    help: 'Thinking models: "off" roughly halves latency; the check-payee read rarely needs reasoning. Blank = the model default.',
    default: '',
    enumValues: ['', 'on', 'off'],
  },
  {
    id: 'keepAlive',
    key: 'llm.ollama.keep_alive',
    env: 'OLLAMA_KEEP_ALIVE',
    kind: 'string',
    group: 'vision',
    label: 'Ollama keep-alive (statement model + vision)',
    help: 'How long Ollama keeps a model resident between native /api/chat calls — this covers BOTH the statement-model per-page extraction AND the check-payee vision model. e.g. 30m, 1h, or -1 for forever. A longer value avoids cold model reloads between the sequential per-page statement calls (a reload mid-sequence can surface as "fetch failed").',
    default: '30m',
  },
  {
    id: 'numCtx',
    key: 'llm.ollama.num_ctx',
    env: 'OLLAMA_NUM_CTX',
    kind: 'int',
    group: 'vision',
    label: 'Ollama context window (num_ctx)',
    help: 'Override the Ollama context window for native /api/chat calls — the statement-model per-page extraction AND the check-payee vision model. Blank = the model default.',
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
  {
    id: 'maxPromptTokens',
    key: 'llm.max_prompt_tokens',
    env: 'LLM_MAX_PROMPT_TOKENS',
    kind: 'int',
    group: 'extraction',
    label: 'Max prompt tokens',
    help: 'Token budget for the statement markdown sent to the text model (the system prompt + exemplars reserve ~4k more on top). Markdown beyond this is head/tail-truncated. Raise for long statements, but keep below the model context window.',
    default: '24000',
    min: 1000,
    max: 120_000,
  },
  {
    id: 'extractionTimeoutMs',
    key: 'extraction.timeout_ms',
    env: 'VIBETC_EXTRACTION_TIMEOUT_MS',
    kind: 'int',
    group: 'extraction',
    label: 'Extraction job timeout (restart required)',
    help: 'Max wall-clock a single statement job may run before BullMQ treats it as orphaned (its lock duration). Raise only if a statement legitimately runs longer than the 30-min default; lowering risks duplicate work. Read at worker startup — takes effect on restart.',
    default: '1800000',
    min: 60_000,
    max: 7_200_000,
    unit: 'ms',
  },
  {
    id: 'extractionEngine',
    key: 'extraction.engine',
    env: 'VIBETC_EXTRACTION_ENGINE',
    kind: 'enum',
    group: 'extraction',
    label: 'Extraction engine',
    help: '"legacy" = the prompt + exemplars path (Ollama /v1 qwen2.5:32b / Anthropic). "statement-model" = a purpose-built model on Ollama /api/chat — no system prompt (it bakes its own), its native schema is mapped back to the internal model. Set the model below. v1 sends the whole statement; per-page + header-crop are the next step.',
    default: 'legacy',
    enumValues: ['legacy', 'statement-model'],
  },
  {
    id: 'statementModel',
    key: 'extraction.statement_model',
    env: 'VIBETC_STATEMENT_MODEL',
    kind: 'string',
    group: 'extraction',
    label: 'Statement model',
    help: 'Ollama model tag used when the engine is "statement-model": qwen2.5-stmt (fast/triage) or qwen2.5-stmt-32b (booking-grade). Must be pulled on the Ollama host.',
    default: 'qwen2.5-stmt',
  },
  // --- Scanned-statement OCR engine (ADR-026) ---
  {
    id: 'ocrEngine',
    key: 'ocr.engine',
    env: 'VIBETC_OCR_ENGINE',
    kind: 'enum',
    group: 'ocr',
    label: 'OCR engine',
    help: '"vibe" = VibeOCR (PDF-native async service; the whole PDF is sent once and OCR\'d server-side). "glm" = call GLM-OCR per rasterized page directly. VibeOCR falls back to GLM-OCR automatically on failure.',
    default: 'vibe',
    enumValues: ['vibe', 'glm'],
  },
  {
    id: 'vibeOcrUrl',
    key: 'ocr.vibe.url',
    env: 'VIBE_OCR_URL',
    kind: 'string',
    group: 'ocr',
    label: 'VibeOCR base URL',
    help: 'VibeOCR service (PDF-native OCR), e.g. http://vibe-ocr:8099. On-appliance only — page images never egress. Falls back to GLM-OCR when unset/unreachable.',
    default: '',
  },
  {
    id: 'vibeOcrApiKey',
    key: 'ocr.vibe.api_key',
    env: 'VIBE_OCR_API_KEY',
    kind: 'string',
    group: 'ocr',
    label: 'VibeOCR API key',
    help: 'x-api-key sent to VibeOCR. The on-appliance service accepts any non-empty value; leave blank only if your deployment disables the key check.',
    default: '',
  },
  {
    id: 'vibeOcrTimeoutMs',
    key: 'ocr.vibe.timeout_ms',
    env: 'VIBE_OCR_TIMEOUT_MS',
    kind: 'int',
    group: 'ocr',
    label: 'VibeOCR job timeout',
    help: 'Overall budget for one VibeOCR job (submit + poll + result) across all pages.',
    default: '300000',
    min: 5000,
    max: 1_800_000,
    unit: 'ms',
  },
  // --- Scanned-statement OCR (GLM-OCR; ADR-025) ---
  {
    id: 'ocrDpi',
    key: 'ocr.raster_dpi',
    env: 'VIBETC_OCR_RASTER_DPI',
    kind: 'int',
    group: 'ocr',
    label: 'OCR raster DPI',
    help: 'Resolution scanned pages are rasterized to (PNG) before GLM-OCR. Higher = sharper small text (better OCR) but larger requests and more timeout risk.',
    default: '200',
    min: 72,
    max: 600,
  },
  {
    id: 'glmOcrUrl',
    key: 'ocr.glm.url',
    env: 'GLM_OCR_URL',
    kind: 'string',
    group: 'ocr',
    label: 'GLM-OCR base URL',
    help: 'Local GLM-OCR llama-server (OpenAI-compatible vision) that transcribes scanned statement pages. e.g. http://glm-ocr:8090. On-appliance only — page images never egress. Required for scanned OCR; unset ⇒ scanned extraction fails fast.',
    default: '',
  },
  {
    id: 'glmOcrModel',
    key: 'ocr.glm.model',
    env: 'GLM_OCR_MODEL',
    kind: 'string',
    group: 'ocr',
    label: 'GLM-OCR model',
    help: 'Model id the GLM-OCR llama-server advertises. Must be exactly "glm-ocr".',
    default: 'glm-ocr',
  },
  {
    id: 'glmOcrTimeoutMs',
    key: 'ocr.glm.timeout_ms',
    env: 'GLM_OCR_TIMEOUT_MS',
    kind: 'int',
    group: 'ocr',
    label: 'GLM-OCR timeout',
    help: 'Per-page OCR timeout. ~120s gives 2× headroom over CPU inference; drop to ~30000 on GPU.',
    default: '120000',
    min: 1000,
    max: 600_000,
    unit: 'ms',
  },
  {
    id: 'glmOcrConcurrency',
    key: 'ocr.glm.concurrency',
    env: 'GLM_OCR_CONCURRENCY',
    kind: 'int',
    group: 'ocr',
    label: 'GLM-OCR concurrency',
    help: 'Pages OCR’d in parallel against the GLM-OCR server. Raise on a GPU box; keep low on CPU to avoid contention.',
    default: '2',
    min: 1,
    max: 8,
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

// --- Per-process provider matrix ---------------------------------------------
// For each of the four LLM processes, the operator can pick the provider
// (default = follow the global routing policy), the model, and tuning knobs
// (max output tokens, temperature, num_ctx, prompt budget). Generated so all
// four processes stay identical. Resolved by resolveProcessConfig() and applied
// by buildProviderForProcess() in llm-provider.ts.

const processDefs = (proc: ProcessId): AiSettingDef[] => {
  const group = `proc-${proc}` as AiSettingGroup;
  const ENV = `VIBETC_PROC_${proc.toUpperCase()}`;
  const providerNote =
    proc === 'check'
      ? ' Check images are always OCR-transcribed locally; Anthropic only ever receives the transcribed text.'
      : '';
  const modelNote =
    proc === 'extraction'
      ? ' Ignored when the statement-model engine is enabled (it uses its own model).'
      : '';
  return [
    {
      id: `${proc}Provider`,
      key: `llm.process.${proc}.provider`,
      env: `${ENV}_PROVIDER`,
      kind: 'enum',
      group,
      label: 'Provider',
      help: `Which provider runs this process. "default" follows the global routing policy.${providerNote}`,
      default: 'default',
      enumValues: ['default', 'local', 'anthropic'],
    },
    {
      id: `${proc}Model`,
      key: `llm.process.${proc}.model`,
      env: `${ENV}_MODEL`,
      kind: 'string',
      group,
      label: 'Model',
      help: `Model id for this process. Blank = the provider's configured default model.${modelNote}`,
      default: '',
    },
    {
      id: `${proc}MaxTokens`,
      key: `llm.process.${proc}.max_tokens`,
      env: `${ENV}_MAX_TOKENS`,
      kind: 'int',
      group,
      label: 'Max output tokens',
      help: 'Cap on the response length for this process. Blank = the provider default.',
      default: '',
      min: 256,
      max: 200_000,
    },
    {
      id: `${proc}Temperature`,
      key: `llm.process.${proc}.temperature`,
      env: `${ENV}_TEMPERATURE`,
      kind: 'float',
      group,
      label: 'Temperature',
      help: '0 = deterministic. Blank = the provider default (0 for Ollama).',
      default: '',
      min: 0,
      max: 2,
    },
    {
      id: `${proc}NumCtx`,
      key: `llm.process.${proc}.num_ctx`,
      env: `${ENV}_NUM_CTX`,
      kind: 'int',
      group,
      label: 'Context window (num_ctx, Ollama only)',
      help: 'Ollama input window for this process. Blank = the model default. Ignored by Anthropic.',
      default: '',
      min: 512,
      max: 131_072,
    },
    {
      id: `${proc}PromptBudget`,
      key: `llm.process.${proc}.prompt_budget`,
      env: `${ENV}_PROMPT_BUDGET`,
      kind: 'int',
      group,
      label: 'Input/prompt budget (tokens)',
      help: 'Max input tokens of markdown sent before truncation. Blank = the provider default.',
      default: '',
      min: 1_000,
      max: 200_000,
    },
  ];
};

const PROCESS_SETTINGS: readonly AiSettingDef[] = PROCESS_IDS.flatMap(processDefs);

export const AI_SETTINGS: readonly AiSettingDef[] = [...BASE_AI_SETTINGS, ...PROCESS_SETTINGS];

const byId = (id: string): AiSettingDef | undefined => AI_SETTINGS.find((s) => s.id === id);

export interface ResolvedAiSettings {
  visionTimeoutMs: number;
  visionMaxTokens: number;
  visionThink: boolean | undefined;
  keepAlive: string;
  numCtx: number | undefined;
  localStructuredOutput: 'grammar' | 'json_object';
  maxPromptTokens: number;
  extractionTimeoutMs: number;
  extractionEngine: 'legacy' | 'statement-model';
  statementModel: string;
  ocrEngine: 'vibe' | 'glm';
  vibeOcrUrl: string;
  vibeOcrApiKey: string;
  vibeOcrTimeoutMs: number;
  ocrDpi: number;
  glmOcrUrl: string;
  glmOcrModel: string;
  glmOcrTimeoutMs: number;
  glmOcrConcurrency: number;
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

export interface ResolvedProcessConfig {
  provider: 'default' | 'local' | 'anthropic';
  model: string | null;
  maxTokens: number | null;
  temperature: number | null;
  numCtx: number | null;
  promptBudget: number | null;
}

// Resolve the per-process provider matrix for one process (DB → env → default
// per setting). 'default' provider means "follow the global routing policy";
// null fields mean "use the provider's configured default".
export const resolveProcessConfig = async (
  db: Db,
  proc: ProcessId,
): Promise<ResolvedProcessConfig> => {
  const raw = await loadRaw(db);
  const str = (id: string): string => {
    const def = byId(id);
    return def ? raw(def) : '';
  };
  const num = (id: string): number | null => {
    const s = str(id);
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const prov = str(`${proc}Provider`);
  return {
    provider: prov === 'local' || prov === 'anthropic' ? prov : 'default',
    model: str(`${proc}Model`) || null,
    maxTokens: num(`${proc}MaxTokens`),
    temperature: num(`${proc}Temperature`),
    numCtx: num(`${proc}NumCtx`),
    promptBudget: num(`${proc}PromptBudget`),
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
    maxPromptTokens: intOf('maxPromptTokens'),
    extractionTimeoutMs: intOf('extractionTimeoutMs'),
    extractionEngine:
      raw(byId('extractionEngine')!) === 'statement-model' ? 'statement-model' : 'legacy',
    statementModel: raw(byId('statementModel')!) || 'qwen2.5-stmt',
    ocrEngine: raw(byId('ocrEngine')!) === 'glm' ? 'glm' : 'vibe',
    vibeOcrUrl: raw(byId('vibeOcrUrl')!),
    vibeOcrApiKey: raw(byId('vibeOcrApiKey')!),
    vibeOcrTimeoutMs: intOf('vibeOcrTimeoutMs'),
    ocrDpi: intOf('ocrDpi'),
    glmOcrUrl: raw(byId('glmOcrUrl')!),
    glmOcrModel: raw(byId('glmOcrModel')!),
    glmOcrTimeoutMs: intOf('glmOcrTimeoutMs'),
    glmOcrConcurrency: intOf('glmOcrConcurrency'),
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
