// LLM provider abstraction (ADR-019, ADR-020). Two implementations,
// shared contract — downstream code never branches on provider.

import { schemas } from '@vibe-tx-converter/shared';
import {
  SYSTEM_PROMPT,
  cleanupMarkdown,
  estimateTokens,
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
// the cleaned text plus the token count for telemetry.
export const prepareMarkdown = (
  raw: string,
  budget: number = defaultPromptBudget(),
): { text: string; tokens: number; truncated: boolean } => {
  const cleaned = cleanupMarkdown(raw);
  const allowed = Math.max(1_000, budget - PROMPT_BUDGET_RESERVE);
  const tokens = estimateTokens(cleaned);
  if (tokens <= allowed) return { text: cleaned, tokens, truncated: false };
  // Truncate from the end — opening balance + early-period rows are higher
  // priority than the trailing footer / disclosures.
  const charBudget = allowed * 4;
  const truncated = cleaned.slice(0, charBudget);
  return { text: truncated, tokens: estimateTokens(truncated), truncated: true };
};

const { ExtractionResult } = schemas.extraction;
type ExtractionResult = schemas.extraction.ExtractionResult;

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

  async extract(markdown: string, arg?: ExtractOptions | object): Promise<ExtractResult> {
    if (!this.baseUrl) throw new Error('LLM_GATEWAY_URL not set');
    const opts = coerceOpts(arg);
    const { text } = prepareMarkdown(markdown);
    const promptOpts: UserPromptOptions = {};
    if (opts.dateFormatOverride) promptOpts.dateFormatOverride = opts.dateFormatOverride;
    if (opts.accountTypeHint) promptOpts.accountTypeHint = opts.accountTypeHint;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...exemplarsAsMessages(),
      { role: 'user', content: userPromptFor(text, promptOpts) },
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
          response_format: opts.schema
            ? { type: 'json_schema', json_schema: { name: 'extraction', schema: opts.schema } }
            : { type: 'json_object' },
          temperature: 0,
          max_tokens: Number(process.env.LLM_MAX_COMPLETION_TOKENS ?? 6000),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`local gateway HTTP ${res.status}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      const data = ExtractionResult.parse(JSON.parse(content));
      return {
        data,
        rawJson: content,
        telemetry: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          ms: Date.now() - start,
          model: this.modelId,
          costMicros: 0n, // local gateway is free
        },
      };
    } finally {
      clearTimeout(t);
    }
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    if (!this.baseUrl) throw new Error('LLM_GATEWAY_URL not set');
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
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
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
    this.fetcher = opts.fetcher ?? fetch;
    this.priceTable = opts.priceTable ?? ANTHROPIC_PRICE_TABLE_DEFAULT;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey) return { ok: false, detail: 'ANTHROPIC_API_KEY not set' };
    // Hit /v1/models to confirm the key is actually valid. This endpoint
    // is in the public Anthropic API surface and doesn't burn message
    // tokens — it returns the list of models the key can use.
    // 401 → key is wrong; 200 → key works. 5s timeout.
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
    if (!this.apiKey) return { ok: false, models: [], detail: 'ANTHROPIC_API_KEY not set' };
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
          tool_choice: { type: 'tool', name: 'emit_extraction' },
          messages: [
            ...exemplarsAsMessages(1),
            { role: 'user', content: userPromptFor(text, promptOpts) },
          ],
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
      const data = ExtractionResult.parse(toolUse.input);
      const inputTokens = body.usage?.input_tokens ?? 0;
      const outputTokens = body.usage?.output_tokens ?? 0;
      return {
        data,
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
    } finally {
      clearTimeout(t);
    }
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const toolName = opts.schemaName ?? 'structured_output';
    const tool = {
      name: toolName,
      description: 'Emit the requested structured output.',
      input_schema: opts.schema,
    };
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
          messages: [{ role: 'user', content: opts.userPrompt }],
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
    } finally {
      clearTimeout(t);
    }
  }
}
