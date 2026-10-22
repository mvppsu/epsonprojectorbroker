# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY broker/package.json broker/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
RUN apk add --no-cache tini su-exec && addgroup -S broker && adduser -S broker -G broker
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY broker/package.json ./
COPY broker/src ./src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R broker:broker /app

ENV BROKER_CONFIG=/config/broker.yaml \
    NODE_ENV=production

# Stays root at container start; entrypoint.sh fixes /config ownership then drops to
# "broker" before exec'ing node. See entrypoint.sh for why this matters on UNRAID.
VOLUME ["/config"]
# HTTP API/web panel, and PJLink class 2 notifications from the projector.
EXPOSE 8096 4352/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8096/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/index.js"]
