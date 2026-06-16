// LLM provider abstraction (ADR-019, ADR-020). Two implementations,
// shared contract — downstream code never branches on provider.

import { schemas } from '@vibe-tx-converter/shared';
import {
  SYSTEM_PROMPT,
  cleanupMarkdown,
  estimateTokens,
  missingFieldsReminderPromptFor,
  userPromptFor,
  type UserPromptOptions,
} from './prompts/extract.js';
import { exemplarsAsMessages } from './exemplars.js';

// Phase 12 item 11: prompt budget. The Vibe Gateway hosts Qwen3-8B with a
// 32K context, which after exemplars + system prompt + completion reserve
// leaves ~24K input tokens for the markdown. Operators can shrink this via
// LLM_MAX_PROMPT_TOKENS for cheaper providers.
const PROMPT_BUDGET_RESERVE = 4_000;
const defaultPromptBudget = (): number => Number(process.env.LLM_MAX_PROMPT_TOKENS ?? 24_000);

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

// Carve out the first { to last } and re-parse — recovers when the model
// wraps its JSON in prose. A false positive is impossible: any extra
// text inside the slice makes JSON.parse fail.
const recoverProseWrappedJson = (raw: string): unknown | undefined => {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return undefined;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return undefined;
  }
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
  // Vibe Shield: the per-conversion session id + policy to quote on this
  // call (passed through to the Anthropic provider; ignored by the local
  // gateway). Overrides any provider-level default.
  sessionId?: string | undefined;
  policyName?: string | undefined;
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
  // Vibe Shield: per-call session id + policy (Anthropic provider only).
  sessionId?: string | undefined;
  policyName?: string | undefined;
  // Optional image attachments for vision-capable providers. Each
  // becomes an Anthropic `{type:'image', source:{type:'base64',...}}`
  // content part placed BEFORE the text prompt in the user message,
  // matching Anthropic's recommended ordering. Local Qwen3-8B has no
  // vision support; LocalGatewayProvider.complete() throws if any
  // image is passed so callers don't silently lose data.
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

export interface LlmProvider {
  readonly id: 'local' | 'anthropic';
  extract(markdown: string, opts?: ExtractOptions | object): Promise<ExtractResult>;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
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

// ---- Local Vibe LLM Gateway (OpenAI-compatible) ----------------------------

export interface LocalGatewayProviderOptions {
  baseUrl?: string | undefined;
  modelId?: string | undefined;
  timeoutMs?: number | undefined;
  fetcher?: typeof fetch | undefined;
}

export class LocalGatewayProvider implements LlmProvider {
  readonly id = 'local' as const;
  private baseUrl: string;
  private modelId: string;
  private timeoutMs: number;
  private fetcher: typeof fetch;

  constructor(opts: LocalGatewayProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.LLM_GATEWAY_URL ?? '').replace(/\/$/, '');
    this.modelId = opts.modelId ?? process.env.LLM_MODEL_ID ?? 'qwen3-8b';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
    this.fetcher = opts.fetcher ?? fetch;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.baseUrl) return { ok: false, detail: 'LLM_GATEWAY_URL not set' };
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      try {
        const res = await this.fetcher(`${this.baseUrl}/health`, { signal: ctl.signal });
        return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
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
          response_format: schema
            ? { type: 'json_schema', json_schema: { name: 'extraction', schema } }
            : { type: 'json_object' },
          temperature: 0,
          max_tokens: Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`local gateway HTTP ${res.status}`);
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
  }

  async extract(markdown: string, arg?: ExtractOptions | object): Promise<ExtractResult> {
    if (!this.baseUrl) throw new Error('LLM_GATEWAY_URL not set');
    const opts = coerceOpts(arg);
    const { text } = prepareMarkdown(markdown);
    const promptOpts: UserPromptOptions = {};
    if (opts.dateFormatOverride) promptOpts.dateFormatOverride = opts.dateFormatOverride;
    if (opts.accountTypeHint) promptOpts.accountTypeHint = opts.accountTypeHint;

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
        { role: 'system', content: SYSTEM_PROMPT },
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
    if (!this.baseUrl) throw new Error('LLM_GATEWAY_URL not set');
    if (opts.images && opts.images.length > 0) {
      // Qwen3-8B has no vision input. Fail loud so the caller routes
      // image-bearing requests to Anthropic instead of silently losing
      // the attachments.
      throw new Error(
        'local gateway (Qwen3-8B) does not support image inputs — route vision calls to Anthropic',
      );
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
            json_schema: { name: opts.schemaName ?? 'structured_output', schema: opts.schema },
          },
          temperature: 0,
          max_tokens: opts.maxOutputTokens ?? Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`local gateway HTTP ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      return {
        data: JSON.parse(content),
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
  fetcher?: typeof fetch | undefined;
  // Operator-mergeable price table. When set, replaces the curated
  // defaults. Used by buildProvider to pass DB-backed pricing through
  // without coupling the leaf extractor package to the API layer.
  priceTable?: AnthropicPriceTable | undefined;
  // Vibe Shield extensions. When the provider points at a Shield gateway
  // (baseUrl), these attach the per-conversion session + redaction policy
  // to every /v1/messages call so the extractor's tokens share the same
  // vault as the OCR step. Anthropic ignores unknown fields, so they're
  // harmless when baseUrl points at api.anthropic.com directly.
  sessionId?: string | undefined;
  policyName?: string | undefined;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private fetcher: typeof fetch;
  private priceTable: AnthropicPriceTable;
  private sessionId: string | null;
  private policyName: string | null;

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
    this.fetcher = opts.fetcher ?? fetch;
    this.priceTable = opts.priceTable ?? ANTHROPIC_PRICE_TABLE_DEFAULT;
    this.sessionId = opts.sessionId && opts.sessionId.length > 0 ? opts.sessionId : null;
    this.policyName =
      opts.policyName && opts.policyName.length > 0
        ? opts.policyName
        : (process.env.VIBE_SHIELD_POLICY ?? null);
  }

  // Shield request extensions, spread into every /v1/messages body. The
  // session is per-call (each conversion has its own) so it must override
  // the constructor default — the worker caches providers by id, so a
  // constructor-baked session would leak across conversions. Empty object
  // in direct-Anthropic mode (no session/policy).
  private shieldFields(override?: {
    sessionId?: string | undefined;
    policyName?: string | undefined;
  }): Record<string, string> {
    const session = override?.sessionId ?? this.sessionId;
    // Only attach Shield extensions when a session is in play. A session
    // exists only when the request is bound for the Shield gateway, so
    // this also keeps `session_id`/`policy_name` off requests to the real
    // Anthropic API (which would reject the unknown fields). Shield's
    // policy is bound to the key's appId, but policy_name on /v1/messages
    // overrides the per-request policy — so we MUST send it explicitly,
    // else the gateway falls back to its default policy (reid='full'),
    // which would re-identify the response to cleartext at rest.
    if (!session) return {};
    return {
      session_id: session,
      policy_name: override?.policyName ?? this.policyName ?? 'cpa-converter-output',
    };
  }

  // True when baseUrl is NOT the direct Anthropic API — i.e. we're routed
  // through a gateway (the Vibe Shield gateway on this appliance), which
  // speaks the Messages API but does not serve /v1/models and authenticates
  // with a Bearer token instead of x-api-key.
  private get viaGateway(): boolean {
    return this.baseUrl.replace(/\/$/, '') !== 'https://api.anthropic.com';
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey) return { ok: false, detail: 'API key not set' };
    if (this.viaGateway) {
      // Gateway (e.g. Vibe Shield): probe its liveness endpoint with the
      // Bearer key. A 2xx means the gateway is reachable; the per-request
      // policy / ZDR / appId checks are validated by the Shield smoke test
      // (`pnpm shield:smoke`), not this lightweight connectivity probe.
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
    if (this.viaGateway) {
      // The Shield gateway doesn't expose /v1/models; the model picker
      // falls back to the curated list. Skip the doomed call.
      return { ok: false, models: [], detail: 'live catalog unavailable via gateway' };
    }
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
      if (!res.ok) {
        return { ok: false, models: [], detail: `Anthropic /v1/models HTTP ${res.status}` };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
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
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    tool: { name: string; description: string; input_schema: object },
    shield?: { sessionId?: string | undefined; policyName?: string | undefined },
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
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          system: SYSTEM_PROMPT,
          max_tokens: Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
          messages,
          ...this.shieldFields(shield),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const body = (await res.json()) as {
        content?: Array<
          { type: 'tool_use'; name: string; input: unknown } | { type: 'text'; text: string }
        >;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
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
    const { text } = prepareMarkdown(markdown);
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
    // local gateway needs applies here too — if the model returns a
    // tool_use whose input omits a required top-level field, retry
    // once with an explicit reminder before bouncing to fallback.
    let userPrompt = userPromptFor(text, promptOpts);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalMs = 0;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
        ...exemplarsAsMessages(1),
        { role: 'user', content: userPrompt },
      ];
      const call = await this.callAnthropic(messages, tool, {
        sessionId: opts.sessionId,
        policyName: opts.policyName,
      });
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
    // Build the user-message content. When images are supplied, the
    // recommended Anthropic ordering is images first, text last — the
    // text instructs the model on what to do with the preceding
    // images. Without images, the content is just the bare text
    // string (kept that way to match the older transcript shape).
    const userContent: unknown =
      opts.images && opts.images.length > 0
        ? [
            ...opts.images.map((img) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.data.toString('base64'),
              },
            })),
            { type: 'text', text: opts.userPrompt },
          ]
        : opts.userPrompt;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    const start = Date.now();
    try {
      const res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          system: opts.systemPrompt,
          max_tokens: opts.maxOutputTokens ?? Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
          tools: [tool],
          tool_choice: { type: 'tool', name: toolName },
          messages: [{ role: 'user', content: userContent }],
          ...this.shieldFields({ sessionId: opts.sessionId, policyName: opts.policyName }),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const body = (await res.json()) as {
        content?: Array<
          { type: 'tool_use'; name: string; input: unknown } | { type: 'text'; text: string }
        >;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
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
}
