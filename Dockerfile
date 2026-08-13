# Bun runtime image. One image, two commands (bot + dashboard) selected by compose.
FROM oven/bun:1.3.13-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src

# Persisted state (equity history, day tracking) lives here; mounted as a volume.
RUN mkdir -p /app/data

# Default command runs the trader; compose overrides for the dashboard service.
CMD ["bun", "run", "src/index.ts"]
