# OpenAdult — ローカル実行 & デプロイガイド / Running Locally & Deploying

Two ways to view the app on **localhost**, plus notes on the production Docker
stack. Pick the path that matches your machine.

---

## Path A — no Docker needed (native scripts)  ✅ verified

For dev boxes without Docker or a system MySQL. A helper downloads a portable
MariaDB (no root), applies migrations, seeds sample data, and runs the
**production build** (`node dist/index.js` — the exact artifact the container runs).

```bash
pnpm install
pnpm build                 # produces dist/index.js + dist/public
./scripts/dev-up.sh --seed # DB + migrate + seed + start server
# → open http://localhost:3000
```

Stop it:
```bash
./scripts/dev-down.sh        # stop the app
./scripts/dev-down.sh --db   # also stop the local DB
```

Helper scripts:
| Script | What it does |
|---|---|
| `scripts/localdb.sh {start\|stop\|status\|cli}` | Portable no-root MariaDB in `~/.openadult-localdb` on port 3307 |
| `scripts/dev-up.sh [--seed]` | Start DB + migrate + (seed) + start prod server on `PORT` (default 3000) |
| `scripts/dev-down.sh [--db]` | Stop the app (and optionally the DB) |
| `scripts/dev-seed.sql` | Sample data (3 videos, 2 actresses, 1 ad) |

> The DB port `127.0.0.1:3307` is **MySQL**, not HTTP — you connect to it with a
> DB client (`scripts/localdb.sh cli`), you do **not** open it in a browser.
> The only browsable URL is the app: **http://localhost:3000**.

---

## Path B — Docker (self-contained localhost stack)

`deploy/docker/docker-compose.local.yml` brings up **db + migrate + app +
http-only nginx** with one command — no SSL, no Cloudflare gating, no external DB.

```bash
cd deploy/docker
docker compose -f docker-compose.local.yml up -d --build
# → app directly:      http://localhost:3000
# → app through nginx:  http://localhost:8080
# optional sample data:
docker compose -f docker-compose.local.yml --profile seed run --rm seed
```

Stop / reset:
```bash
docker compose -f docker-compose.local.yml down      # stop
docker compose -f docker-compose.local.yml down -v   # stop + delete DB volume
```

> Not runtime-tested in the authoring environment (it had no Docker). The compose
> is YAML-valid and its `migrate` step (`node_modules/.bin/drizzle-kit migrate`)
> was verified natively against MariaDB. Report any build/run issue.

---

## Config sanity (no DB needed)

```bash
pnpm check   # tsc --noEmit → clean
pnpm build   # vite + esbuild → dist/public + dist/index.js
pnpm test    # vitest → 64 passing (DB-backed cases skip without DATABASE_URL)
```

Env: `cp .env.example .env`, set at least `DATABASE_URL` + `JWT_SECRET`. The
server auto-loads `.env` via `import "dotenv/config"` — do **not** `source .env`
(values like `DOMAIN_POOL` are JSON). Full list: [deploy/docs/env-template.md](deploy/docs/env-template.md).

---

## Production deploy (full stack)

`deploy/docker/docker-compose.yml` is the production stack (app, nginx+SSL,
openresty CDN, transcoder, domain-rotator, redis, prometheus, grafana). It is
designed to sit **behind Cloudflare** and expects:

1. An **external** MySQL/TiDB reachable via `DATABASE_URL` (there is no `db`
   service by design). The new one-shot `migrate` service applies the schema
   before `app` starts.
2. **Real TLS certs** in the `ssl-certs` volume: `origin.pem` / `origin-key.pem`
   for nginx, `cdn-origin.pem` / `cdn-origin-key.pem` for openresty. nginx
   `listen 443 ssl` will not start without them. For a non-Cloudflare test, seed
   the volume with a self-signed cert, e.g.:
   ```bash
   docker run --rm -v openadult_ssl-certs:/ssl alpine sh -c \
     'apk add openssl && openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /ssl/origin-key.pem -out /ssl/origin.pem -subj /CN=localhost'
   ```
3. The nginx 443 server only allows Cloudflare IPs (`include cloudflare-ips.conf;
   deny all;`) — intentional origin hardening. Direct browser access to the
   origin is 403 by design; go through Cloudflare, or use Path B for local viewing.

See [DEPLOY_FIXES.md](DEPLOY_FIXES.md) for the specific bugs that were corrected in
the deploy stack.
