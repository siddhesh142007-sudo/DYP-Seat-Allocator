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