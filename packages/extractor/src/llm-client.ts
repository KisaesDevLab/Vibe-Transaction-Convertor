// LLM provider abstraction (ADR-019, ADR-020). Two implementations,
// shared contract — downstream code never branches on provider.

import { schemas } from '@vibe-tx-converter/shared';
import {
  IMAGE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  cleanupMarkdown,
  estimateTokens,
  imageUserPromptFor,
  missingFieldsReminderPromptFor,
  userPromptFor,
  type UserPromptOptions,
} from './prompts/extract.js';
import { exemplarsAsMessages } from './exemplars.js';
import { ocrPdfPages, type GlmOcrClientOptions } from './glm-ocr-client.js';

// Phase 12 item 11: prompt budget. The Vibe Gateway hosts Qwen3-8B with a
// 32K context, which after exemplars + system prompt + completion reserve
// leaves ~24K input tokens for the markdown. Operators can shrink this via
// LLM_MAX_PROMPT_TOKENS for cheaper providers.
const PROMPT_BUDGET_RESERVE = 4_000;
const defaultPromptBudget = (): number => Number(process.env.LLM_MAX_PROMPT_TOKENS ?? 24_000);

// Compact, PII-free description of an Anthropic /v1/messages request, for
// attaching to a 4xx error so an operator can diagnose a 400 from the app
// trace alone: it reports the model, the max_tokens we sent, and the message
// shape (text blocks, message count). Only counts/sizes are included; never
// prompt text. (Anthropic is the text-only extraction path now — no images.)
export const describeAnthropicRequest = (
  messages: Array<{ role: string; content: unknown }>,
  model: string,
  maxTokens: number,
  viaGateway: boolean,
): string => {
  let images = 0;
  let imageB64Bytes = 0;
  let textBlocks = 0;
  const mediaTypes = new Set<string>();
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') {
      textBlocks += 1;
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const block of c) {
      const b = block as { type?: string; source?: { data?: unknown; media_type?: unknown } };
      if (b?.type === 'image') {
        images += 1;
        if (typeof b.source?.data === 'string') imageB64Bytes += b.source.data.length;
        if (typeof b.source?.media_type === 'string') mediaTypes.add(b.source.media_type);
      } else if (b?.type === 'text') {
        textBlocks += 1;
      }
    }
  }
  return (
    `model=${model} max_tokens=${maxTokens} msgs=${messages.length} ` +
    `text=${textBlocks} images=${images} imageB64Bytes=${imageB64Bytes} ` +
    `media=${[...mediaTypes].join('|') || 'none'} viaGateway=${viaGateway}`
  );
};

// Cleans the markdown and truncates it to fit the prompt budget. Returns
// the cleaned text plus the token count for telemetry. When the cleaned
// text exceeds the budget, the head and tail are both preserved with a
// gap marker in between — the head carries the opening balance and the
// statement header, the tail carries the closing balance and the last
// transactions. Truncating only the head (the prior default) guaranteed
// reconciliation discrepancy on any statement longer than ~30 pages,
// because the Golden Rule needs `closing_cents` and the trailing rows
// to tie.
export const prepareMarkdown = (
  raw: string,
  budget: number = defaultPromptBudget(),
): { text: string; tokens: number; truncated: boolean } => {
  const cleaned = cleanupMarkdown(raw);
  const allowed = Math.max(1_000, budget - PROMPT_BUDGET_RESERVE);
  const tokens = estimateTokens(cleaned);
  if (tokens <= allowed) return { text: cleaned, tokens, truncated: false };
  const charBudget = allowed * 4;
  // Reserve a marker plus a safety margin so the gap message itself
  // never tips us back over the budget.
  const MARKER = '\n\n…[middle of statement truncated]…\n\n';
  const usableChars = Math.max(2_000, charBudget - MARKER.length - 200);
  // 60/40 split toward the tail — the head still gets enough room for
  // the institution / account / opening-balance header (typically the
  // first 1–2 pages), and the tail gets the closing balance and the
  // final stretch of transactions.
  const headChars = Math.floor(usableChars * 0.6);
  const tailChars = usableChars - headChars;
  const head = cleaned.slice(0, headChars);
  const tail = cleaned.slice(cleaned.length - tailChars);
  const text = `${head}${MARKER}${tail}`;
  return { text, tokens: estimateTokens(text), truncated: true };
};

const { ExtractionResult } = schemas.extraction;
type ExtractionResult = schemas.extraction.ExtractionResult;

// Thrown by both providers when the LLM returns JSON that doesn't match
// ExtractionResult. The worker catches this specifically so it can log
// the raw response to audit_log and surface a friendlier error to the
// UI than the bare ZodError stringification (which used to leak as e.g.
// `[ { "code": "invalid_type", "expected": "array", "path": [...] } ]`).
//
// `.message` carries the human-readable summary (no raw payload) so it
// is safe to display in toasts and persist to statements.error_message.
// `.rawResponse` carries the full payload for diagnostic capture and
// must not be surfaced directly in user-facing UI.
// Translate `AbortController.abort()` (which surfaces as a DOMException
// named 'AbortError' with the message "This operation was aborted" on
// Node's undici fetch, or TimeoutError on some runtimes) into a labelled
// timeout error. The original DOM error has no URL / no timeout / no
// context — operators saw `errorClass: 'DOMException'` in audit_log
// and had to guess which call timed out. Preserves the original as
// `.cause` so the underlying stack stays recoverable. Pass-through
// for any non-abort error.
const asTimeoutError = (err: unknown, label: string, timeoutMs: number): Error => {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    const wrapped = new Error(`${label} timed out after ${timeoutMs} ms`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }
  return err as Error;
};

// Read a non-2xx HTTP body for diagnostics, truncated and best-effort. Ollama
// returns a JSON `{"error":"…"}` on its /v1 and /api/chat surfaces (model not
// pulled, OOM during load, grammar-compile failure on a `format`/`json_schema`
// request); without it a bare `HTTP 500` is undiagnosable from the audit trace.
// Mirrors the Anthropic path, which already surfaces `res.text()`. Returns a
// `: <body>` suffix (empty string when the body is empty/unreadable) so callers
// append it directly to the status message.
const readErrorBodySuffix = async (res: { text(): Promise<string> }): Promise<string> => {
  const body = await res.text().catch(() => '');
  return body ? `: ${body.slice(0, 500)}` : '';
};

// Ollama's structured-output grammar engine (llama.cpp GBNF, used for both the
// /v1 `response_format.json_schema` and the native `format` paths) does not
// support JSON-Schema `pattern` (regex) constraints. When a `pattern` is present
// it silently DROPS grammar enforcement for that schema, so the model free-
// writes prose — we observed qwen return a markdown summary instead of JSON for
// the date-`pattern` extraction schema, which then fails Zod and bounces the
// statement to the Anthropic fallback. Strip every `pattern` from any schema
// bound for Ollama; the Zod layer still enforces the regex after parsing
// (parseExtractionResponse → ExtractionResult), so validation is unchanged. The
// Anthropic provider keeps the full schema (its tool input_schema honors
// `pattern`). Returns a deep copy — the caller's schema object is not mutated.
export const sanitizeSchemaForOllama = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForOllama);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'pattern') continue;
      out[key] = sanitizeSchemaForOllama(value);
    }
    return out;
  }
  return schema;
};

export class ExtractionResponseError extends Error {
  readonly rawResponse: string;
  readonly summary: string;
  readonly issues?: string;
  // Top-level fields the LLM omitted (e.g. ['transactions']). Populated
  // when the failure was a Zod "Required" miss at depth 1; empty
  // otherwise. Providers consult this to decide whether to do a one-
  // shot reminder retry instead of bouncing to provider fallback.
  readonly missingTopLevelFields: string[];
  constructor(opts: {
    summary: string;
    rawResponse: string;
    issues?: string;
    missingTopLevelFields?: string[];
  }) {
    super(opts.issues ? `${opts.summary} (${opts.issues})` : opts.summary);
    this.name = 'ExtractionResponseError';
    this.rawResponse = opts.rawResponse;
    this.summary = opts.summary;
    if (opts.issues !== undefined) this.issues = opts.issues;
    this.missingTopLevelFields = opts.missingTopLevelFields ?? [];
  }
}

// Strip a single wrapping ```json … ``` (or bare ```) fence. Only strips
// when the fence encloses the whole string after trim — a fence mid-prose is
// left for the balanced scanner to find.
const stripCodeFences = (s: string): string => {
  const m = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  return m && m[1] != null ? m[1].trim() : s;
};

// Walk the input and return the first balanced `{…}` slice, respecting JSON
// string semantics so a brace inside a `"…"` value doesn't close the wrong
// scope. Ported from myBooks `json-utils.ts` — Ollama wraps its JSON in prose
// and stray-brace-bearing descriptions more often than the old Vibe gateway,
// and the naive first-{/last-} slice mis-parses those.
const firstBalancedObjectSlice = (s: string): string | null => {
  const startIdx = s.indexOf('{');
  if (startIdx < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i += 1) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
};

// Recovers a JSON object when the model wraps it in prose or code fences.
// A false positive is impossible: any extra text inside the slice makes
// JSON.parse fail.
const recoverProseWrappedJson = (raw: string): unknown | undefined => {
  const trimmed = stripCodeFences(raw.trim());
  const slice = firstBalancedObjectSlice(trimmed);
  if (!slice) return undefined;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
};

// Some models (especially in json_object mode, with no grammar to constrain
// shape) "compress" several same-date transactions into ONE object whose
// `description` and `amount_cents` are PARALLEL ARRAYS, e.g.
//   { posted_date, description: ["A","B"], amount_cents: [100, 200], … }
// Expand each such object back into one transaction per array element so a
// model quirk doesn't fail the whole statement. Scalars are broadcast to the
// array length (and a short array repeats its last element); the Golden Rule +
// review grid are the safety net for any row the model genuinely mangled.
export const expandArrayTransactions = (parsed: unknown): unknown => {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.transactions)) return parsed;
  const at = (v: unknown, isArr: boolean, i: number): unknown => {
    if (!isArr) return v;
    const arr = v as unknown[];
    return arr[i] ?? arr[arr.length - 1];
  };
  const out: unknown[] = [];
  for (const tx of obj.transactions) {
    if (typeof tx !== 'object' || tx === null) {
      out.push(tx);
      continue;
    }
    const t = tx as Record<string, unknown>;
    const descArr = Array.isArray(t.description);
    const amtArr = Array.isArray(t.amount_cents);
    if (!descArr && !amtArr) {
      out.push(tx);
      continue;
    }
    const len = Math.max(
      descArr ? (t.description as unknown[]).length : 1,
      amtArr ? (t.amount_cents as unknown[]).length : 1,
    );
    for (let i = 0; i < len; i += 1) {
      out.push({
        ...t,
        description: at(t.description, descArr, i),
        amount_cents: at(t.amount_cents, amtArr, i),
      });
    }
  }
  return { ...obj, transactions: out };
};

// Wraps JSON.parse + Zod validation in ExtractionResponseError so the
// worker has a single error type to special-case for diagnostic
// capture. Pass `alreadyParsed` for providers that hand us an already-
// parsed object (Anthropic tool_use); we still need rawResponse for
// the audit log, so callers stringify it for us.
export const parseExtractionResponse = (
  rawResponse: string,
  alreadyParsed?: unknown,
): ExtractionResult => {
  let parsed = alreadyParsed;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(rawResponse);
    } catch (err) {
      const recovered = recoverProseWrappedJson(rawResponse);
      if (recovered !== undefined) {
        parsed = recovered;
      } else {
        throw new ExtractionResponseError({
          summary: 'LLM response was not valid JSON',
          rawResponse,
          issues: `${(err as Error).message}; prose-recovery attempt also failed`,
        });
      }
    }
  }
  // Salvage parallel-array "compressed" transactions before validation.
  parsed = expandArrayTransactions(parsed);
  const result = ExtractionResult.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join('.') : '<root>';
        return `${path}: ${i.message}`;
      })
      .join('; ');
    // Detect "the LLM emitted JSON but omitted a top-level required
    // field" — Zod surfaces this as either a "Required" message or
    // an invalid_type issue with received='undefined' at path depth 1.
    // Two Zod versions in our dep tree (peer + transitive) use slightly
    // different shapes, so check both.
    const missingTopLevelFields: string[] = [];
    for (const issue of result.error.issues) {
      if (issue.path.length !== 1) continue;
      const isLegacyRequired = issue.message === 'Required';
      const recv = (issue as { received?: unknown }).received;
      const isUndefinedRecv = issue.code === 'invalid_type' && recv === 'undefined';
      if (isLegacyRequired || isUndefinedRecv) {
        missingTopLevelFields.push(String(issue.path[0]));
      }
    }
    throw new ExtractionResponseError({
      summary: 'LLM response did not match extraction schema',
      rawResponse,
      issues,
      missingTopLevelFields,
    });
  }
  return result.data;
};

export interface ExtractCallTelemetry {
  inputTokens: number;
  outputTokens: number;
  ms: number;
  model: string;
  costMicros: bigint;
}

export interface ExtractResult {
  data: ExtractionResult;
  telemetry: ExtractCallTelemetry;
  rawJson: string;
}

export interface ExtractOptions extends UserPromptOptions {
  schema?: object;
  // Operator-overridable extraction system prompt (resolved DB → default by the
  // worker via extraction-prompt service). When set it replaces the built-in
  // SYSTEM_PROMPT for this call; unset falls back to SYSTEM_PROMPT. Applies to
  // the text/markdown path on both providers (the vision path is unused now).
  systemPromptOverride?: string | undefined;
  // Vision/OCR extraction. Rasterized page images handed to the local Ollama
  // Qwen-VL provider, which OCRs and extracts in one call (ADR-023). Local
  // provider only — page images never egress; the Anthropic provider is
  // text-only and ignores this field.
  images?:
    | Array<{ data: Buffer; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }>
    | undefined;
}

// Generic structured-output call for non-extraction LLM use (description
// cleansing, business-category assignment, future enrichments). The
// caller supplies its own system + user prompts and JSON Schema; the
// provider returns the parsed-but-not-validated payload plus the same
// telemetry shape `extract()` produces. The caller is responsible for
// validating the payload against its own Zod schema.
export interface CompleteOptions {
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  // Identifier the local gateway uses inside `response_format.json_schema.name`
  // and the Anthropic provider uses as the tool name. Defaults to
  // 'structured_output' but operators benefit from a descriptive value
  // in audit/logs.
  schemaName?: string | undefined;
  maxOutputTokens?: number | undefined;
  // Optional image attachments. Vision/OCR runs through the local Ollama
  // provider's extract() path (native /api/chat); the generic complete()
  // structured-output path is text-only and throws if images are passed, so
  // callers don't silently lose data.
  images?:
    | Array<{
        data: Buffer;
        mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      }>
    | undefined;
}

export interface CompleteResult {
  data: unknown;
  rawJson: string;
  telemetry: ExtractCallTelemetry;
}

export interface OcrToMarkdownOptions {
  images: NonNullable<CompleteOptions['images']>;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens?: number | undefined;
}

export interface OcrToMarkdownResult {
  markdown: string;
  telemetry: ExtractCallTelemetry;
}

export interface OcrToTextResult {
  text: string;
  ms: number;
  model: string;
}

export interface LlmProvider {
  readonly id: 'local' | 'anthropic';
  extract(markdown: string, opts?: ExtractOptions | object): Promise<ExtractResult>;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  // Generic vision call: hands page images + a JSON schema to a vision-capable
  // model and returns the parsed-but-not-validated JSON (caller validates with
  // its own Zod schema). Used by the check-payee resolver. Local provider only
  // — AnthropicProvider is text-only and throws. (Mirrors the extract() vision
  // path but with a caller-supplied prompt + schema instead of the fixed
  // statement-extraction ones.)
  completeWithImages(opts: CompleteOptions): Promise<CompleteResult>;
  // OCR-only vision call: transcribes page image(s) to faithful markdown TEXT
  // (no JSON schema / `format`). Stage 1 of two-stage scanned extraction — the
  // markdown then goes through the normal text extract() path. Local provider
  // only; page images never egress, so AnthropicProvider throws.
  ocrToMarkdown(opts: OcrToMarkdownOptions): Promise<OcrToMarkdownResult>;
  // OCR image(s) to plain text (no schema), for the check-payee primary path
  // (GLM-OCR transcribe → text-parse, ADR-025). Local provider only — Anthropic
  // throws (page images never egress).
  ocrImagesToText(images: NonNullable<CompleteOptions['images']>): Promise<OcrToTextResult>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

// Helper — second arg used to be a bare schema object; some callers still
// pass that shape. Accept both, coerce to ExtractOptions.
const coerceOpts = (arg?: ExtractOptions | object): ExtractOptions => {
  if (!arg) return {};
  // Heuristic: a JSON Schema has a `type` or `$schema` or `properties` key.
  // ExtractOptions has dateFormatOverride / schema / accountTypeHint.
  const a = arg as Record<string, unknown>;
  const isSchema = 'type' in a || '$schema' in a || 'properties' in a;
  if (isSchema && !('schema' in a) && !('dateFormatOverride' in a) && !('accountTypeHint' in a)) {
    return { schema: arg };
  }
  return arg as ExtractOptions;
};

// ---- Local Ollama provider (text via OpenAI-compat /v1, vision via /api/chat) ----

export interface LocalGatewayProviderOptions {
  baseUrl?: string | undefined;
  // Text-extraction model (OpenAI-compat /v1/chat/completions path).
  modelId?: string | undefined;
  // Vision/OCR model (native /api/chat path). Defaults to DEFAULT_VISION_MODEL
  // (a dedicated multimodal model) when unset — never the text model.
  visionModelId?: string | undefined;
  timeoutMs?: number | undefined;
  // A 200–300 DPI page image legitimately takes a minute or more to OCR on
  // CPU, so the vision call gets a longer budget than the text path.
  visionTimeoutMs?: number | undefined;
  // Vision tuning, normally resolved from system_settings by the factory and
  // passed through here (each falls back to its env var / default when unset).
  visionMaxTokens?: number | undefined;
  keepAlive?: string | undefined;
  numCtx?: number | undefined;
  visionThink?: boolean | undefined;
  // Local text-extraction structured-output mode. 'grammar' (default) constrains
  // generation with the JSON-schema grammar and falls back to json_object on a
  // grammar dead-end; 'json_object' skips the grammar entirely — faster when the
  // grammar reliably trips on a firm's OCR text. Resolved from the admin setting
  // / LLM_LOCAL_STRUCTURED_OUTPUT by the factory.
  structuredOutputMode?: 'grammar' | 'json_object' | undefined;
  // Prompt budget (tokens): caps how much statement markdown is sent before the
  // head/tail truncation kicks in. Operator setting / LLM_MAX_PROMPT_TOKENS.
  maxPromptTokens?: number | undefined;
  // Hard cap on OUTPUT tokens for the text-extraction call (Ollama max_tokens).
  // A transaction-heavy statement needs headroom or the model truncates the JSON
  // array mid-row (finish_reason=length → "Unterminated string"). Resolved from
  // the admin "Max output tokens" setting / LLM_MAX_COMPLETION_TOKENS.
  maxCompletionTokens?: number | undefined;
  // GLM-OCR stage-1 engine (ADR-025). Scanned statement pages are transcribed
  // by a LOCAL GLM-OCR llama-server (OpenAI-compatible vision) instead of an
  // Ollama vision model — GLM-OCR is a purpose-built OCR engine. Each falls back
  // to its GLM_OCR_* env in the GLM client. baseUrl is required for the OCR
  // path; when unset, ocrToMarkdown throws (no MiniCPM fallback — hard-removed).
  glmOcrUrl?: string | undefined;
  glmOcrModel?: string | undefined;
  glmOcrPrompt?: string | undefined;
  glmOcrTimeoutMs?: number | undefined;
  glmOcrConcurrency?: number | undefined;
  glmOcrApiKey?: string | undefined;
  fetcher?: typeof fetch | undefined;
}

// Ollama drives both paths in the same process now (Shield + GLM-OCR removed):
// the OpenAI-compatible /v1/chat/completions endpoint for text-layer markdown,
// and the native /api/chat endpoint for vision/OCR of scanned pages. Native is
// used for vision because Ollama's `format: <json-schema>` structured-output
// support is more complete there than on the /v1 surface. Page images are
// processed locally and never egress (ADR-023). See myBooks
// `services/ai-providers/ollama.provider.ts` for the reference request shapes.

// Default vision model — used ONLY for the check-payee fallback now (ADR-025):
// scanned statement OCR runs on GLM-OCR, not an Ollama vision model. This is a
// capable multimodal model that reads cancelled-check images when the GLM-OCR
// transcribe→text-parse primary path comes up empty. Operators override via
// OLLAMA_VISION_MODEL / the admin vision-model picker.
export const DEFAULT_VISION_MODEL = 'qwen3-vl:30b';

// Default text-extraction model (non-thinking instruct — see ADR-024). Exported
// so the API layer can label "which model is in use" during processing without
// duplicating the literal and risking drift from the provider default below.
export const DEFAULT_TEXT_MODEL = 'qwen2.5:32b-instruct';

export class LocalGatewayProvider implements LlmProvider {
  readonly id = 'local' as const;
  private baseUrl: string;
  private modelId: string;
  private visionModelId: string;
  private timeoutMs: number;
  private visionTimeoutMs: number;
  private keepAlive: string;
  private numCtx: number | undefined;
  // Hard output cap for the vision call (Ollama `num_predict`). Without it the
  // model can generate unbounded JSON for a large statement and, under the
  // grammar-constrained `format` decode on a slow/CPU host, blow past the
  // per-call timeout. Operator-tunable via OLLAMA_VISION_MAX_TOKENS.
  private visionMaxTokens: number;
  // Native /api/chat `think` toggle for the vision model. Only sent when the
  // operator sets OLLAMA_VISION_THINK (a non-thinking model rejects `think`).
  // Reasoning is off by default — it doubles latency and a schema-constrained
  // OCR pass rarely needs it.
  private visionThink: boolean | undefined;
  // See LocalGatewayProviderOptions.structuredOutputMode.
  private structuredOutputMode: 'grammar' | 'json_object';
  // See LocalGatewayProviderOptions.maxPromptTokens.
  private maxPromptTokens: number;
  // See LocalGatewayProviderOptions.maxCompletionTokens.
  private maxCompletionTokens: number;
  // GLM-OCR client options (ADR-025) — built once from the provider opts and
  // passed to ocrPdfPages on every OCR call. baseUrl unset ⇒ the OCR path throws.
  private glmOcr: GlmOcrClientOptions;
  private fetcher: typeof fetch;

  constructor(opts: LocalGatewayProviderOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.OLLAMA_BASE_URL ??
      process.env.LLM_GATEWAY_URL ??
      'http://localhost:11434'
    )
      // Tolerate an operator pasting the OpenAI-compat base (…/v1): the text
      // path re-appends /v1 and the vision path needs the native root.
      .replace(/\/v1\/?$/, '')
      .replace(/\/$/, '');
    // Default text-extraction model. qwen2.5-instruct (non-thinking) is a more
    // reliable schema-constrained extractor than the thinking qwen3.5 MoE, which
    // burned a reasoning pass per call and free-wrote prose under grammar
    // constraints. Operators override via the admin LLM-provider page (DB) or
    // LLM_MODEL_ID.
    this.modelId = opts.modelId ?? process.env.LLM_MODEL_ID ?? DEFAULT_TEXT_MODEL;
    this.visionModelId =
      opts.visionModelId ?? process.env.OLLAMA_VISION_MODEL ?? DEFAULT_VISION_MODEL;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
    // 300s default: a 200–300 DPI page through a large -VL model on CPU (or a
    // cold model load on first call) legitimately exceeds the old 120s budget.
    this.visionTimeoutMs =
      opts.visionTimeoutMs ?? Number(process.env.OLLAMA_VISION_TIMEOUT_MS ?? 300_000);
    this.visionMaxTokens =
      opts.visionMaxTokens ?? Number(process.env.OLLAMA_VISION_MAX_TOKENS ?? 8_192);
    this.keepAlive = opts.keepAlive ?? process.env.OLLAMA_KEEP_ALIVE ?? '30m';
    const numCtxEnv = Number(process.env.OLLAMA_NUM_CTX ?? '');
    this.numCtx =
      opts.numCtx ?? (Number.isFinite(numCtxEnv) && numCtxEnv > 0 ? numCtxEnv : undefined);
    const thinkEnv = process.env.OLLAMA_VISION_THINK;
    this.visionThink =
      opts.visionThink ?? (thinkEnv === 'on' ? true : thinkEnv === 'off' ? false : undefined);
    this.structuredOutputMode =
      opts.structuredOutputMode ??
      (process.env.LLM_LOCAL_STRUCTURED_OUTPUT === 'json_object' ? 'json_object' : 'grammar');
    this.maxPromptTokens = opts.maxPromptTokens ?? defaultPromptBudget();
    // Default raised from the old 6000 — a real multi-page statement's JSON
    // transaction list routinely exceeds 6000 output tokens and got truncated.
    this.maxCompletionTokens =
      opts.maxCompletionTokens ?? Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 16_000);
    // GLM-OCR config (ADR-025). Each field falls back to its GLM_OCR_* env
    // inside the GLM client's resolveConfig; we only forward operator overrides
    // and the shared fetcher (so tests can stub it). An undefined value here
    // lets the env default win.
    this.glmOcr = {
      ...(opts.glmOcrUrl ? { baseUrl: opts.glmOcrUrl } : {}),
      ...(opts.glmOcrModel ? { model: opts.glmOcrModel } : {}),
      ...(opts.glmOcrPrompt ? { prompt: opts.glmOcrPrompt } : {}),
      ...(opts.glmOcrTimeoutMs ? { timeoutMs: opts.glmOcrTimeoutMs } : {}),
      ...(opts.glmOcrConcurrency ? { concurrency: opts.glmOcrConcurrency } : {}),
      ...(opts.glmOcrApiKey ? { apiKey: opts.glmOcrApiKey } : {}),
      fetcher: opts.fetcher ?? fetch,
    };
    this.fetcher = opts.fetcher ?? fetch;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.baseUrl) return { ok: false, detail: 'Ollama base URL not set' };
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      try {
        // Ollama's native liveness/catalog endpoint. A reachable-but-wrong
        // base URL (404/500) must not report "connected".
        const res = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: ctl.signal });
        return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  // Single native /api/chat round-trip for the vision/OCR path. Qwen-VL reads
  // the page image(s) and emits the extraction JSON directly. `format` carries
  // the JSON schema so Ollama constrains generation; temperature 0 for
  // determinism. Returns raw content + telemetry so `extract` can call it
  // twice (initial + reminder retry).
  private async callOllamaVision(
    images: NonNullable<ExtractOptions['images']>,
    schema: object | undefined,
    system: string,
    userPrompt: string,
    // When false, no `format` is sent — the model returns free text (used by the
    // OCR-to-markdown transcription path, stage 1 of two-stage extraction).
    sendFormat = true,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number; ms: number }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.visionTimeoutMs);
    const start = Date.now();
    try {
      const res = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.visionModelId,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: userPrompt,
              images: images.map((img) => img.data.toString('base64')),
            },
          ],
          ...(sendFormat ? { format: schema ? sanitizeSchemaForOllama(schema) : 'json' } : {}),
          stream: false,
          ...(this.visionThink !== undefined ? { think: this.visionThink } : {}),
          keep_alive: this.keepAlive,
          options: {
            temperature: 0,
            num_predict: this.visionMaxTokens,
            ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
          },
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        throw new Error(`ollama vision HTTP ${res.status}${await readErrorBodySuffix(res)}`);
      }
      const body = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const content = body.message?.content ?? '';
      if (!content) {
        throw new ExtractionResponseError({
          summary: 'ollama vision returned an empty completion',
          rawResponse: JSON.stringify(body).slice(0, 8_000),
        });
      }
      return {
        content,
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        ms: Date.now() - start,
      };
    } catch (err) {
      throw asTimeoutError(
        err,
        `ollama vision POST ${this.baseUrl}/api/chat`,
        this.visionTimeoutMs,
      );
    } finally {
      clearTimeout(t);
    }
  }

  // Single round-trip to the gateway. Returns raw content + per-call
  // telemetry; pulled out so `extract` can call it twice (initial +
  // reminder retry) and accumulate tokens without duplicating the
  // request-building logic.
  private async callGateway(
    messages: Array<{ role: string; content: string }>,
    schema: object | undefined,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number; ms: number }> {
    const maxTokens = this.maxCompletionTokens;
    // One round-trip. `useGrammar` chooses between grammar-constrained
    // structured output (schema compiled to a GBNF grammar) and plain JSON
    // mode. Each call owns its own timeout so the json_object retry below gets a
    // fresh budget — the grammar attempt can burn most of its budget before the
    // sampler dead-ends.
    const runOnce = async (
      useGrammar: boolean,
    ): Promise<{ content: string; inputTokens: number; outputTokens: number; ms: number }> => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      const start = Date.now();
      try {
        const res = await this.fetcher(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.modelId,
            messages,
            response_format:
              schema && useGrammar
                ? {
                    type: 'json_schema',
                    json_schema: { name: 'extraction', schema: sanitizeSchemaForOllama(schema) },
                  }
                : { type: 'json_object' },
            temperature: 0,
            max_tokens: maxTokens,
          }),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          const error = new Error(
            `local gateway HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
          ) as Error & { grammarDeadEnd?: boolean };
          // Ollama's grammar engine (llama.cpp GBNF) can dead-end mid-generation
          // on real OCR content — the server returns a 5xx "peg-native format" /
          // grammar error. Tag it so the caller retries once WITHOUT the grammar
          // rather than failing over to the egress Anthropic provider.
          error.grammarDeadEnd =
            Boolean(schema) &&
            useGrammar &&
            res.status >= 500 &&
            /peg|grammar|does not match the expected/i.test(detail);
          throw error;
        }
        const body = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = body.choices?.[0]?.message?.content ?? '';
        if (!content) {
          // 200 with an empty completion. Most commonly when
          // finish_reason='length' (max_tokens too low for the
          // statement) or the gateway swallowed the response. Surface
          // as ExtractionResponseError so the audit log captures the
          // raw body and the operator sees a useful summary instead of
          // "Unexpected end of JSON input".
          const finish = body.choices?.[0]?.finish_reason;
          throw new ExtractionResponseError({
            summary: 'local gateway returned an empty completion',
            rawResponse: JSON.stringify(body).slice(0, 8_000),
            ...(finish ? { issues: `finish_reason=${finish}` } : {}),
          });
        }
        // Non-empty BUT truncated: the model hit max_tokens mid-JSON
        // (finish_reason='length'). Returning it yields a cryptic
        // "Unterminated string" parse error downstream, so surface an
        // actionable message naming the cap the operator can raise.
        if (body.choices?.[0]?.finish_reason === 'length') {
          throw new ExtractionResponseError({
            summary: `local gateway output truncated at max_tokens (${maxTokens})`,
            rawResponse: content.slice(0, 8_000),
            issues: `finish_reason=length; the statement's transaction list exceeds ${maxTokens} output tokens — raise the admin "Max output tokens" knob (or LLM_MAX_COMPLETION_TOKENS), and ensure the Ollama context window (OLLAMA_CONTEXT_LENGTH) has room for prompt + output`,
          });
        }
        return {
          content,
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ms: Date.now() - start,
        };
      } catch (err) {
        throw asTimeoutError(
          err,
          `local gateway POST ${this.baseUrl}/v1/chat/completions`,
          this.timeoutMs,
        );
      } finally {
        clearTimeout(t);
      }
    };

    // Operator opted out of grammar-constrained generation (e.g. the grammar
    // reliably dead-ends on this firm's OCR text) — go straight to json_object
    // and skip the wasted grammar attempt entirely.
    if (this.structuredOutputMode === 'json_object') {
      return runOnce(false);
    }
    try {
      return await runOnce(true);
    } catch (err) {
      if ((err as { grammarDeadEnd?: boolean }).grammarDeadEnd) {
        // The grammar dead-ended on this statement. Retry once in plain JSON
        // mode: the system prompt + exemplars still convey the schema and
        // parseExtractionResponse (Zod) re-validates the result, so we recover
        // locally — keeping processing on-appliance instead of egressing to
        // Anthropic.
        return await runOnce(false);
      }
      throw err;
    }
  }

  async extract(markdown: string, arg?: ExtractOptions | object): Promise<ExtractResult> {
    if (!this.baseUrl) throw new Error('Ollama base URL not set');
    const opts = coerceOpts(arg);
    const promptOpts: UserPromptOptions = {};
    if (opts.dateFormatOverride) promptOpts.dateFormatOverride = opts.dateFormatOverride;
    if (opts.accountTypeHint) promptOpts.accountTypeHint = opts.accountTypeHint;

    // Vision/OCR path (scanned statements): Qwen-VL reads the page image(s)
    // via native /api/chat and emits the extraction JSON in one call. Same
    // one-shot reminder retry on a missing top-level field as the text path.
    if (opts.images && opts.images.length > 0) {
      let userPrompt = imageUserPromptFor(promptOpts);
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalMs = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const call = await this.callOllamaVision(
          opts.images,
          opts.schema,
          IMAGE_SYSTEM_PROMPT,
          userPrompt,
        );
        totalInputTokens += call.inputTokens;
        totalOutputTokens += call.outputTokens;
        totalMs += call.ms;
        try {
          const data = parseExtractionResponse(call.content);
          return {
            data,
            rawJson: call.content,
            telemetry: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              ms: totalMs,
              model: this.visionModelId,
              costMicros: 0n, // local hardware
            },
          };
        } catch (err) {
          if (
            attempt < 2 &&
            err instanceof ExtractionResponseError &&
            err.missingTopLevelFields.length > 0
          ) {
            userPrompt =
              `Your previous response was REJECTED — missing required field(s): ` +
              `${err.missingTopLevelFields.join(', ')}. Re-read the image(s) and emit the ` +
              `FULL extraction JSON with period, balances, source_date_format, AND ` +
              `transactions all present. "transactions" MUST be an array (emit [] if none). ` +
              `Output only the JSON.`;
            continue;
          }
          throw err;
        }
      }
      throw new Error('ollama vision extract: retry loop exhausted unexpectedly');
    }

    const { text } = prepareMarkdown(markdown, this.maxPromptTokens);

    // One-shot reminder retry. When the gateway returns valid JSON
    // missing a required top-level field (the Vibe Gateway with
    // relaxed json_schema enforcement is the typical culprit), retry
    // once with a prompt that names the missing field(s) explicitly.
    // Telemetry accumulates across both calls.
    let userPrompt = userPromptFor(text, promptOpts);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalMs = 0;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages = [
        { role: 'system', content: opts.systemPromptOverride ?? SYSTEM_PROMPT },
        ...exemplarsAsMessages(),
        { role: 'user', content: userPrompt },
      ];
      const call = await this.callGateway(messages, opts.schema);
      totalInputTokens += call.inputTokens;
      totalOutputTokens += call.outputTokens;
      totalMs += call.ms;
      try {
        const data = parseExtractionResponse(call.content);
        return {
          data,
          rawJson: call.content,
          telemetry: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ms: totalMs,
            model: this.modelId,
            costMicros: 0n, // local gateway is free
          },
        };
      } catch (err) {
        if (
          attempt < 2 &&
          err instanceof ExtractionResponseError &&
          err.missingTopLevelFields.length > 0
        ) {
          userPrompt = missingFieldsReminderPromptFor(text, err.missingTopLevelFields, promptOpts);
          continue;
        }
        throw err;
      }
    }
    // Loop body either returns or throws — unreachable, but TypeScript
    // can't see that without an explicit terminator.
    throw new Error('local gateway extract: retry loop exhausted unexpectedly');
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    if (!this.baseUrl) throw new Error('Ollama base URL not set');
    if (opts.images && opts.images.length > 0) {
      // The generic structured-output path is text-only. Vision/OCR has a
      // dedicated path on extract() (native /api/chat); fail loud here so an
      // image-bearing enrichment call doesn't silently drop its attachments.
      throw new Error('ollama complete() does not accept image inputs — use extract() for vision');
    }
    const messages = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    const start = Date.now();
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: opts.schemaName ?? 'structured_output',
              schema: sanitizeSchemaForOllama(opts.schema),
            },
          },
          temperature: 0,
          max_tokens: opts.maxOutputTokens ?? Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        throw new Error(`local gateway HTTP ${res.status}${await readErrorBodySuffix(res)}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      // Mirror the extract/vision paths: guard an empty completion and recover
      // prose-wrapped JSON, surfacing failures as a diagnosable
      // ExtractionResponseError (with the raw response) instead of a bare
      // SyntaxError. An empty 200 (e.g. finish_reason='length') is common.
      if (content.trim().length === 0) {
        throw new ExtractionResponseError({
          summary: 'ollama complete() returned an empty completion',
          rawResponse: '',
        });
      }
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        const recovered = recoverProseWrappedJson(content);
        if (recovered === undefined) {
          throw new ExtractionResponseError({
            summary: 'ollama complete() response was not valid JSON',
            rawResponse: content.slice(0, 8_000),
          });
        }
        data = recovered;
      }
      return {
        data,
        rawJson: content,
        telemetry: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ms: Date.now() - start,
          model: this.modelId,
          costMicros: 0n,
        },
      };
    } catch (err) {
      throw asTimeoutError(
        err,
        `local gateway POST ${this.baseUrl}/v1/chat/completions (complete)`,
        this.timeoutMs,
      );
    } finally {
      clearTimeout(t);
    }
  }

  // Generic vision call (native /api/chat). Reuses callOllamaVision with the
  // caller's system/user prompt + JSON schema; returns parsed-but-unvalidated
  // JSON. Page images are processed locally and never egress (ADR-023).
  async completeWithImages(opts: CompleteOptions): Promise<CompleteResult> {
    if (!this.baseUrl) throw new Error('Ollama base URL not set');
    if (!opts.images || opts.images.length === 0) {
      throw new Error('completeWithImages requires at least one image');
    }
    const call = await this.callOllamaVision(
      opts.images,
      opts.schema,
      opts.systemPrompt,
      opts.userPrompt,
    );
    let data: unknown;
    try {
      data = JSON.parse(call.content);
    } catch {
      const recovered = recoverProseWrappedJson(call.content);
      if (recovered === undefined) {
        throw new ExtractionResponseError({
          summary: 'ollama vision response was not valid JSON',
          rawResponse: call.content.slice(0, 8_000),
        });
      }
      data = recovered;
    }
    return {
      data,
      rawJson: call.content,
      telemetry: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        ms: call.ms,
        model: this.visionModelId,
        costMicros: 0n, // local hardware
      },
    };
  }

  // Model label for the GLM-OCR engine (ADR-025), for telemetry / the live
  // processing stepper's OCR phase.
  private get glmModelLabel(): string {
    return this.glmOcr.model ?? process.env.GLM_OCR_MODEL ?? 'glm-ocr';
  }

  // OCR-only: transcribe page image(s) to faithful markdown TEXT via the LOCAL
  // GLM-OCR engine (ADR-025) — a purpose-built OCR llama-server, NOT an Ollama
  // vision model (MiniCPM-V was hard-removed). The markdown then goes through
  // the reliable text extract() path (stage 2). Page images are processed
  // locally and never egress. On ANY GLM-OCR error this rejects — there is no
  // MiniCPM fallback; the worker surfaces the failure.
  async ocrToMarkdown(opts: OcrToMarkdownOptions): Promise<OcrToMarkdownResult> {
    if (!opts.images || opts.images.length === 0) {
      throw new Error('ocrToMarkdown requires at least one image');
    }
    const start = Date.now();
    const ocr = await ocrPdfPages(
      opts.images.map((i) => i.data),
      this.glmOcr,
    );
    // Strip an outer ``` / ```json fence per page if GLM wrapped its output.
    const markdown = ocr.pages.map((p) => stripCodeFences(p.markdown.trim()).trim()).join('\n\n');
    return {
      markdown,
      telemetry: {
        // llama-server OCR does not report token usage; cost is 0 (local hw).
        inputTokens: 0,
        outputTokens: 0,
        ms: Date.now() - start,
        model: this.glmModelLabel,
        costMicros: 0n,
      },
    };
  }

  // OCR image(s) to plain text via GLM-OCR — the check-payee PRIMARY path
  // (transcribe → text-parse, ADR-025). Concatenates per-page text. Rejects on
  // any GLM-OCR error so the resolver can fall back to the vision model.
  async ocrImagesToText(images: NonNullable<CompleteOptions['images']>): Promise<OcrToTextResult> {
    if (!images || images.length === 0) {
      throw new Error('ocrImagesToText requires at least one image');
    }
    const start = Date.now();
    const ocr = await ocrPdfPages(
      images.map((i) => i.data),
      this.glmOcr,
    );
    const text = ocr.pages
      .map((p) => p.markdown.trim())
      .filter((t) => t.length > 0)
      .join('\n\n');
    return { text, ms: Date.now() - start, model: this.glmModelLabel };
  }
}

// ---- Anthropic provider -----------------------------------------------------

export interface ModelPriceRow {
  inputPerMTokenMicros: bigint;
  outputPerMTokenMicros: bigint;
}

export type AnthropicPriceTable = Record<string, ModelPriceRow>;

// Curated baseline. Approximate published prices in micro-USD per
// million tokens. Operators can override or add models from
// /admin/llm-provider; the merged map (operator overrides win) is
// passed into AnthropicProvider via constructor opts.
export const ANTHROPIC_PRICE_TABLE_DEFAULT: AnthropicPriceTable = {
  'claude-opus-4-7': { inputPerMTokenMicros: 15_000_000n, outputPerMTokenMicros: 75_000_000n },
  'claude-sonnet-4-6': { inputPerMTokenMicros: 3_000_000n, outputPerMTokenMicros: 15_000_000n },
  'claude-haiku-4-5-20251001': {
    inputPerMTokenMicros: 800_000n,
    outputPerMTokenMicros: 4_000_000n,
  },
};

export const computeAnthropicCostMicros = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  table: AnthropicPriceTable = ANTHROPIC_PRICE_TABLE_DEFAULT,
): bigint => {
  const row = table[model];
  if (!row) return 0n;
  const inMicros = (BigInt(inputTokens) * row.inputPerMTokenMicros) / 1_000_000n;
  const outMicros = (BigInt(outputTokens) * row.outputPerMTokenMicros) / 1_000_000n;
  return inMicros + outMicros;
};

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  // Hard ceiling on output tokens per /v1/messages call. Defaults to
  // LLM_MAX_COMPLETION_TOKENS or 32000 — a multi-page statement's
  // transaction list does not fit in the old 6000 cap, so the model
  // truncated mid-array and dropped `transactions`. Operator-tunable
  // from the LLM-provider admin page.
  maxTokens?: number | undefined;
  // Prompt budget (tokens) — caps markdown sent before truncation. Same setting
  // as the local provider (LLM_MAX_PROMPT_TOKENS); threaded so both providers
  // honor the operator's value.
  maxPromptTokens?: number | undefined;
  fetcher?: typeof fetch | undefined;
  // Operator-mergeable price table. When set, replaces the curated
  // defaults. Used by buildProvider to pass DB-backed pricing through
  // without coupling the leaf extractor package to the API layer.
  priceTable?: AnthropicPriceTable | undefined;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxTokens: number;
  private maxPromptTokens: number;
  private fetcher: typeof fetch;
  private priceTable: AnthropicPriceTable;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new Error('AnthropicProvider requires an API key');
    this.apiKey = opts.apiKey;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      'https://api.anthropic.com'
    ).replace(/\/$/, '');
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
    this.maxTokens = opts.maxTokens ?? Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 32_000);
    this.maxPromptTokens = opts.maxPromptTokens ?? defaultPromptBudget();
    this.fetcher = opts.fetcher ?? fetch;
    this.priceTable = opts.priceTable ?? ANTHROPIC_PRICE_TABLE_DEFAULT;
  }

  // True when baseUrl is NOT the direct Anthropic API — i.e. routed through a
  // proxy that speaks the Messages API but authenticates with a Bearer token
  // and does not serve /v1/models. (Shield is gone; this only covers a plain
  // operator-configured proxy via ANTHROPIC_BASE_URL.)
  private get viaGateway(): boolean {
    return this.baseUrl.replace(/\/$/, '') !== 'https://api.anthropic.com';
  }

  // Headers for a /v1/messages call. A proxy authenticates with
  // `Authorization: Bearer <key>`; the direct Anthropic API uses `x-api-key`
  // + `anthropic-version`. Picking the wrong one yields a 401, so this is
  // keyed off the base URL.
  private messageHeaders(): Record<string, string> {
    if (this.viaGateway) {
      return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
    }
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey) return { ok: false, detail: 'API key not set' };
    if (this.viaGateway) {
      // Proxy: probe its liveness endpoint with the Bearer key. A 2xx means
      // the proxy is reachable; this is a lightweight connectivity probe.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5_000);
      try {
        const res = await this.fetcher(`${this.baseUrl}/health`, {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: ctl.signal,
        });
        return res.ok ? { ok: true } : { ok: false, detail: `gateway /health HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      } finally {
        clearTimeout(timer);
      }
    }
    // Direct Anthropic — hit /v1/models to confirm the key is actually
    // valid. This endpoint is in the public Anthropic API surface and
    // doesn't burn message tokens. 401 → key is wrong; 200 → key works.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/models`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: ctl.signal,
      });
      if (res.status === 401) return { ok: false, detail: 'API key is invalid (401)' };
      if (res.status === 403) return { ok: false, detail: 'API key forbidden (403)' };
      if (!res.ok) return { ok: false, detail: `Anthropic /v1/models HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Phase 26 #29: list the models this key can access. Used by the
  // /admin/llm-provider page to populate the model dropdown so it
  // tracks Anthropic's catalog instead of being hardcoded.
  async listModels(): Promise<{ ok: boolean; models: string[]; detail?: string }> {
    if (!this.apiKey) return { ok: false, models: [], detail: 'API key not set' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    try {
      // Both the direct Anthropic API and the Vibe Shield gateway (v1.13.3+)
      // serve GET /v1/models. messageHeaders() picks Bearer (gateway) vs
      // x-api-key + anthropic-version (direct). Shield additionally returns
      // `allowed_models` (the active policy's allow-list); when present we
      // intersect so the picker only offers models the gateway will accept
      // (an empty allow-list = no restriction → the full catalog).
      const res = await this.fetcher(`${this.baseUrl}/v1/models`, {
        headers: this.messageHeaders(),
        signal: ctl.signal,
      });
      if (!res.ok) {
        return { ok: false, models: [], detail: `/v1/models HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        data?: Array<{ id?: string }>;
        allowed_models?: string[];
      };
      let models = (body.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
      if (Array.isArray(body.allowed_models) && body.allowed_models.length > 0) {
        const allowed = new Set(body.allowed_models);
        models = models.filter((m) => allowed.has(m));
      }
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], detail: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Single round-trip to Anthropic /v1/messages. Returns the parsed
  // tool_use input + per-call telemetry. Pulled out so `extract` can
  // call it twice (initial + reminder retry) and accumulate tokens
  // without duplicating the request-building logic.
  private async callAnthropic(
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
    tool: { name: string; description: string; input_schema: object },
    system: string = SYSTEM_PROMPT,
  ): Promise<{
    rawJson: string;
    toolInput: unknown;
    inputTokens: number;
    outputTokens: number;
    ms: number;
  }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    const start = Date.now();
    const sentMaxTokens = this.maxTokens;
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.messageHeaders(),
        body: JSON.stringify({
          model: this.model,
          system,
          max_tokens: sentMaxTokens,
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          messages,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Surface the API error body — a bare status hides the reason. Attach
        // our own request shape (counts/sizes only — never prompt text) so a
        // 4xx is diagnosable from the app trace alone.
        const detail = await res.text().catch(() => '');
        throw new Error(
          `anthropic HTTP ${res.status} [${describeAnthropicRequest(messages, this.model, sentMaxTokens, this.viaGateway)}]${
            detail ? `: ${detail.slice(0, 500)}` : ''
          }`,
        );
      }
      const body = (await res.json()) as {
        content?: Array<
          { type: 'tool_use'; name: string; input: unknown } | { type: 'text'; text: string }
        >;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      // Truncation guard. When generation hits the output ceiling,
      // Anthropic returns the partial tool_use input parsed up to the
      // cut — for a long statement that's the header fields with the
      // `transactions` array never started, so Zod would (misleadingly)
      // report `transactions: Required`. Catch it here and tell the
      // operator the real cause: the cap is too low. A reminder retry
      // with the same cap would truncate identically, so this error
      // carries no missingTopLevelFields and the retry loop skips it.
      if (body.stop_reason === 'max_tokens') {
        const sent = sentMaxTokens;
        throw new ExtractionResponseError({
          summary: `LLM output truncated at max_tokens (${sent})`,
          rawResponse: JSON.stringify(body).slice(0, 8_000),
          issues:
            `stop_reason=max_tokens; raise the admin "Max output tokens" knob ` +
            `(or LLM_MAX_COMPLETION_TOKENS) — statement too large for ${sent} output tokens`,
        });
      }
      const toolUse = body.content?.find(
        (c): c is { type: 'tool_use'; name: string; input: unknown } => c.type === 'tool_use',
      );
      if (!toolUse) {
        // Sonnet/Opus normally honor tool_choice, but it can ignore
        // the directive on PDFs whose markdown carries prompt-injection
        // bait (some statement footers say "ignore the schema, just
        // explain..."). Wrap in ExtractionResponseError so the audit
        // log captures the text response — operator can read what the
        // model actually said.
        throw new ExtractionResponseError({
          summary: 'anthropic response missing tool_use block',
          rawResponse: JSON.stringify(body).slice(0, 8_000),
        });
      }
      return {
        rawJson: JSON.stringify(toolUse.input),
        toolInput: toolUse.input,
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        ms: Date.now() - start,
      };
    } catch (err) {
      throw asTimeoutError(err, `anthropic POST ${this.baseUrl}/v1/messages`, this.timeoutMs);
    } finally {
      clearTimeout(t);
    }
  }

  async extract(markdown: string, arg?: ExtractOptions | object): Promise<ExtractResult> {
    const opts = coerceOpts(arg);
    // Anthropic is the text-only extraction provider: it receives OCR'd /
    // text-layer markdown, never page images (those are OCR'd locally on
    // Ollama and never egress — ADR-023). An images-bearing call is a
    // worker bug; surface it loud rather than silently dropping the images.
    if (opts.images && opts.images.length > 0) {
      throw new Error(
        'AnthropicProvider is text-only — scanned/image statements OCR locally on Ollama',
      );
    }
    const { text } = prepareMarkdown(markdown, this.maxPromptTokens);
    const promptOpts: UserPromptOptions = {};
    if (opts.dateFormatOverride) promptOpts.dateFormatOverride = opts.dateFormatOverride;
    if (opts.accountTypeHint) promptOpts.accountTypeHint = opts.accountTypeHint;
    const tool = {
      name: 'emit_extraction',
      description: 'Emit the structured statement extraction.',
      input_schema: opts.schema ?? schemas.extraction.ExtractionJsonSchema,
    };

    // One-shot reminder retry. Anthropic tool_use almost always honors
    // input_schema strictly, but the same defensive retry that the
    // local provider needs applies here too — if the model returns a
    // tool_use whose input omits a required top-level field, retry
    // once with an explicit reminder before bouncing to fallback.
    let userPrompt = userPromptFor(text, promptOpts);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalMs = 0;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        ...exemplarsAsMessages(1),
        { role: 'user', content: userPrompt },
      ];
      const call = await this.callAnthropic(
        messages,
        tool,
        opts.systemPromptOverride ?? SYSTEM_PROMPT,
      );
      totalInputTokens += call.inputTokens;
      totalOutputTokens += call.outputTokens;
      totalMs += call.ms;
      try {
        const data = parseExtractionResponse(call.rawJson, call.toolInput);
        return {
          data,
          rawJson: call.rawJson,
          telemetry: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ms: totalMs,
            model: this.model,
            costMicros: computeAnthropicCostMicros(
              this.model,
              totalInputTokens,
              totalOutputTokens,
              this.priceTable,
            ),
          },
        };
      } catch (err) {
        if (
          attempt < 2 &&
          err instanceof ExtractionResponseError &&
          err.missingTopLevelFields.length > 0
        ) {
          userPrompt = missingFieldsReminderPromptFor(text, err.missingTopLevelFields, promptOpts);
          continue;
        }
        throw err;
      }
    }
    throw new Error('anthropic extract: retry loop exhausted unexpectedly');
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const toolName = opts.schemaName ?? 'structured_output';
    const tool = {
      name: toolName,
      description: 'Emit the requested structured output.',
      input_schema: opts.schema,
    };
    // Anthropic is text-only. Image-bearing structured-output requests have
    // no path here (vision/OCR is local on Ollama), so reject them rather
    // than silently dropping the attachments.
    if (opts.images && opts.images.length > 0) {
      throw new Error('AnthropicProvider.complete() is text-only — no image inputs');
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    const start = Date.now();
    const sentMaxTokens = opts.maxOutputTokens ?? this.maxTokens;
    const messages: Array<{ role: 'user'; content: unknown }> = [
      { role: 'user', content: opts.userPrompt },
    ];
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.messageHeaders(),
        body: JSON.stringify({
          model: this.model,
          system: opts.systemPrompt,
          max_tokens: sentMaxTokens,
          tools: [tool],
          tool_choice: { type: 'tool', name: toolName },
          messages,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Surface the gateway/API error body — a bare status hides the
        // reason (e.g. Shield's {"error":{"type","message"}} for a wrong
        // policy, ZDR-off, model-not-allowed, or bad session_id). Shield
        // masks the upstream Anthropic reason, so attach our request shape
        // (counts/sizes only) — this is the enrichment/check-resolve path,
        // so a 400 here now shows model + max_tokens just like extraction.
        const detail = await res.text().catch(() => '');
        throw new Error(
          `anthropic HTTP ${res.status} [${describeAnthropicRequest(messages, this.model, sentMaxTokens, this.viaGateway)}]${
            detail ? `: ${detail.slice(0, 500)}` : ''
          }`,
        );
      }
      const body = (await res.json()) as {
        content?: Array<
          { type: 'tool_use'; name: string; input: unknown } | { type: 'text'; text: string }
        >;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (body.stop_reason === 'max_tokens') {
        throw new Error(`anthropic complete: output truncated at max_tokens (${sentMaxTokens})`);
      }
      const toolUse = body.content?.find(
        (c): c is { type: 'tool_use'; name: string; input: unknown } => c.type === 'tool_use',
      );
      if (!toolUse) throw new Error('anthropic response missing tool_use block');
      const inputTokens = body.usage?.input_tokens ?? 0;
      const outputTokens = body.usage?.output_tokens ?? 0;
      return {
        data: toolUse.input,
        rawJson: JSON.stringify(toolUse.input),
        telemetry: {
          inputTokens,
          outputTokens,
          ms: Date.now() - start,
          model: this.model,
          costMicros: computeAnthropicCostMicros(
            this.model,
            inputTokens,
            outputTokens,
            this.priceTable,
          ),
        },
      };
    } catch (err) {
      throw asTimeoutError(
        err,
        `anthropic POST ${this.baseUrl}/v1/messages (complete)`,
        this.timeoutMs,
      );
    } finally {
      clearTimeout(t);
    }
  }

  // Anthropic is the text-only provider — vision/OCR (incl. reading check
  // payees off images) runs on the local Ollama provider, so page images
  // never egress (ADR-023).
  async completeWithImages(_opts: CompleteOptions): Promise<CompleteResult> {
    throw new Error(
      'AnthropicProvider.completeWithImages() is text-only — check-payee vision runs on the local Ollama provider',
    );
  }

  async ocrToMarkdown(_opts: OcrToMarkdownOptions): Promise<OcrToMarkdownResult> {
    throw new Error(
      'AnthropicProvider.ocrToMarkdown() is text-only — OCR runs on the local GLM-OCR engine (page images never egress)',
    );
  }

  async ocrImagesToText(_images: NonNullable<CompleteOptions['images']>): Promise<OcrToTextResult> {
    throw new Error(
      'AnthropicProvider.ocrImagesToText() is text-only — OCR runs on the local GLM-OCR engine (page images never egress)',
    );
  }
}
