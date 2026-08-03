# ── build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# Owned by `node` so the admin panel can write content edits and backups even
# when content/ is not bind-mounted. Those edits still only survive a rebuild
# if the host directory IS mounted — see docs/admin-web.md.
COPY --chown=node:node content ./content
# Assets are volume-mounted at /app/assets (ASSETS_DIR).
USER node
CMD ["node", "dist/index.js"]
