ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci must see this file: dependency resolution uses a local SDK tarball.
COPY vendor/azurekiln-moderation-client-0.1.0.tgz ./vendor/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3146 \
    ADMIN_SETTINGS_FILE=/app/data/admin-settings.json

COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY server.js ./
COPY config/ ./config/
COPY db/ ./db/
COPY models/ ./models/
COPY services/ ./services/
COPY views/ ./views/
COPY public/css/ ./public/css/
COPY public/js/ ./public/js/
COPY vendor/azurekiln-moderation-client-0.1.0.tgz ./vendor/
COPY scripts/init-db.js scripts/check-config.js ./scripts/
RUN mkdir -p data keys public/assets && chown node:node data

USER node:node
EXPOSE 3146
# Bootstrap verifies keys and schema before listening. This probe checks HTTP
# liveness afterwards; it is not an ongoing MySQL readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3146/.well-known/openid-configuration', { redirect: 'error', signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
