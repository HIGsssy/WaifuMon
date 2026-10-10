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
#
# Managed artwork (uploads) lives outside the app tree. The directory exists
# and is owned by `node` so the path works even without compose — but uploads
# only survive a rebuild when /data/waifumon-assets is a mounted volume, as
# docker-compose.yml makes it. See docs/boss-management.md.
ENV MANAGED_ASSETS_DIR=/data/waifumon-assets
RUN mkdir -p /data/waifumon-assets && chown -R node:node /data/waifumon-assets
USER node
CMD ["node", "dist/index.js"]
