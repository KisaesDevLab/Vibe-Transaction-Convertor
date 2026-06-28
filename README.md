[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I3D3227TTP)

# Vibe Transactions Converter

> Convert bank and credit-card PDF statements into CSV, OFX 2.x XML, QFX, and
> QBO Web Connect files for re-import into QuickBooks Online, QuickBooks
> Desktop, Quicken, Xero, and other downstream accounting tools.

Self-hosted. Local-first. No telemetry. No phone-home.

## Quick start (standalone)

```bash
cp .env.example .env
# set SESSION_SECRET to >= 32 random bytes
docker compose --profile standalone up -d
open http://localhost:4000
```

The first request lands on `/register` because no users exist; create
the first admin and you're in.

## Deployment modes

- **Standalone** (`docker-compose.yml`) ships its own Postgres, Redis,
  a Vibe Shield gateway for OCR, and the LLM gateway.
- **Vibe Appliance** (`docker-compose.appliance.yml` + `vibe-app.yaml`)
  joins the shared Postgres/Redis/Vibe Shield/LLM gateway.

## Documentation

- [User Guide](./docs/user-guide.md) — bookkeeper / staff workflow
- [Operator Guide](./docs/operator-guide.md) — IT operator deployment
  and quarterly maintenance
- [API Reference](./docs/api.md) — internal API surface
- [Data Flow](./docs/data-flow.md) — for SOC 2 reviewers
- [Architectural Decision Records](./docs/adrs/) — 20 ADRs covering every
  hard decision

## Build plan

Implementation proceeds phase-by-phase from [`BuildPlan.md`](./BuildPlan.md).
[`PROGRESS.md`](./PROGRESS.md) tracks status; [`QUESTIONS.md`](./QUESTIONS.md)
captures unresolved questions encountered during the build.

## License

PolyForm Internal Use 1.0.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).