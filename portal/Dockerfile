# ── build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app/portal

COPY portal/package.json portal/package-lock.json ./
RUN npm ci

COPY portal ./

# Defence in depth: make a stray Vite env file structurally impossible to read.
#
# `.dockerignore` should already have kept these out of the build context, and
# it is verified to. This line is the second lock, for the day that file is
# edited by someone who does not know why those entries are there.
#
# It matters because Vite's env loading sits *beneath* the ARG/ENV allowlist
# below: `vite build` reads `.env`, `.env.local`, `.env.<mode>` and
# `.env.<mode>.local` off disk on its own and merges them in, so a file the
# Dockerfile never mentions can still put `VITE_PLATFORM_API_TOKEN` — a shared
# Platform API credential — into a public browser bundle. The ARGs below are
# the only supported way to configure this build; nothing here needs an env
# file, so removing all of them costs the build nothing.
#
# `.env.example` is documentation and is excluded from the context anyway; this
# does not touch the committed copy in the repo.
RUN rm -f .env .env.local \
          .env.production .env.production.local \
          .env.development .env.development.local \
          .env.e2e .env.e2e.local

ARG VITE_PLATFORM_API_URL=/api
ARG VITE_API_TIMEOUT_MS=
ARG VITE_DEFAULT_PLAYER_ID=
ARG VITE_DEFAULT_DISCORD_GUILD_ID=
ARG VITE_DEFAULT_DISCORD_USER_ID=
ARG VITE_IMAGE_PROVIDERS=
ARG VITE_ASSET_CDN_URL=

ENV VITE_PLATFORM_API_URL=${VITE_PLATFORM_API_URL}
ENV VITE_API_TIMEOUT_MS=${VITE_API_TIMEOUT_MS}
ENV VITE_DEFAULT_PLAYER_ID=${VITE_DEFAULT_PLAYER_ID}
ENV VITE_DEFAULT_DISCORD_GUILD_ID=${VITE_DEFAULT_DISCORD_GUILD_ID}
ENV VITE_DEFAULT_DISCORD_USER_ID=${VITE_DEFAULT_DISCORD_USER_ID}
ENV VITE_IMAGE_PROVIDERS=${VITE_IMAGE_PROVIDERS}
ENV VITE_ASSET_CDN_URL=${VITE_ASSET_CDN_URL}

RUN npm run build && npm run verify:bundle

# ── runtime stage ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY portal/nginx.conf.template /etc/nginx/templates/default.conf.template
# Not under /etc/nginx/templates: files there are envsubst'd into
# /etc/nginx/conf.d/ at boot, which would both mangle this one and load it as a
# standalone config. It carries no ${VARS}, so it is copied to its final path
# and pulled in by `include` from the rendered template.
COPY portal/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/portal/dist /usr/share/nginx/html

EXPOSE 8080
