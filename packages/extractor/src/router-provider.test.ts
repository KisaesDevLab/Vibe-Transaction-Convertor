// MIG-6 — RouterProvider wire contract, same injected-fetcher style as
// llm-client.test.ts (no mocks, hand-built Responses).
import { describe, expect, it } from 'vitest';

import {
  RouterProvider,
  TXCONV_TASK_CLASSES,
  registerTxconvTaskClasses,
} from './router-provider.js';

const BASE = { baseUrl: 'http://router.test:8220', token: 'tok' };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const capturingFetcher = (respond: () => Response) => {
  const calls: Captured[] = [];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return respond();
  }) as typeof fetch;
  return { calls, fetcher };
};

const completion = (content: string, finish = 'stop'): Response =>
  new Response(
    JSON.stringify({
      model: 'ollama/qwen2.5:32b-instruct',
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'r1' } },
  );

const EXTRACTION_JSON = JSON.stringify({
  bankName: 'Test Bank',
  accountNumberMasked: null,
  accountType: 'checking',
  period: { start: '2026-01-01', end: '2026-01-31' },
  openingBalance: 100,
  closingBalance: 90,
  transactions: [
    { date: '2026-01-05', description: 'COFFEE', amount: -10, balance: 90, type: 'debit' },
  ],
});

describe('RouterProvider.complete', () => {
  it('sends task-class header + json_schema response_format, never a model', async () => {
    const { calls, fetcher } = capturingFetcher(() => completion('{"payee":"ACME"}'));
    const p = new RouterProvider({
      ...BASE,
      taskClass: TXCONV_TASK_CLASSES.CHECK_RESOLVE,
      fetcher,
    });
    const res = await p.complete({
      systemPrompt: 'parse the check',
      userPrompt: 'CHECK #123 PAY TO ACME',
      schema: { type: 'object', properties: { payee: { type: 'string' } } },
      schemaName: 'emit_checks',
      maxOutputTokens: 4096,
    });

    expect(calls[0]!.url).toBe('http://router.test:8220/v1/chat/completions');
    expect(calls[0]!.headers['x-vibe-task-class']).toBe('txconv_check_resolve');
    expect(calls[0]!.body.model).toBeUndefined();
    expect(calls[0]!.body.max_tokens).toBe(4096);
    const rf = calls[0]!.body.response_format as { type: string; json_schema: { name: string } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('emit_checks');

    expect(res.data).toEqual({ payee: 'ACME' });
    expect(res.telemetry.inputTokens).toBe(100);
    expect(res.telemetry.model).toBe('ollama/qwen2.5:32b-instruct');
    expect(res.telemetry.costMicros).toBe(0n); // router ledger owns cost
  });

  it('accepts a forced-tool answer shape and strips markdown fences', async () => {
    const { fetcher } = capturingFetcher(() => completion('```json\n{"ok":true}\n```'));
    const p = new RouterProvider({ ...BASE, taskClass: 'txconv_enrichment', fetcher });
    const res = await p.complete({
      systemPrompt: 's',
      userPrompt: 'u',
      schema: { type: 'object' },
    });
    expect(res.data).toEqual({ ok: true });
  });

  it('throws on truncation and on image inputs (vision stays local)', async () => {
    const { fetcher } = capturingFetcher(() => completion('{"x":1}', 'length'));
    const p = new RouterProvider({ ...BASE, taskClass: 'txconv_enrichment', fetcher });
    await expect(
      p.complete({ systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' } }),
    ).rejects.toThrow(/truncated at max_tokens/);
    await expect(
      p.complete({
        systemPrompt: 's',
        userPrompt: 'u',
        schema: { type: 'object' },
        images: [{ data: Buffer.from('x'), mediaType: 'image/png' }],
      }),
    ).rejects.toThrow(/text-only/);
  });

  it('router errors carry the code — and never fall back', async () => {
    const { fetcher } = capturingFetcher(
      () =>
        new Response(JSON.stringify({ error: { code: 'policy_blocked', message: 'no policy' } }), {
          status: 403,
        }),
    );
    const p = new RouterProvider({ ...BASE, taskClass: 'txconv_statement_parse', fetcher });
    await expect(
      p.complete({ systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' } }),
    ).rejects.toThrow(/Vibe AI Router: no policy \(policy_blocked\)/);
  });
});

describe('RouterProvider.extract', () => {
  it('runs the standard extraction prompt flow through the router', async () => {
    const { calls, fetcher } = capturingFetcher(() => completion(EXTRACTION_JSON));
    const p = new RouterProvider({
      ...BASE,
      taskClass: TXCONV_TASK_CLASSES.STATEMENT_PARSE,
      fetcher,
    });
    const res = await p.extract('| date | description | amount |\n| 01/05 | COFFEE | -10.00 |');

    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages.length).toBeGreaterThanOrEqual(3); // system + exemplar pair + user
    expect(calls[0]!.headers['x-vibe-task-class']).toBe('txconv_statement_parse');

    const data = res.data as { transactions: unknown[] };
    expect(data.transactions).toHaveLength(1);
    expect(res.telemetry.costMicros).toBe(0n);
  });

  it('rejects image-bearing extract calls (OCR stays local)', async () => {
    const { fetcher } = capturingFetcher(() => completion(EXTRACTION_JSON));
    const p = new RouterProvider({ ...BASE, taskClass: 'txconv_statement_parse', fetcher });
    await expect(
      p.extract('md', { images: [{ data: Buffer.from('x'), mediaType: 'image/png' }] }),
    ).rejects.toThrow(/text-only/);
  });
});

describe('vision/OCR surfaces', () => {
  it('throw by design — page images never egress in either mode', async () => {
    const { fetcher } = capturingFetcher(() => completion('{}'));
    const p = new RouterProvider({ ...BASE, taskClass: 'txconv_statement_parse', fetcher });
    await expect(
      p.completeWithImages({ systemPrompt: 's', userPrompt: 'u', schema: {} }),
    ).rejects.toThrow(/local provider/);
    await expect(
      p.ocrToMarkdown({
        images: [{ data: Buffer.from('x'), mediaType: 'image/png' }],
        systemPrompt: 's',
        userPrompt: 'u',
      }),
    ).rejects.toThrow(/GLM-OCR/);
    await expect(
      p.ocrImagesToText([{ data: Buffer.from('x'), mediaType: 'image/png' }]),
    ).rejects.toThrow(/GLM-OCR/);
  });
});

describe('registerTxconvTaskClasses', () => {
  it('declares the three classes with the pack-matching shapes', async () => {
    const { calls, fetcher } = capturingFetcher(
      () => new Response(JSON.stringify({ registered: [] }), { status: 200 }),
    );
    registerTxconvTaskClasses({ ...BASE, fetcher, maxAttempts: 1, log: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0]!.url).toContain('/v1/task-classes/register');
    expect(calls[0]!.body.app).toBe('vibe-tx-converter');
    const classes = calls[0]!.body.classes as Array<{
      key: string;
      requires: { json_schema?: boolean };
    }>;
    expect(classes.map((c) => c.key).sort()).toEqual([
      'txconv_check_resolve',
      'txconv_enrichment',
      'txconv_statement_parse',
    ]);
    for (const c of classes) expect(c.requires.json_schema).toBe(true);
  });
});
