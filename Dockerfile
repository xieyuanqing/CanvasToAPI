FROM node:24-slim AS deps

WORKDIR /app

# Install full dependency set once for build stages.
COPY package.json ./
RUN npm install --no-audit --no-fund --ignore-scripts \
    && npm cache clean --force

FROM node:24-slim AS ui-builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY vite.config.js ./
COPY ui ./ui

# VERSION is passed from docker build-args for version display in UI.
ARG VERSION
RUN VERSION=${VERSION} npm run build:ui

FROM node:24-slim AS prod-deps

WORKDIR /app

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev \
    && npm cache clean --force

FROM node:24-slim AS runtime

WORKDIR /app

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY main.js ./
COPY src ./src
COPY configs ./configs
COPY ui/public ./ui/public
COPY ui/locales ./ui/locales
COPY scripts/client/canvas_sse.html ./scripts/client/canvas_sse.html
COPY --from=ui-builder /app/ui/dist ./ui/dist

USER node

EXPOSE 7861

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const port = process.env.PORT || 7861; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1));" || exit 1

CMD ["node", "main.js"]
