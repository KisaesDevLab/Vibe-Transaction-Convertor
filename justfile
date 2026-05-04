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
    @echo "fidir:refresh — implemented in Phase 5"

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
