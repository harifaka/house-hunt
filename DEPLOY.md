# Deployment Guide

House Hunt is a **stateless** Node.js/Express application designed for containers with
an ephemeral filesystem, such as Google Cloud Run. Nothing is persisted inside the
container:

- **Cloudflare D1** (over the HTTP REST API) stores all relational data.
- **Cloudflare R2** (S3-compatible API) stores every uploaded photo.
- The container image only contains code and read-only assets (`views/`, `public/`, `data/`, `fonts/`).

---

## 1. Provision Cloudflare resources

### D1 database

```bash
npx wrangler d1 create house-hunt
```

Copy the returned `database_id` — you need it as `CLOUDFLARE_D1_DATABASE_ID`.
The application creates its schema and seed data on startup, so no manual migration
step is required. If you prefer to prepare the database up front:

```bash
npx wrangler d1 execute house-hunt --remote --command "SELECT 1"
```

### R2 bucket

```bash
npx wrangler r2 bucket create house-hunt-images
```

Expose the bucket publicly, either through the `r2.dev` development URL or a custom
domain, and use that value for `R2_PUBLIC_DOMAIN` (for example `https://images.example.com`).

### Credentials

| Credential | Where to create it | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → *D1 Edit* | D1 REST API |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 → Manage R2 API Tokens → *Object Read & Write* | R2 uploads/deletes |

---

## 2. Environment variables

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `PORT` | No | HTTP port (Cloud Run injects it) | `8080` |
| `NODE_ENV` | No | `production` on Cloud Run | `development` |
| `SESSION_SECRET` | Recommended | Session signing secret — store in Secret Manager | Random per instance |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Account owning the D1 database | — |
| `CLOUDFLARE_API_TOKEN` | Yes | Token with **D1 Edit** permission | — |
| `CLOUDFLARE_D1_DATABASE_ID` | Yes | D1 database UUID | — |
| `R2_ACCOUNT_ID` | Yes | Account owning the R2 bucket | — |
| `R2_ACCESS_KEY_ID` | Yes | R2 access key ID | — |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 secret access key | — |
| `R2_BUCKET_NAME` | Yes | Bucket for uploaded photos | — |
| `R2_PUBLIC_DOMAIN` | Recommended | Public domain used to build image URLs | — |
| `R2_OBJECT_KEY_PREFIX` | No | Object key prefix | `house-hunt/images` |
| `CLOUDFLARE_API_BASE_URL` | No | Override the Cloudflare API base URL | `https://api.cloudflare.com/client/v4` |
| `LOG_RETENTION_DAYS` | No | Days of audit logs to keep | `30` |

> `SESSION_SECRET` **must** be set in production. Without it each instance generates a
> random secret, so sessions break as soon as Cloud Run adds a second instance.

---

## 3. Build the container

The repository ships a multi-stage `Dockerfile` based on `node:22-alpine` that installs
production dependencies only (`npm ci --omit=dev`) and runs as the non-root `node` user.

```bash
docker build -t house-hunt .
docker run --rm -p 8080:8080 --env-file .env house-hunt
curl -s http://localhost:8080/healthz
```

The image intentionally contains no `db/`, `uploads/`, `tests/`, `.env`, or `.git`
directory (see `.dockerignore`).

---

## 4. Deploy to Google Cloud Run

```bash
# Build and push
gcloud builds submit \
  --tag europe-west3-docker.pkg.dev/PROJECT_ID/house-hunt/house-hunt:latest

# Deploy
gcloud run deploy house-hunt \
  --image europe-west3-docker.pkg.dev/PROJECT_ID/house-hunt/house-hunt:latest \
  --region europe-west3 \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,CLOUDFLARE_ACCOUNT_ID=...,CLOUDFLARE_D1_DATABASE_ID=...,R2_ACCOUNT_ID=...,R2_ACCESS_KEY_ID=...,R2_BUCKET_NAME=house-hunt-images,R2_PUBLIC_DOMAIN=https://images.example.com \
  --set-secrets SESSION_SECRET=session-secret:latest,CLOUDFLARE_API_TOKEN=cloudflare-api-token:latest,R2_SECRET_ACCESS_KEY=r2-secret:latest
```

Recommended Cloud Run settings:

| Setting | Value |
| --- | --- |
| Container port | `8080` |
| Startup probe | HTTP `GET /healthz` |
| Min instances | `1` (avoids cold-start database bootstrap latency) |
| Max instances | any — the app is stateless |
| CPU / memory | 1 vCPU / 512 MiB is sufficient without warm caching |
| Concurrency | 80 (default) |

Deployments can also be rolled out through **Cloud Zephyr** with the same environment
variables and secret bindings.

---

## 5. Operations notes

### Startup migrations
Every instance calls `initDb()` on boot, which runs `CREATE TABLE IF NOT EXISTS` and
idempotent column migrations against D1. Concurrent cold starts are safe: schema
creation is idempotent and seeds use `INSERT OR IGNORE`.

### Health endpoint
`GET /healthz` returns `200 {"status":"ok"}` once the schema has been verified, and
`503` while the database is unreachable or unconfigured.

### Migrating an existing Render deployment
The previous release stored everything in a SQLite file on a Render persistent disk.
To move that data:

1. Export the existing database (`sqlite3 house_hunt.sqlite .dump` or the app's JSON
   export endpoints).
2. Import the rows into D1 with `npx wrangler d1 execute house-hunt --remote --file=data.sql`.
3. Copy the files previously served from `/uploads/` into the R2 bucket
   (`npx wrangler r2 object put house-hunt-images/<filename> --file=<filename>`).
   Stored image values that are plain filenames or `/uploads/<name>` paths are resolved
   against `R2_PUBLIC_DOMAIN` automatically, so no schema change is needed.

### Scraping from a cloud IP
Property scraping may be blocked when it runs from Cloud Run datacenter IP ranges. This
app already includes demo scraping endpoints for environments where live scraping is
unreliable. Do not attempt to bypass a target site's anti-bot protections — that breaks
both the platform terms and the site's rules.
