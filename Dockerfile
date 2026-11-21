FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY scripts/bootstrap-admin.js scripts/database-backup.js scripts/database-restore.js scripts/daily-backup.sh ./scripts/
RUN chown -R node:node /app && mkdir -p /var/lib/health/data /var/lib/health/backups && chown -R node:node /var/lib/health

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HEALTH_DB_PATH=/var/lib/health/data/health-centre.sqlite COOKIE_SECURE=true TRUST_PROXY_HOPS=1 DEMO_MODE=true
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p /var/lib/health/data /var/lib/health/backups && chown -R node:node /var/lib/health
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
