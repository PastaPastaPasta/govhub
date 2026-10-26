# govhub MN badge issuer. Build from the REPOSITORY ROOT (it uses the @govhub/badge, @govhub/verify and @govhub/auth workspaces):
#
#   docker build -f services/issuer/Dockerfile -t govhub-issuer .
#
# Runs the TypeScript sources with Node's built-in type stripping (Node >= 22.18): no compile step.
# Native module: better-sqlite3 (prebuilt binary, or compiled with the toolchain below).

# ---- build: production dependencies of the issuer workspace only ----
FROM node:22.23-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/verify/package.json packages/verify/
COPY packages/badge/package.json packages/badge/
COPY packages/auth/package.json packages/auth/
COPY packages/dapi/package.json packages/dapi/
COPY packages/contracts-v1/package.json packages/contracts-v1/
COPY packages/forum/package.json packages/forum/
COPY services/issuer/package.json services/issuer/
COPY services/bridge/package.json services/bridge/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @govhub/issuer --include-workspace-root=false --no-audit --no-fund \
 && npm cache clean --force
COPY packages/verify/src packages/verify/src
COPY packages/badge/src packages/badge/src
# the PV13 query lint and the schemas it checks the issuer's badge queries and auth's vault query against
COPY packages/contracts-v1/queryLint.ts packages/contracts-v1/badge.json packages/contracts-v1/forum.json packages/contracts-v1/
# only the evo-sdk document writer and what it imports (no WebAuthn, no funding code)
COPY packages/auth/src/evo.ts packages/auth/src/bytes.ts packages/auth/src/keys.ts packages/auth/src/platform.ts packages/auth/src/layout.ts packages/auth/src/
COPY services/issuer/bin services/issuer/bin
COPY services/issuer/src services/issuer/src
COPY services/issuer/openapi.json services/issuer/
RUN cd services/issuer && node -e "require('better-sqlite3'); console.log('native modules ok')" \
 && node --input-type=module -e "await import('@govhub/auth/evo'); await import('@govhub/badge'); await import('@govhub/contracts-v1/queryLint'); console.log('workspaces ok')"

# ---- runtime ----
FROM node:22.23-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8789 \
    DB_PATH=/data/issuer.sqlite \
    ISSUER_KEY_DIR=/keys
WORKDIR /app
COPY --from=build /app /app
# uid/gid 1000 = the image's `node` user. /data (token store, never backed up) and /keys (per-epoch private keys, destroyed after
# their window) are created owned by it so fresh volumes are writable.
RUN mkdir -p /data /keys && chown node:node /data /keys && chmod 700 /keys
USER node
WORKDIR /app/services/issuer
VOLUME ["/data"]
EXPOSE 8789
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "bin/issuer.mjs", "healthcheck"]
ENTRYPOINT ["node", "bin/issuer.mjs"]
CMD ["run"]
