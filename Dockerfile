# syntax=docker/dockerfile:1.7

# Vibe Transactions Converter — multi-stage build (Phase 28).

ARG NODE_VERSION=24

# ----- builder ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json tsconfig.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
COPY data ./data

RUN pnpm install --frozen-lockfile=false
RUN pnpm build

# ----- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# poppler-utils provides pdftoppm for OCR rasterization (Q-006).
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

LABEL org.opencontainers.image.title="vibe-tx-converter" \
      org.opencontainers.image.licenses="PolyForm-Internal-Use-1.0.0" \
      org.opencontainers.image.source="https://github.com/KisaesDevLab/Vibe-Transaction-Convertor" \
      org.opencontainers.image.description="Self-hosted PDF-statement converter to CSV/OFX/QFX/QBO" \
      org.opencontainers.image.version="${BUILD_SHA}"

# Workspace symlinks resolved by pnpm. The root /app/node_modules
# carries the .pnpm content store; each workspace's own node_modules
# carries the per-package symlinks that point into that store. Both
# halves are required for runtime module resolution from
# /app/apps/api/dist/... — without apps/api/node_modules, Node can't
# find pg / bullmq / drizzle / etc. and boot crashes.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/src/db/migrations ./apps/api/src/db/migrations
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/data ./data

VOLUME ["/var/lib/vibetc"]
EXPOSE 4000

# Phase 30 #9 — run as non-root. node:bookworm-slim ships with a uid 1000
# `node` user already; reuse it. The data volume mount path is owned by
# this user so the runtime can write to /var/lib/vibetc without sudo.
RUN mkdir -p /var/lib/vibetc \
    && chown -R node:node /var/lib/vibetc /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:4000/api/health/live || exit 1

CMD ["node", "apps/api/dist/index.js"]
