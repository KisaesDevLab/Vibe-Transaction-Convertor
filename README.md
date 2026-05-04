# Vibe Transactions Converter

> Convert bank and credit-card PDF statements into CSV, OFX 2.x XML, QFX, and
> QBO Web Connect files for re-import into QuickBooks Online, QuickBooks
> Desktop, Quicken, Xero, and other downstream accounting tools.

Self-hosted. Local-first. No telemetry. No phone-home.

## Deployment modes

- **Standalone** — `docker compose up` ships its own Postgres, Redis, GLM-OCR,
  and LLM gateway.
- **Vibe Appliance** — registers in the appliance manifest and uses the shared
  Postgres / Redis / GLM-OCR / LLM gateway, routing through shared Caddy.

## Quick start

_Placeholder — populated in Phase 31._

## License

PolyForm Internal Use 1.0.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Build plan

Implementation proceeds phase-by-phase from [`BuildPlan.md`](./BuildPlan.md).
[`CLAUDE.md`](./CLAUDE.md) orients contributors (and Claude Code) to the
load-bearing invariants.
