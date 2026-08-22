# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.17.0
ARG PNPM_VERSION=10.24.0

FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
WORKDIR /app
ENV CI=1

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile && \
  pnpm build && \
  pnpm --filter @navocms/mcp --prod deploy --legacy /opt/navocms

FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NAVOCMS_RUNTIME_MODE=production
ENV NAVOCMS_HOST=0.0.0.0
ENV PORT=8788

RUN apt-get update && \
  apt-get install --yes --no-install-recommends tini ca-certificates curl && \
  rm -rf /var/lib/apt/lists/* && \
  npm install --global @dotenvx/dotenvx@2.15.1 --no-audit --no-fund && \
  npm cache clean --force && \
  groupadd --system --gid 1001 navocms && \
  useradd --system --uid 1001 --gid navocms --home-dir /app navocms

COPY --from=builder --chown=navocms:navocms /opt/navocms ./
COPY --chown=navocms:navocms deploy/docker/entrypoint.sh /usr/local/bin/navocms-entrypoint

USER navocms
EXPOSE 8788
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["tini", "--", "navocms-entrypoint"]
CMD ["node", "dist/server.js"]
