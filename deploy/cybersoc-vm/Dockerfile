# MyHive for the CyberSOC VM (MISP/Cortex host). Build context: repo root.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci \
    && npm run db:generate \
    && npm run build -w @myhive/api \
    && VITE_API_URL=/api/v1 npm run build -w @myhive/web

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
WORKDIR /app/apps/api
ENV NODE_ENV=production PORT=4100 UPLOAD_DIR=/data/uploads
EXPOSE 4100
# db-sync hace pasos previos idempotentes y luego `prisma db push` (sin --accept-data-loss).
CMD ["sh", "-c", "node prisma/db-sync.mjs && node dist/main.js"]

FROM nginx:1.27-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/cybersoc-vm/nginx.conf /etc/nginx/conf.d/default.conf
