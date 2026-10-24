# govhub relay. Build from the REPOSITORY ROOT (the relay depends on the @govhub/verify workspace):
#
#   docker build -f services/relay/Dockerfile -t govhub-relay .
#
# Runs the TypeScript sources with Node's built-in type stripping (Node >= 22.18), so there is no compile step.
# Native module: better-sqlite3 (prebuilt binary, or compiled with the toolchain below).

# ---- build: install production dependencies of the relay workspace only ----
FROM node:22.23-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Every workspace manifest, so `npm ci` sees the same workspace set as package-lock.json.
COPY package.json package-lock.json ./
COPY packages/auth/package.json packages/auth/
COPY packages/contracts-v1/package.json packages/contracts-v1/
COPY packages/dapi/package.json packages/dapi/
COPY packages/forum/package.json packages/forum/
COPY packages/verify/package.json packages/verify/
COPY services/bridge/package.json services/bridge/
COPY services/relay/package.json services/relay/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @govhub/relay --include-workspace-root=false --no-audit --no-fund \
 && npm cache clean --force
COPY packages/verify/src packages/verify/src
COPY services/relay/bin services/relay/bin
COPY services/relay/src services/relay/src
COPY services/relay/openapi.json services/relay/
# fail the build, not the container, if the native module does not load
RUN cd services/relay && node -e "require('better-sqlite3'); console.log('native modules ok')"

# ---- runtime ----
FROM node:22.23-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8788 \
    DB_PATH=/data/relay.sqlite
WORKDIR /app
COPY --from=build /app /app
# uid/gid 1000 = the image's `node` user; /data is created owned by it so a fresh named volume is writable.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/services/relay
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["node", "bin/relay.mjs", "healthcheck"]
ENTRYPOINT ["node", "bin/relay.mjs"]
CMD ["run"]
