// LLM provider abstraction (ADR-019, ADR-020). Two implementations,
// shared contract — downstream code never branches on provider.

import { schemas } from '@vibe-tx-converter/shared';
import { SYSTEM_PROMPT, userPromptFor } from './prompts/extract.js';
import { exemplarsAsMessages } from './exemplars.js';

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

export interface LlmProvider {
  readonly id: 'local' | 'anthropic';
  extract(markdown: string, schema?: object): Promise<ExtractResult>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

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

  async extract(markdown: string, schema?: object): Promise<ExtractResult> {
    if (!this.baseUrl) throw new Error('LLM_GATEWAY_URL not set');
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...exemplarsAsMessages(),
      { role: 'user', content: userPromptFor(markdown) },
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
}

// ---- Anthropic provider -----------------------------------------------------

const ANTHROPIC_PRICE_TABLE: Record<
  string,
  { inputPerMTokenMicros: bigint; outputPerMTokenMicros: bigint }
> = {
  // Approximate published prices in micro-USD per million tokens.
  // The admin-settings page (Phase 26) will let operators override.
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
): bigint => {
  const row = ANTHROPIC_PRICE_TABLE[model];
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
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private fetcher: typeof fetch;

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
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    // No public health endpoint — treat presence of the API key as the
    // signal. A real "ping" would consume tokens, which is not worth it.
    return this.apiKey.length > 0
      ? { ok: true }
      : { ok: false, detail: 'ANTHROPIC_API_KEY not set' };
  }

  async extract(markdown: string, schema?: object): Promise<ExtractResult> {
    const tool = {
      name: 'emit_extraction',
      description: 'Emit the structured statement extraction.',
      input_schema: schema ?? schemas.extraction.ExtractionJsonSchema,
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
          messages: [...exemplarsAsMessages(1), { role: 'user', content: userPromptFor(markdown) }],
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
          costMicros: computeAnthropicCostMicros(this.model, inputTokens, outputTokens),
        },
      };
    } finally {
      clearTimeout(t);
    }
  }
}
