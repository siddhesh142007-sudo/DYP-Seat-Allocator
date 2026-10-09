# Production Deployment Guide

## Overview

This guide covers deploying the College Exam Seating Management System to production.
The stack: **PostgreSQL 16** + **Node 20 (Express + TypeScript)** + **React 18 (Vite + Tailwind)**.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Client    │────▶│  Reverse    │────▶│  Backend (3001)  │
│  Browser    │     │  Proxy      │     │  Express + JWT   │
└─────────────┘     │ (Caddy/Nginx)│     └────────┬─────────┘
                    └──────┬──────┘              │
                           │                     │
                    ┌──────▼──────┐     ┌────────▼─────────┐
                    │  Static     │     │   PostgreSQL 16  │
                    │  Assets     │     │   (Managed/VM)   │
                    │  (dist/)    │     └──────────────────┘
                    └─────────────┘
```

## Prerequisites

- Docker 24+ / Docker Compose v2
- Or: Node 20 LTS, PostgreSQL 16, reverse proxy (Caddy/Nginx)
- Domain with TLS (Let's Encrypt via Caddy) or existing certificates

## 1. Environment Variables

Copy `.env.example` to `.env` and set **all** production values:

```bash
# backend/.env
DATABASE_URL=postgresql://user:strong_password@host:5432/exam_seating?schema=public
JWT_SECRET=<64-char-base64>           # openssl rand -base64 48
JWT_REFRESH_SECRET=<64-char-base64>   # different from JWT_SECRET
ACCESS_TOKEN_TTL=900                  # 15 min
REFRESH_TOKEN_TTL=604800              # 7 days
PORT=3001
CORS_ORIGIN=https://your-domain.com   # exact origin, no wildcard
NODE_ENV=production
SEATING_TIME_BUDGET_MS=5000           # engine hard cap
PASSWORD_HASH_COST=12                 # bcrypt cost (12+)
SUPER_ADMIN_EMAIL=admin@your-org.com  # optional bootstrap
SUPER_ADMIN_PASSWORD=<strong>         # min 8 chars
SUPER_ADMIN_NAME=Super Admin
```

**Frontend** (`frontend/.env`):
```bash
VITE_API_URL=https://your-domain.com
```

**Never commit `.env`**. Use secrets manager (GitHub Actions secrets, Doppler, 1Password, etc.).

## 2. Database

### Option A: Managed PostgreSQL (Recommended)

- **Supabase / Neon / RDS / Cloud SQL / Railway / Render**
- Provision PostgreSQL 16, note connection string
- Enable `pg_trgm` extension for search (optional but recommended)
- Run migrations:
  ```bash
  # From backend/
  DATABASE_URL="..." npx prisma migrate deploy
  ```

### Option B: Self-hosted (Docker)

```yaml
# docker-compose.prod.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: seating
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_DB: exam_seating
    volumes:
      - db_data:/var/lib/postgresql/data
    secrets:
      - db_password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U seating -d exam_seating"]
      interval: 10s
      timeout: 5s
      retries: 5
secrets:
  db_password:
    file: ./secrets/db_password.txt
volumes:
  db_data:
```

## 3. Backend Deployment

### Docker (recommended)

```dockerfile
# backend/Dockerfile (already exists)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
```

Build & run:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d backend
```

### Health Check

```bash
curl -f https://your-domain.com/api/v1/health
# { "status": "ok", "db": "connected", "uptime": 12345 }
```

## 4. Frontend Deployment

### Build

```bash
# From frontend/
npm ci
npm run build    # outputs dist/
```

### Serve Static Assets

**Option A: Same origin (Caddy/Nginx serves `dist/` + proxies `/api`)**

```nginx
# Nginx example
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    root /var/www/exam-seating/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/v1/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cookie_path / "/; Secure; HttpOnly; SameSite=Lax";
    }

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy strict-origin-when-cross-origin;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none;";
}
```

**Option B: Separate static host (Netlify, Vercel, Cloudflare Pages, S3+CloudFront)**
- Set `VITE_API_URL=https://api.your-domain.com`
- Deploy `dist/` to static host
- Configure CORS on backend: `CORS_ORIGIN=https://your-frontend-domain.com`

### Caddy (simpler, auto-TLS)

```caddy
# Caddyfile
your-domain.com {
    root * /var/www/exam-seating/dist
    try_files {path} /index.html

    @api path /api/v1/*
    reverse_proxy @api localhost:3001 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    encode zstd gzip
}
```

Run: `caddy run --config /etc/caddy/Caddyfile`

## 5. Secrets Management

| Secret | Where | Rotation |
|--------|-------|----------|
| `DATABASE_URL` | Vault / Doppler / GitHub Secrets | Quarterly |
| `JWT_SECRET` | Vault / GitHub Secrets | Monthly (invalidate all sessions) |
| `JWT_REFRESH_SECRET` | Vault / GitHub Secrets | Monthly |
| `SUPER_ADMIN_PASSWORD` | Vault | On admin change |
| DB password | Vault / Cloud secret manager | Quarterly |

**Never** bake secrets into Docker images. Use build args only for non-sensitive config.

## 6. Migrations on Deploy

```bash
# In CI/CD pipeline, before starting new containers:
docker compose run --rm backend npx prisma migrate deploy
# Or from backend/ with DATABASE_URL set:
npx prisma migrate deploy
```

**Zero-downtime strategy:**
1. Run migrations (backward-compatible: only ADD columns/tables, never DROP in same deploy)
2. Deploy new backend (rolling update)
3. If breaking schema change needed: two-phase deploy (add → deploy → remove → deploy)

## 7. Backups

### PostgreSQL
```bash
# Daily logical backup (pg_dump)
pg_dump -h host -U seating exam_seating | gzip > backup_$(date +%F).sql.gz

# Or use managed service point-in-time recovery (RDS, Cloud SQL, Supabase, Neon)
# Retain: 30 days daily, 12 months monthly
```

### Test Restore
```bash
# Quarterly drill
gunzip -c backup_2025-01-15.sql.gz | psql -h localhost -U seating exam_seating_test
```

## 8. Logging & Monitoring

### Structured Logs (pino)
- Backend logs JSON to stdout (Docker captures)
- Ship to Loki / Datadog / CloudWatch / Elasticsearch
- Key fields: `level`, `time`, `req.id`, `req.method`, `req.url`, `res.statusCode`, `responseTime`

### Health Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/health` | Liveness + DB connectivity (`{status, db, uptime}`) |

### Metrics (recommended)
- Request latency (p50, p95, p99)
- Error rate by code (4xx vs 5xx)
- DB connection pool usage
- Seating generation duration / queue length

### Alerting
- 5xx rate > 1% for 5 min → page
- DB unavailable → page
- Disk > 80% → warning
- Backup failed → alert

## 9. Security Checklist

- [ ] TLS 1.2+ everywhere (Caddy auto, or Nginx with Let's Encrypt)
- [ ] `Secure`, `HttpOnly`, `SameSite=Lax` on refresh cookie (set by backend)
- [ ] `CORS_ORIGIN` exact match (no `*`)
- [ ] Helmet/CSP headers (see Nginx config above)
- [ ] Rate limits on `/auth/login`, `/auth/refresh`
- [ ] Argon2/bcrypt cost ≥ 12 (`PASSWORD_HASH_COST=12`)
- [ ] JWT secrets ≥ 256-bit entropy, rotated monthly
- [ ] DB user least privilege (no `SUPERUSER` in prod; migrations run by admin role)
- [ ] `trg_refresh_classroom_capacity` trigger exists (enforces capacity invariant)
- [ ] `trg_allocations_published_immutable` + `trg_runs_published_immutable` (published plans immutable)
- [ ] Audit log captures all mutations (check `audit_logs` table growth)

## 10. Scaling Notes

| Component | Bottleneck | Mitigation |
|-----------|------------|------------|
| Seating generation | CPU (engine) | Single admin at a time; `worker_threads` seam exists; increase `SEATING_TIME_BUDGET_MS` |
| DB connections | Pool exhaustion | PgBouncer in transaction mode; backend pool = 10-20 |
| Export (5k students) | Memory / time | Streaming CSV/PDF; XLSX buffered (exceljs) — limit concurrent exports |
| Frontend static | CDN | Cache `dist/assets/*` with `Cache-Control: immutable, max-age=31536000` |

## 11. Rollback Procedure

1. Revert Docker image tag / deployment
2. If migration was applied: `npx prisma migrate resolve --rolled-back <migration_name>` (mark as rolled back), then re-deploy old version
3. Verify health endpoint
4. Check audit logs for anomalies

## 12. Disaster Recovery

| Scenario | RTO | RPO | Procedure |
|----------|-----|-----|-----------|
| DB primary down | < 5 min (managed failover) | 0 (sync replica) | Promote replica / PITR |
| Region outage | < 30 min | < 1 hr | Restore from latest backup to new region |
| Ransomware / corruption | < 4 hr | < 24 hr | PITR to pre-incident timestamp |
| Accidental DROP | < 1 hr | 0 (if caught in txn) | PITR or logical backup restore |

---

**Verify**: After deploy, run smoke test:
1. Login as Super Admin
2. Create exam → generate → publish
3. Login as student (demo account) → verify seat in portal
4. Export PDF/CSV/XLSX → verify download
---

# Option B: Deploying to Vercel (single project, same-origin)

The Docker/nginx setup above is one option. This section covers Vercel, where the
React SPA and the Express API are served from **one** project on **one** domain,
so the SPA calls `/api/v1/*` on its own origin. Same-origin means the refresh
cookie keeps `SameSite=Lax` and no CORS configuration is required.

## How it is wired

| Path | Handled by |
|------|-------------|
| `/api/*` | rewritten to `api/index.ts` → Express (`backend/dist/app.js`) |
| `/assets/*`, `/index.html` | Vercel static hosting of `frontend/dist` |
| everything else | rewritten to `/index.html` (SPA deep links) |

Key files (all committed):
- `vercel.json` — rewrites + function duration
- `api/index.ts` — Express entry for the Vercel Function
- `package.json` (root) — build orchestration for both apps
- `backend/package.json` — `build` now runs `prisma generate` first

`api/index.ts` is a two-line re-export: `export default createApp()`.

### Why the API rewrite uses `(.*)` and not `:path*`

This is load-bearing. Vercel rewrites are URL-masking, so the Function normally
receives the **original** path in `req.url` and Express routes normally.

However, Vercel's routing compiler appends the captured path as a query
parameter when the source uses a *named* parameter. Compiling both forms through
`@vercel/routing-utils`:

| `source` | compiled `dest` | `req.url` seen by the Function |
|----------|-----------------|--------------------------------|
| `/api/:path*` | `/api/index?path=$1` | destination + query — **all routes 404** |
| `/api/(.*)` | `/api/index` | original path — works |

A `dest` carrying query captures is the documented exception to URL-masking, so
`:path*` breaks routing. The regex capture group `(.*)` avoids it. If this is
ever changed back to `:path*`, every API call will 404.

To re-check after editing `vercel.json`:

```js
const { getTransformedRoutes } = require('@vercel/routing-utils');
const { rewrites } = require('./vercel.json');
console.log(getTransformedRoutes({ routes: [], rewrites }).routes);
// No `dest` should contain `?path=`
```

## Platform limits that shaped this setup

| Limit | Value | Impact here |
|-------|-------|-------------|
| Request/response body | **4.5 MB** | CSV import cap lowered 5 MB → 4 MB |
| Function bundle | 250 MB | fine |
| Max duration | 300 s (Hobby) | `maxDuration: 60` set in `vercel.json` |
| Memory | 2 GB / 1 vCPU | fine |

The 4.5 MB body cap is enforced by Vercel *before* Express runs, so a 5 MB
upload would fail with an opaque 413. The app now rejects anything over 4 MB
itself with a clear validation error.

## Deploy steps

### 1. Provision Postgres

Create a managed Postgres 16 database (Vercel Postgres, Neon, Supabase,
Railway). Copy the pooled connection string.

### 2. Run migrations once, before the first deploy

```bash
cd backend
DATABASE_URL="postgresql://USER:PASS@HOST:5432/exam_seating?schema=public" \
  npx prisma migrate deploy

# optional first super admin
DATABASE_URL="..." SUPER_ADMIN_EMAIL="admin@your.edu" \
  SUPER_ADMIN_PASSWORD="<strong-password>" npm run seed
```

Migrations are **not** part of the build. Re-run this after any schema change.

### 3. Push and import

```bash
git add -A && git commit -m "Add Vercel deployment config"
git push
```

In Vercel: **Add New → Project → import the repo**. Leave the detected settings
alone (`vercel.json` supplies the build command and output directory).

### 4. Set environment variables

Add these under **Project → Settings → Environment Variables**, applied to
Production *and* Preview:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | your pooled Postgres URL |
| `JWT_SECRET` | `openssl rand -hex 64` |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 64` (different from above) |
| `CORS_ORIGIN` | your production domain, e.g. `https://seating.example.com` |
| `SEATING_TIME_BUDGET_MS` | `10000` |

Do **not** set `VITE_API_URL` — the SPA uses relative URLs, which is what makes
this same-origin.

### 5. Deploy and verify

```bash
curl -f https://your-domain/api/v1/health
# {"status":"ok","db":"up",...}

curl -i https://your-domain/api/v1/health | grep -i 'set-cookie'
```

Smoke test: login → create exam → generate seating → publish → export.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Every API call 404s | rewrite source uses `:path*`, which injects `?path=` and replaces `req.url` | use the regex group `(.*)` as in `vercel.json` (see above) |
| "PrismaClient did not initialize" | client not generated | `backend/package.json` `build` must run `prisma generate` first |
| 413 on CSV upload | body over 4.5 MB | keep files under 4 MB |
| Stuck logged out | refresh cookie rejected | `CORS_ORIGIN` must match the exact deployed origin |
| Build fails on `pg_trgm`/extension | DB extension missing | enable it on the managed Postgres, then re-run migrations |

## Known serverless caveats

- **Cold starts.** First request after idle pays ~1-3 s (Prisma client + Express
  init). Fluid compute reduces this.
- **Rate limiting is per-instance.** `express-rate-limit` uses in-memory state,
  so the effective limit multiplies by the number of concurrent instances. For a
  college deployment this is acceptable; for anything stricter, move to a
  Redis-backed store.
- **DB connections.** Each warm instance holds its own pool (max 10). With many
  concurrent instances, use a pooled connection string (PgBouncer / Neon pooled)
  to stay under the Postgres connection limit.
- **Seating generation** runs in a `worker_threads` Worker; `maxDuration: 60`
  covers the 10 s engine budget plus DB writes.
