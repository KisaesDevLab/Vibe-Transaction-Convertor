# syntax=docker/dockerfile:1.7

# ============================================================================
# Vibe Transactions Converter — multi-stage build
# Populated in Phase 28 (standalone) and refined in Phase 30 (release).
# ============================================================================

ARG NODE_VERSION=20

# ----- builder -----
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile=false
RUN pnpm build

# ----- runtime (placeholder; distroless target lands in Phase 28) -----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}

LABEL org.opencontainers.image.title="vibe-tx-converter" \
      org.opencontainers.image.licenses="PolyForm-Internal-Use-1.0.0" \
      org.opencontainers.image.source="https://github.com/KisaesDevLab/Vibe-Transaction-Convertor"

COPY --from=builder /app /app

EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
