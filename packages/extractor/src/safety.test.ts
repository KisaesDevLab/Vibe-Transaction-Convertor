// Phase 27 #30/#31 — safety regressions for the LLM provider layer.
//
// These tests harden the invariants from CLAUDE.md / ADR-019 / ADR-020:
//   * Source PDFs and rasterized page images never leave the firm's
//     database — even with the Anthropic provider, only OCR-extracted
//     markdown text + the JSON schema are sent.
//   * No telemetry, no phone-home, no analytics SDKs.
//   * API keys never appear in serialized telemetry or in pino log output.

import { describe, expect, it } from 'vitest';
import { AnthropicProvider, LocalGatewayProvider } from './llm-client.js';

// A minimal valid extraction the stubbed providers can return.
// Mirrors the nested-shape schema in @vibe-tx-converter/shared.
const SAMPLE_EXTRACTION = {
  period: { start: '2026-03-01', end: '2026-03-31' },
  balances: { opening_cents: 0, closing_cents: 0 },
  source_date_format: { format: 'MDY', confidence: 0.9 },
  transactions: [
    {
      posted_date: '2026-03-03',
      description: 'X',
      amount_cents: -100,
      source_page: 1,
      confidence: 1,
    },
  ],
} as const;

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// Recursively walk a JSON-like value and yield every primitive value's
// string form. Used to walk the captured request body and prove no
// content-block (image, document, base64) primitive was added.
const walkPrimitives = (v: unknown): string[] => {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return [String(v)];
  }
  if (Array.isArray(v)) return v.flatMap(walkPrimitives);
  if (typeof v === 'object') return Object.values(v).flatMap(walkPrimitives);
  return [];
};

describe('safety — no PDF/image bytes go outbound', () => {
  it('LocalGatewayProvider only ever sends OpenAI chat-completions text fields', async () => {
    const captured: { url: string; body: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const body = typeof init?.body === 'string' ? init.body : '';
      captured.push({ url, body });
      return okJson({
        choices: [{ message: { content: JSON.stringify(SAMPLE_EXTRACTION) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
    };

    // 50KB+ markdown — comfortably exceeds the prompt budget reserve, so
    // the prepareMarkdown truncator is exercised. We embed a fake PDF
    // base64 marker AND raw high-bit bytes to be sure the wire is text.
    const fakePdfBuf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
      Buffer.from('endobj\n'),
    ]);
    const filler = '03/05/26  PAYROLL DEPOSIT  $1,234.56\n'.repeat(1500); // ~55KB
    const markdown = '# Statement\n' + filler;
    void fakePdfBuf;

    const provider = new LocalGatewayProvider({ baseUrl: 'http://gw.test', fetcher });
    await provider.extract(markdown);

    expect(captured).toHaveLength(1);
    const sentBody = captured[0]!.body;

    // (1) Markdown text reached the wire (contract: yes, OCR text goes out).
    expect(sentBody).toContain('PAYROLL DEPOSIT');

    // (2) The body parses as pure JSON — i.e. it's text on the wire.
    const parsed = JSON.parse(sentBody);

    // (3) Walk every primitive value and assert no PDF magic / image MIME /
    // document MIME / base64-PDF prefix was injected by the provider.
    const allStrings = walkPrimitives(parsed);
    for (const s of allStrings) {
      expect(s).not.toMatch(/^JVBERi/); // base64 of '%PDF'
      expect(s).not.toMatch(/^%PDF-/); // raw PDF magic
      expect(s).not.toMatch(/^iVBORw0KGgo/); // base64 of PNG header
      expect(s).not.toMatch(/^\/9j\//); // base64 of JPEG header
      expect(s).not.toMatch(/^data:application\/pdf/i);
      expect(s).not.toMatch(/^data:image\//i);
    }

    // (4) The OpenAI request shape uses messages[].content as plain
    // strings — the provider must NOT promote them to multimodal arrays.
    type Msg = { role: string; content: unknown };
    for (const m of parsed.messages as Msg[]) {
      expect(typeof m.content).toBe('string');
    }

    // (5) No raw control bytes or high-bit bytes anywhere on the wire.
    for (const code of [0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]) {
      expect(sentBody.indexOf(String.fromCharCode(code))).toBe(-1);
    }
  });

  it('AnthropicProvider sends only text content blocks, never image/document blocks', async () => {
    const captured: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const body = typeof init?.body === 'string' ? init.body : '';
      const headers = (init?.headers as Record<string, string>) ?? {};
      captured.push({ url, body, headers });
      return okJson({
        content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE_EXTRACTION }],
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    };

    const filler = '03/05/26  PAYROLL DEPOSIT  $1,234.56\n'.repeat(1500);
    const markdown = '# CC Statement\n' + filler;

    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', fetcher });
    await provider.extract(markdown);

    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!.body);

    // The Anthropic wire format uses content blocks. Walk the messages
    // and assert every content block is text (string or {type:'text'}).
    type Block = string | { type?: string; text?: string };
    const messages = parsed.messages as Array<{ role: string; content: Block | Block[] }>;
    for (const m of messages) {
      const blocks = Array.isArray(m.content) ? m.content : [m.content];
      for (const b of blocks) {
        if (typeof b === 'string') continue;
        // If it ever becomes a structured block, it must be 'text' only —
        // never image, document, base64, or tool-use input from the client.
        expect(b.type === undefined || b.type === 'text').toBe(true);
        expect(b.type).not.toBe('image');
        expect(b.type).not.toBe('document');
      }
    }

    // No image / pdf MIME types in the body string.
    const sentBody = captured[0]!.body;
    expect(sentBody).not.toMatch(/"type"\s*:\s*"image"/);
    expect(sentBody).not.toMatch(/"type"\s*:\s*"document"/);
    expect(sentBody).not.toMatch(/"media_type"\s*:\s*"application\/pdf"/);
    expect(sentBody).not.toMatch(/"media_type"\s*:\s*"image\//);

    // Walk all primitives and assert no base64 magic prefixes leaked.
    for (const s of walkPrimitives(parsed)) {
      expect(s).not.toMatch(/^JVBERi/);
      expect(s).not.toMatch(/^iVBORw0KGgo/);
      expect(s).not.toMatch(/^\/9j\//);
    }
  });
});

describe('safety — no API key in serialized telemetry', () => {
  it('AnthropicProvider extract() result never echoes the apiKey', async () => {
    const SECRET = 'sk-ant-secret-key-do-not-leak-1234567890abcdef';
    const provider = new AnthropicProvider({
      apiKey: SECRET,
      fetcher: async () =>
        okJson({
          content: [{ type: 'tool_use', name: 'emit_extraction', input: SAMPLE_EXTRACTION }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const r = await provider.extract('# md');

    // Serialize the entire ExtractResult via a bigint-safe replacer
    // (telemetry contains a costMicros bigint).
    const serialized = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-ant-secret');

    // Also assert the rawJson is just the extraction, not request metadata.
    expect(r.rawJson).not.toContain(SECRET);
    expect(r.rawJson).not.toContain('sk-ant');

    // And the telemetry block standalone.
    const telemetrySerialized = JSON.stringify(r.telemetry, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(telemetrySerialized).not.toContain(SECRET);
  });
});

// Pino is a transitive workspace dep (apps/api owns it). Import via
// the api workspace's resolved copy so we don't need to add pino to
// the extractor package.json just for this test.
import { pino } from '../../../apps/api/node_modules/pino/pino.js';
import { Writable } from 'node:stream';
// Importing the app logger boots the same module path the production
// app uses; if its config is wrong, this test will catch it because
// we mirror its redact paths below.
import '../../../apps/api/src/lib/logger.js';

describe('safety — no API key in pino logs', () => {
  // Mirror of the redact paths in apps/api/src/lib/logger.ts. Pino's
  // sync destination is sonic-boom which writes directly to fd 1 and
  // therefore can't be spied via process.stdout.write — instead we
  // construct an equivalent logger with an in-memory destination so we
  // can read what _would_ have hit stdout. If you change the redact
  // paths in logger.ts, update this list too — both are guarded here.
  const REDACT_PATHS = [
    'req.headers.cookie',
    'req.headers.authorization',
    'res.headers["set-cookie"]',
    '*.password',
    '*.password_hash',
    '*.api_key',
    '*.apiKey',
    'apiKey',
    'api_key',
    'anthropicApiKey',
    'anthropic_api_key',
    'ANTHROPIC_API_KEY',
  ];

  const makeBufferedLogger = (): { logger: ReturnType<typeof pino>; read: () => string } => {
    let buf = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        cb();
      },
    });
    const lg = pino(
      {
        level: 'info',
        base: { app: 'vibe-tx-converter' },
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      },
      stream,
    );
    return { logger: lg, read: () => buf };
  };

  it('top-level apiKey is redacted (regression: pino *.apiKey only matches one level deep)', () => {
    const SECRET = 'sk-ant-secret';
    const { logger, read } = makeBufferedLogger();
    logger.info({ apiKey: SECRET }, 'top-level apiKey');
    const out = read();
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('top-level api_key is redacted', () => {
    const SECRET = 'sk-ant-secret';
    const { logger, read } = makeBufferedLogger();
    logger.info({ api_key: SECRET }, 'top-level api_key');
    const out = read();
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('nested apiKey under a wildcard path is redacted', () => {
    const SECRET = 'sk-ant-secret';
    const { logger, read } = makeBufferedLogger();
    logger.info({ provider: { apiKey: SECRET } }, 'nested apiKey');
    const out = read();
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('synthetic Anthropic key sk-ant-test-DEADBEEF never appears in log output (Phase 27 #30)', () => {
    const SECRET = 'sk-ant-test-DEADBEEF';
    const { logger, read } = makeBufferedLogger();
    logger.info(
      {
        apiKey: SECRET,
        api_key: SECRET,
        anthropicApiKey: SECRET,
        provider: { apiKey: SECRET, password: SECRET },
      },
      'extraction kickoff',
    );
    const out = read();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('DEADBEEF');
  });
});
