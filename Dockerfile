# Lightweight 24/7 Cloud Production Container
FROM node:22-bookworm-slim

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild sharp

# Copy application source code, utility scripts, and public dashboard assets
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY public/ ./public/

# Pre-create runtime data directory and configure ownership for unprivileged node user
RUN mkdir -p /app/.data && chown -R node:node /app

# Security: Run as unprivileged user
USER node

# Cloud port configuration (dynamic for Render, Railway, Fly, Cloud Run)
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Native Node healthcheck (zero external binaries required)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
