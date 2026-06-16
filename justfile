# Operator commands. Real bodies land in later phases.

dev:
    pnpm dev

build:
    pnpm build

test:
    pnpm test --run

migrate:
    pnpm db:migrate

seed:
    pnpm db:seed

fidir-refresh:
    pnpm --filter @vibe-tx-converter/api run db:fidir-seed

# Live smoke test of the OCR-via-Vibe-Shield path (reachability, appId,
# materialize gate, ZDR). Pass --no-llm to skip the tiny /v1/messages probe.
shield-smoke *ARGS:
    pnpm --filter @vibe-tx-converter/api run shield:smoke {{ARGS}}

up:
    docker compose --profile standalone up -d

down:
    docker compose --profile standalone down

logs:
    docker compose --profile standalone logs -f

psql:
    docker compose --profile standalone exec postgres psql -U vibetc

redis-cli:
    docker compose --profile standalone exec redis redis-cli
