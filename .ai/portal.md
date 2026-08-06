Running the Portal locally
1. Enable the Platform API on the bot
The Portal is a pure API consumer; without the API it has nothing to read. In the bot's .env (repo root):


PLATFORM_API_ENABLED=true
PLATFORM_API_PORT=3120
PLATFORM_API_TOKEN=<a long random secret>    # openssl rand -hex 32
Restart the bot. Confirm it's up:


curl http://127.0.0.1:3120/ready
# {"status":"ok","components":{"database":{"status":"ok",...
2. Find a player id
The Portal addresses players by internal integer id, not Discord snowflake:


curl -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  "http://127.0.0.1:3120/api/v1/players/lookup?discordGuildId=<guild>&discordUserId=<user>"
# {"data":{"playerId":1},...}
A player row only exists after that person has run a /waifumon command at least once. Neither the Portal nor this endpoint can create one.

3. Configure the Portal

cd portal
cp .env.example .env.local
Edit portal/.env.local:

Variable	Required	Value
VITE_PLATFORM_API_URL	—	/api — leave as-is; the dev server proxies it
VITE_PLATFORM_API_PROXY_TARGET	—	http://127.0.0.1:3120 — must match the bot's port
VITE_PLATFORM_API_TOKEN	yes	Must equal PLATFORM_API_TOKEN exactly
VITE_DEFAULT_PLAYER_ID	yes	The integer from step 2
VITE_DEFAULT_DISCORD_GUILD_ID	—	Cosmetic; shown on the diagnostics page
VITE_DEFAULT_DISCORD_USER_ID	—	Cosmetic
VITE_DEV_ASSETS_PATH	—	Defaults to the repo's assets/
VITE_IMAGE_PROVIDERS	—	Defaults to apiSuppliedUrl,localDevAssets
4. Install and run
Node 22+ required. portal/ has its own lockfile and does not touch the bot's node_modules.


npm install     # ~9s from a clean checkout
npm run dev
URL: http://127.0.0.1:5173 — it redirects to /dashboard.

Startup prints the effective wiring, so a wrong port is obvious immediately:


  portal  Platform API proxy -> http://127.0.0.1:3120
  portal  /dev-assets -> C:\ClaudeProjects\Waifumon\WaifuMon\assets
Other commands
Command	Purpose
npm run typecheck	tsc --noEmit
npm run lint	ESLint, including the architectural boundary rules
npm run test	149 component tests (MSW-mocked — no bot needed)
npm run e2e	76 Playwright tests (stubbed — no bot needed)
npm run build	Bundle into portal/dist/
npm run verify:bundle	Asserts dev-only code is absent from the build
If something's wrong
Symptom	Cause
Lands on /select-player	The screen names the exact reason — usually an unset id, a snowflake instead of an internal id, or a player who has never played
"Can't reach the Waifumon server"	Bot down, PLATFORM_API_ENABLED not true, or wrong proxy target
"The Platform API rejected the token"	The two token values differ
Everything is a silhouette	Assets dir not found — check the /dev-assets startup line
Name shows as Trainer #1	API returned no identity (bot predates that field, or the gateway couldn't resolve the user)
http://127.0.0.1:5173/__dev/diagnostics reports the live API URL, /ready probe, resolved session, cache contents, recent request timings and the image-resolver fallback rate.

Production deployment
There is no deployment procedure to give you, and I'd be doing you a disservice to invent one. Deployment is an explicit non-goal of the approved plan (§4: "No production deployment. Local dev + LAN only"; §20: "v1 = local dev only"), and it's deferred to §25.13 — behind §25.9 and §25.14.

Completing Phase 3 didn't unlock it. Phase 3 was hardening — responsive, accessibility, tests, docs. It changed nothing about the security posture.

Why deploying today would be actively dangerous
Three properties of the current build, each independently disqualifying:

No authentication whatsoever. No login, no session, no cookie. Whoever loads the URL is the player named by VITE_DEFAULT_PLAYER_ID. A public deploy shows one specific player's collection to the entire internet, and there is no mechanism to show anyone else theirs.

The Platform API token ships inside the JavaScript bundle. VITE_-prefixed values are compiled in. Anyone who opens devtools gets a working credential for your Platform API — and that API has no rate limiting, no per-player scoping, and write endpoints in Phase 3 of its own roadmap. The Portal refusing to write doesn't stop a stolen token from being used directly with curl.

The API has no CORS allow-list. The dev proxy sidesteps it. A deployed SPA on a different origin cannot call it at all — so it wouldn't work regardless.

What has to land first
#	Prerequisite	Why	Reference
1	Discord OAuth — replace DevSessionProvider with OAuthSessionProvider plus a small Portal-owned BFF for the callback	Removes both the "one hardcoded player" problem and the token-in-bundle problem: the BFF holds the credential server-side and sets an httpOnly cookie	§25.14
2	CORS allow-list on the Platform API	A deployed Portal is a different origin	§25.9
3	Per-player rate limiting on the API	It currently has none; public exposure needs it	API plan §10.7
4	Image endpoint with resized variants	4 MB PNGs × 25 cards ≈ 110 MB per page view. Not a polish issue at public scale	§25.3
5	TLS termination	An httpOnly session cookie over plaintext is not a session	§25.13
Items 1–3 are the security gate. Items 4–5 are the operability gate.

What the architecture already guarantees for that day
The v1 work was built so this migration is small, and that's worth stating precisely:

The OAuth swap is one line. app/providers.tsx imports the session provider under an alias. Every page reads session.playerId from PortalSession and nothing else — verified: all 9 player-scoped pages use useCurrentSession(), and only auth/ reads the player-id env var.
The image migration is one file. Adding an API-endpoint or CDN provider is a new entry in images/provider.ts. No page or component changes.
npm run build already works and is exercised in CI on every PR, so the build side of deployment is not the unknown.
The honest recommendation
Treat production deployment as its own project with its own plan, sequenced after the Platform API Presentation Enhancements milestone — the same way the Portal itself got one. It needs decisions the Portal plan deliberately didn't make: where it's hosted, who may sign in, what a session's lifetime is, what happens to a player who leaves the guild.

In the meantime, if you want it reachable from your phone or another machine on your own network, that's within v1's stated envelope (§20: "local dev + LAN"): run npx vite --host 0.0.0.0 and reach it at your machine's LAN IP on port 5173. Everything in the security section still applies to everyone on that network — so a trusted LAN only, never a coffee shop.