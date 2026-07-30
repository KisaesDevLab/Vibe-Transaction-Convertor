// MIG-6 (router-option addendum, Q-063/Q-064) — Vibe AI Router provider.
//
// When VIBE_AI_MODE=router, the API's provider factory returns this class for
// the policy-driven text paths (extraction, enrichment, check text-parse):
// the app stops choosing providers and models — the task class is the only
// knob, and router policy decides model, fallback, budgets, scrubbing, and
// cost. The forced-local vision/OCR paths (GLM-OCR page transcription,
// check-image reads) stay on the direct local provider in BOTH modes: page
// images never leave the box (ADR-023/ADR-025), so there is no boundary for
// the router to enforce there.
//
// NO silent cross-mode fallback: a router outage surfaces as a failed
// extraction/enrichment (the worker's existing error handling applies).

import { VibeAiClient, VibeAiError, type ChatMessage } from '@kisaes/vibe-ai-client';
import { schemas } from '@vibe-tx-converter/shared';
import {
  ExtractionResponseError,
  parseExtractionResponse,
  prepareMarkdown,
  type CompleteOptions,
  type CompleteResult,
  type ExtractOptions,
  type ExtractResult,
  type LlmProvider,
  type OcrToMarkdownOptions,
  type OcrToMarkdownResult,
  type OcrToTextResult,
} from './llm-client.js';
import {
  SYSTEM_PROMPT,
  amountReminderPromptFor,
  missingFieldsReminderPromptFor,
  userPromptFor,
  type UserPromptOptions,
} from './prompts/extract.js';
import { exemplarsAsMessages } from './exemplars.js';

export const TXCONV_TASK_CLASSES = {
  /** Statement markdown → structured extraction (default pack, local_only) */
  STATEMENT_PARSE: 'txconv_statement_parse',
  /** Transaction cleanse + categorization passes (NEW — starts local_only) */
  ENRICHMENT: 'txconv_enrichment',
  /** Check payee text-parse over OCR transcriptions (NEW — starts local_only) */
  CHECK_RESOLVE: 'txconv_check_resolve',
} as const;

export interface RouterProviderOptions {
  /** e.g. http://vibe-ai-router:8220 (internal docker DNS on the appliance) */
  baseUrl: string;
  /** app token minted in the router console — never a provider key */
  token: string;
  /** task class attributed to every call from this instance */
  taskClass: string;
  maxTokens?: number | undefined;
  maxPromptTokens?: number | undefined;
  temperature?: number | undefined;
  fetcher?: typeof fetch | undefined;
}

const stripFences = (raw: string): string =>
  raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

export class RouterProvider implements LlmProvider {
  readonly id = 'vibe_router' as const;
  private readonly client: VibeAiClient;
  private readonly taskClass: string;
  private readonly maxTokens: number;
  private readonly maxPromptTokens: number | undefined;
  private readonly temperature: number | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(opts: RouterProviderOptions) {
    if (!opts.baseUrl || !opts.token) {
      throw new Error('RouterProvider: baseUrl and token are required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetcher = opts.fetcher ?? fetch;
    this.client = new VibeAiClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      ...(opts.fetcher ? { fetch: opts.fetcher } : {}),
    });
    this.taskClass = opts.taskClass;
    this.maxTokens = opts.maxTokens ?? 32_000;
    this.maxPromptTokens = opts.maxPromptTokens;
    this.temperature = opts.temperature;
  }

  private async completeJson(
    messages: ChatMessage[],
    schemaName: string,
    schema: object,
    maxTokens: number,
  ): Promise<{
    rawJson: string;
    data: unknown;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }> {
    try {
      const result = await this.client.complete(this.taskClass, messages, {
        maxTokens,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        responseFormat: { type: 'json_schema', name: schemaName, schema },
      });
      if (result.finishReason === 'length') {
        throw new Error(`vibe-router ${schemaName}: output truncated at max_tokens (${maxTokens})`);
      }
      // Some backends answer a forced-JSON request with a tool call instead
      // of content (the router's Anthropic adapter maps json_schema to a
      // forced tool) — accept both shapes.
      const raw =
        result.content.trim() !== '' ? result.content : (result.toolCalls[0]?.arguments ?? '');
      const rawJson = stripFences(raw);
      let data: unknown;
      try {
        data = JSON.parse(rawJson);
      } catch {
        throw new Error(`vibe-router ${schemaName}: response was not valid JSON`);
      }
      return {
        rawJson,
        data,
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        model: result.model,
      };
    } catch (err) {
      if (err instanceof VibeAiError) {
        throw new Error(`Vibe AI Router: ${err.message} (${err.code})`);
      }
      throw err;
    }
  }

  async extract(markdown: string, arg?: ExtractOptions | object): Promise<ExtractResult> {
    // Same coercion heuristic as the other providers (bare-schema second arg).
    const a = (arg ?? {}) as Record<string, unknown>;
    const isSchema =
      arg !== undefined &&
      ('type' in a || '$schema' in a || 'properties' in a) &&
      !('schema' in a) &&
      !('dateFormatOverride' in a) &&
      !('accountTypeHint' in a);
    const opts: ExtractOptions = isSchema
      ? { schema: arg as object }
      : ((arg ?? {}) as ExtractOptions);

    if (opts.images && opts.images.length > 0) {
      throw new Error(
        'RouterProvider is text-only — scanned/image statements OCR locally (page images never egress)',
      );
    }
    const { text } = prepareMarkdown(markdown, this.maxPromptTokens);
    const promptOpts: UserPromptOptions = {};
    if (opts.dateFormatOverride) promptOpts.dateFormatOverride = opts.dateFormatOverride;
    if (opts.accountTypeHint) promptOpts.accountTypeHint = opts.accountTypeHint;
    const schema = (opts.schema ?? schemas.extraction.ExtractionJsonSchema) as object;

    // Same one-shot reminder retry the direct providers use.
    let userPrompt = userPromptFor(text, promptOpts);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const startedAt = Date.now();
    let model = 'vibe-router';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages: ChatMessage[] = [
        { role: 'system', content: opts.systemPromptOverride ?? SYSTEM_PROMPT },
        ...exemplarsAsMessages(1),
        { role: 'user', content: userPrompt },
      ];
      const call = await this.completeJson(messages, 'emit_extraction', schema, this.maxTokens);
      totalInputTokens += call.inputTokens;
      totalOutputTokens += call.outputTokens;
      model = call.model;
      try {
        const data = parseExtractionResponse(call.rawJson, call.data, {
          salvageAmounts: attempt === 2,
        });
        return {
          data,
          rawJson: call.rawJson,
          telemetry: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            ms: Date.now() - startedAt,
            model,
            // Cost accounting lives in the router ledger in router mode.
            costMicros: 0n,
          },
        };
      } catch (err) {
        if (attempt < 2 && err instanceof ExtractionResponseError) {
          if (err.missingTopLevelFields.length > 0) {
            userPrompt = missingFieldsReminderPromptFor(
              text,
              err.missingTopLevelFields,
              promptOpts,
            );
            continue;
          }
          if (err.nullAmountRows > 0) {
            userPrompt = amountReminderPromptFor(text, err.nullAmountRows, promptOpts);
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error('vibe-router extract: retry loop exhausted unexpectedly');
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    if (opts.images && opts.images.length > 0) {
      throw new Error('RouterProvider.complete() is text-only — vision runs on the local provider');
    }
    const schemaName = opts.schemaName ?? 'structured_output';
    const messages: ChatMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ];
    const started = Date.now();
    const call = await this.completeJson(
      messages,
      schemaName,
      opts.schema,
      opts.maxOutputTokens ?? this.maxTokens,
    );
    return {
      data: call.data,
      rawJson: call.rawJson,
      telemetry: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        ms: Date.now() - started,
        model: call.model,
        costMicros: 0n,
      },
    };
  }

  // Vision/OCR surfaces are local-only in BOTH modes — page and check images
  // never egress (ADR-023/ADR-025), so these run on the direct local provider.
  async completeWithImages(_opts: CompleteOptions): Promise<CompleteResult> {
    throw new Error(
      'RouterProvider.completeWithImages() — check-payee vision runs on the local provider',
    );
  }

  async ocrToMarkdown(_opts: OcrToMarkdownOptions): Promise<OcrToMarkdownResult> {
    throw new Error('RouterProvider.ocrToMarkdown() — OCR runs on the local GLM-OCR engine');
  }

  async ocrImagesToText(_images: NonNullable<CompleteOptions['images']>): Promise<OcrToTextResult> {
    throw new Error('RouterProvider.ocrImagesToText() — OCR runs on the local GLM-OCR engine');
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Declare this app's task classes on the router (idempotent). Called by the
 * API at boot in router mode; non-blocking with backoff — requests made
 * before registration completes fail closed at the router, which is correct.
 */
export function registerTxconvTaskClasses(o: {
  baseUrl: string;
  token: string;
  version?: string | undefined;
  fetcher?: typeof fetch | undefined;
  maxAttempts?: number | undefined;
  log?: ((level: 'info' | 'warn' | 'error', msg: string) => void) | undefined;
}): void {
  const log =
    o.log ?? ((level, msg) => console[level === 'info' ? 'log' : level](`[vibe-router] ${msg}`));
  const client = new VibeAiClient({
    baseUrl: o.baseUrl,
    token: o.token,
    ...(o.fetcher ? { fetch: o.fetcher } : {}),
  });
  const maxAttempts = o.maxAttempts ?? 10;
  let attempt = 0;

  const tryRegister = async (): Promise<void> => {
    attempt++;
    try {
      await client.registerTaskClasses({
        app: 'vibe-tx-converter',
        version: o.version ?? 'unknown',
        classes: [
          // Pack class — declaration matches the reviewed pack entry.
          {
            key: TXCONV_TASK_CLASSES.STATEMENT_PARSE,
            description: 'Bank statement structure detection assistance',
            requires: { json_schema: true },
            defaultMaxTokens: 4096,
          },
          // New classes — start local_only until the operator widens them.
          {
            key: TXCONV_TASK_CLASSES.ENRICHMENT,
            description: 'Transaction cleanse + categorization passes over extracted statements',
            requires: { json_schema: true },
            defaultMaxTokens: 32768,
          },
          {
            key: TXCONV_TASK_CLASSES.CHECK_RESOLVE,
            description: 'Check payee resolution over locally-OCRed check transcriptions',
            requires: { json_schema: true },
            defaultMaxTokens: 4096,
          },
        ],
      });
      log('info', 'task classes registered');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        log(
          'error',
          `task-class registration failed after ${attempt} attempts: ${message}; AI paths fail closed until the router is reachable`,
        );
        return;
      }
      const delayMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      log(
        'warn',
        `registration attempt ${attempt} failed (${message}); retrying in ${Math.round(delayMs / 1000)}s`,
      );
      const timer = setTimeout(() => void tryRegister(), delayMs);
      timer.unref?.();
    }
  };

  void tryRegister();
}
