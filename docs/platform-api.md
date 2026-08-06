# Waifumon Platform API

An **internal** REST surface (`/api/v1/…`) over the game service layer, served
by a second Fastify instance inside the bot process. It owns no gameplay logic
and shares `AppContext` in memory with the Discord shell.

It is **disabled by default**, has no TLS, no CORS and no player
authentication — every request carries a shared bearer token. Implementation
notes for the endpoint set live in
[platform-api-phase2.md](platform-api-phase2.md).

> **v1 mutations do not emit Game Events.** Actions taken through this API do
> not appear in the Activity Feed and do not update Trainer Profiles.

---

## Enabling it

Add to `.env`:

```sh
PLATFORM_API_ENABLED=true
PLATFORM_API_PORT=3120
PLATFORM_API_TOKEN=<a long random secret>    # openssl rand -hex 32
```

| Variable | Default | Notes |
| --- | --- | --- |
| `PLATFORM_API_ENABLED` | `false` | `true`/`1` to start the API. Anything else keeps it off, at zero cost. |
| `PLATFORM_API_PORT` | `3120` | |
| `PLATFORM_API_TOKEN` | *(empty)* | **Required** when enabled — startup fails with a config error otherwise. Never logged. |

Every request needs `Authorization: Bearer $PLATFORM_API_TOKEN`, except
`/health`, `/ready`, `/api/v1/docs` and `/api/v1/openapi.json`.

---

## Networking: three different concepts

The three remaining variables look similar and are not interchangeable. They
answer three different questions:

| Variable | Question it answers | Default |
| --- | --- | --- |
| `PLATFORM_API_HOST` | Where does the process **listen**? | `127.0.0.1` |
| `PLATFORM_API_PUBLISH_HOST` | Where does **Docker publish** the port on the host? | `127.0.0.1` |
| `PLATFORM_API_PUBLIC_URL` | How do **clients reach** it? | *(derived)* |

### `PLATFORM_API_HOST` — the bind

An internal networking concern only. Use `127.0.0.1` when running the bot
directly on the host and reach it through a tunnel:

```sh
ssh -L 3120:127.0.0.1:3120 user@server
```

Under Docker it **must** be `0.0.0.0`: loopback inside a container is its own
network namespace and is unreachable from outside it. The process logs a
warning whenever the bind is neither loopback (`127.0.0.0/8`) nor Tailscale
(`100.64.0.0/10`) — expected and harmless under Docker.

### `PLATFORM_API_PUBLISH_HOST` — the Docker boundary

Docker only, consumed by `docker-compose.yml`, not by the app. This is the real
security boundary — not the bind above.

- `127.0.0.1` — host loopback only, reach it with an SSH tunnel (default)
- `100.x.y.z` — the host's own Tailscale IP, reachable across the tailnet
- `0.0.0.0` — **never**: published ports are inserted ahead of ufw/iptables, so
  a firewall will not protect it.

### `PLATFORM_API_PUBLIC_URL` — the advertised URL

The base URL clients are expected to call. It is what the OpenAPI document
lists under `servers`, and therefore the URL Swagger UI's **Try it out** builds
its requests from. Optional, and never a bind:

```sh
PLATFORM_API_PUBLIC_URL=http://127.0.0.1:3120      # local dev, Docker on loopback
PLATFORM_API_PUBLIC_URL=http://100.x.y.z:3120      # Tailscale
PLATFORM_API_PUBLIC_URL=https://api.waifumon.com   # behind a TLS reverse proxy
```

It must be an absolute `http(s)` URL; a wildcard host (`0.0.0.0`, `::`) is
rejected at startup, and a trailing slash is trimmed.

**When it is unset**, the URL is derived from the bind — `http://<host>:<port>`
— except for a wildcard bind, which falls back to
`http://127.0.0.1:$PLATFORM_API_PORT`. That fallback is the point of the
variable: `0.0.0.0` is a valid listening address but not a routable one, so a
Swagger UI that advertised it would fail every "Try it out" from the browser.
The derived value is a guess that matches the default Docker setup (published
to loopback); set `PLATFORM_API_PUBLIC_URL` whenever you publish anywhere else.

The startup log prints both, so a mismatch is visible at a glance:

```
platform API listening on 0.0.0.0:3120 — clients use http://127.0.0.1:3120/api/v1 (docs: http://127.0.0.1:3120/api/v1/docs)
```

---

## Docs and spec

| Path | Serves |
| --- | --- |
| `/api/v1/docs` | Swagger UI |
| `/api/v1/openapi.json` | The OpenAPI 3.1 document |
| `/health` | Liveness — never touches the database |
| `/ready` | Readiness — database, content and Discord client probes |

Both docs routes are public so an operator can read them without a token;
authorize in Swagger UI with the bearer token before calling any endpoint.
