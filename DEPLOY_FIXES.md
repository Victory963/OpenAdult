# Deploy stack — audit & fixes

A multi-agent audit of `deploy/` found 14 verified blockers. Fixes applied below.
Nothing here was runtime-tested with Docker (the authoring machine had none);
each fix was verified by reading the code, the migrate step was proven natively,
and the compose files are YAML-valid.

## Fixed (bugs — wrong in every topology)

| # | File | Problem | Fix |
|---|------|---------|-----|
| 1 | `deploy/nginx/openadult-main.conf` | `upstream` → `127.0.0.1:3000/3001`; inside the nginx container that's nginx's own loopback → every `/api` 502 | `upstream nodejs_app { server app:3000; }` (Docker service DNS) |
| 2 | `deploy/openresty/openresty-cdn.conf` | Mounted as the main nginx.conf but had **no `events{}` / `http{}`** → invalid config, won't start | Wrapped in `worker_processes` + `events{}` + `http{}` |
| 3 | `deploy/openresty/openresty-cdn.conf` | `ad_decision` upstream + impression call → `127.0.0.1:3000` | → `app:3000`; `resolver` → Docker DNS `127.0.0.11` |
| 4 | `deploy/openresty/lua/ad_stitcher.lua`, `variant_stitcher.lua` | ad-decision calls → `http://127.0.0.1:3000` | → `http://app:3000` |
| 5 | `deploy/ffmpeg/*.sh` + `Dockerfile.transcoder` | Read-only mount shadows the image's `chmod +x`; scripts were mode 0644 → exec-form CMD fails | `chmod +x` the scripts in-repo **and** `CMD ["bash", ...]` |
| 6 | `deploy/docker/Dockerfile.app` | `drizzle.config.ts` not in the image → can't run migrations from it | `COPY --from=builder /app/drizzle.config.ts ./` |
| 7 | `deploy/docker/docker-compose.yml` | **Migrations never applied** → external DB schema never created | Added one-shot `migrate` service (`node_modules/.bin/drizzle-kit migrate`); `app` now `depends_on: migrate: service_completed_successfully` |
| 8 | `deploy/docker/docker-compose.yml` | Obsolete `version:` key (Compose v2 warns) | Removed |

## Added

- **`deploy/docker/docker-compose.local.yml`** — self-contained localhost stack
  (MariaDB + migrate + app + HTTP-only nginx), one command up, no SSL/Cloudflare.
- **`deploy/nginx/openadult-local.conf`** — plain HTTP reverse proxy to `app:3000`.

## Remaining production requirements (by design — not bugs)

These make the **production** `docker-compose.yml` refuse to start on a bare
localhost; they are intentional for a Cloudflare-fronted origin. Use
`docker-compose.local.yml` for local viewing, or satisfy them for a real deploy:

- **TLS certs** must exist in the `ssl-certs` volume: `origin.pem`/`origin-key.pem`
  (nginx) and `cdn-origin.pem`/`cdn-origin-key.pem` (openresty). See
  [LOCAL_DEV.md](LOCAL_DEV.md) “Production deploy” for a self-signed seed command.
- **Cloudflare-only allow-list** (`include cloudflare-ips.conf; deny all;`) blocks
  direct origin access — keep it in production; bypass only via Cloudflare or the
  local stack.
- **External DB**: production has no `db` service; point `DATABASE_URL` at your
  MySQL/TiDB. The `migrate` service seeds the schema.
