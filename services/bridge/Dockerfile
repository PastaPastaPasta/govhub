# govhub bridge. Build from the REPOSITORY ROOT (the bridge depends on the @govhub/verify workspace):
#
#   docker build -f services/bridge/Dockerfile -t govhub-bridge .
#
# Runs the TypeScript sources with Node's built-in type stripping (Node >= 22.18), so there is no compile step.
# Native modules: better-sqlite3 (prebuilt binary, or compiled with the toolchain below) and zeromq (ships prebuilds).

# ---- build: install production dependencies of the bridge workspace only ----
FROM node:22.23-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Every workspace manifest, so `npm ci` sees the same workspace set as package-lock.json.
COPY package.json package-lock.json ./
COPY packages/verify/package.json packages/verify/
COPY packages/contracts-v1/package.json packages/contracts-v1/
COPY services/bridge/package.json services/bridge/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @govhub/bridge --include-workspace-root=false --no-audit --no-fund \
 && npm cache clean --force
COPY packages/verify/src packages/verify/src
COPY services/bridge/bin services/bridge/bin
COPY services/bridge/src services/bridge/src
COPY services/bridge/openapi.json services/bridge/
# fail the build, not the container, if a native module does not load
RUN cd services/bridge && node -e "require('better-sqlite3'); require('zeromq'); console.log('native modules ok')"

# ---- runtime ----
FROM node:22.23-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8787 \
    DB_PATH=/data/bridge.sqlite
WORKDIR /app
COPY --from=build /app /app
# uid/gid 1000 = the image's `node` user; /data is created owned by it so a fresh named volume is writable.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/services/bridge
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["node", "bin/bridge.mjs", "healthcheck"]
ENTRYPOINT ["node", "bin/bridge.mjs"]
CMD ["run"]
