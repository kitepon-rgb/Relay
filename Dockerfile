# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build deps for better-sqlite3 native module
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Install runtime deps for better-sqlite3
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist

# Data directory mount target
RUN mkdir -p /var/lib/relay && chown node:node /var/lib/relay
VOLUME ["/var/lib/relay"]

USER node

EXPOSE 18804 18805

CMD ["node", "dist/index.js"]
