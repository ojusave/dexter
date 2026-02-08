FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies (skip playwright chromium download — not needed for API server)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY . .

EXPOSE 3100

CMD ["bun", "run", "src/server.ts"]
