# syntax=docker/dockerfile:1

# ---- Production dependencies ----
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime image ----
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# The container filesystem is ephemeral: data lives in Cloudflare D1 and
# images in Cloudflare R2, so nothing needs to be writable at runtime.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "app.js"]
