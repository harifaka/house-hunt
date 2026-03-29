# Deployment Guide

This guide explains how to deploy House Hunt Helper to [Render.com](https://render.com) and other platforms.

---

## Deploy to Render.com

### Option 1: One-Click Deploy with Blueprint

The repository includes a `render.yaml` blueprint that configures everything automatically.

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New** → **Blueprint**
3. Connect your GitHub repository (`harifaka/house-hunt-helper`)
4. Render will detect the `render.yaml` and configure:
   - A **Web Service** running the Node.js app
   - A **Persistent Disk** (1 GB) mounted at `/var/data` for the SQLite database
   - Automatic `SESSION_SECRET` generation
5. Click **Apply** to deploy

### Option 2: Manual Setup

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Configure the service:

| Setting | Value |
|---|---|
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free (or your preferred plan) |

5. Add environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | *(click "Generate" for a random value)* |
| `DATABASE_PATH` | `/var/data/house_hunt.sqlite` |
| `DATABASE_URL` | *(optional external PostgreSQL connection string, e.g. Neon/Render Postgres)* |

6. Add a **Persistent Disk**:

| Setting | Value |
|---|---|
| **Name** | `house-hunt-data` |
| **Mount Path** | `/var/data` |
| **Size** | 1 GB |

7. Click **Create Web Service**

> **Important:** The persistent disk ensures your SQLite database is preserved across deploys and restarts. Without it, your data will be lost each time the service restarts.
>
> If you set `DATABASE_URL`, the app will prefer PostgreSQL instead of SQLite. It will automatically create the required tables on startup, and it will also try to create the target PostgreSQL database first when the connected user has permission to do so.

---

## Persistent Database

The application now supports two persistence modes:

1. **SQLite (default)** — controlled by `DATABASE_PATH`
2. **PostgreSQL (preferred when `DATABASE_URL` is set)** — useful for external managed databases such as Neon

### SQLite

- **Local development:** defaults to `./db/house_hunt.sqlite` (project directory)
- **Render.com:** set to `/var/data/house_hunt.sqlite` (persistent disk)

### PostgreSQL

- Set `DATABASE_URL` to your external PostgreSQL connection string
- If the URL includes `sslmode=require`, the app will enable SSL automatically
- On startup the app initializes the schema automatically
- On startup the app also attempts to create the target database if it does not exist yet and the database user has enough privileges

If `DATABASE_URL` is present, it takes precedence over `DATABASE_PATH`.

---

## Environment Variables Reference

| Variable | Required | Description | Default |
|---|---|---|---|
| `PORT` | No | HTTP server port | `3000` |
| `SESSION_SECRET` | Recommended | Secret for session encryption | Random (changes on restart) |
| `DATABASE_PATH` | No | Full path to SQLite database file (ignored when `DATABASE_URL` is set) | `./db/house_hunt.sqlite` |
| `DATABASE_URL` | No | External PostgreSQL connection string | unset |
| `NODE_ENV` | No | Environment (`production`, `development`) | `development` |

---

## CI/CD

The repository includes a GitHub Actions workflow (`.github/workflows/ci.yml`) that runs on every push and pull request to `main`:

- **Lint** — ESLint static code analysis
- **Test** — Jest test suite

Both checks must pass before merging pull requests.

---

## Other Platforms

### General Requirements

- Node.js v18+
- A writable file system path for the SQLite database
- The `npm start` command to start the server

### Docker (Example)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENV DATABASE_PATH=/data/house_hunt.sqlite
EXPOSE 3000
CMD ["npm", "start"]
```

Run with a mounted volume for data persistence:

```bash
docker build -t house-hunt-helper .
docker run -p 3000:3000 -v house-hunt-data:/data house-hunt-helper
```

### Heroku

```bash
heroku create
heroku config:set SESSION_SECRET=$(openssl rand -hex 32)
heroku config:set DATABASE_PATH=/tmp/house_hunt.sqlite
git push heroku main
```

> **Note:** Heroku's ephemeral filesystem means SQLite data will not persist across dyno restarts. Consider upgrading to a PostgreSQL add-on for production use.

---

## Scraping on Render Free Tier

If web scraping works locally but fails on Render free tier, the most common reasons are:

- the target site blocks requests from cloud/datacenter IP ranges
- the target site serves anti-bot pages to non-browser traffic
- cold starts and free-tier CPU limits make long scraping requests time out
- some sites require a full browser runtime instead of simple HTTP fetching

This app already includes **demo scraping endpoints** for environments where real scraping is unreliable.

If you need more reliable production scraping, use a compliant approach such as:

- an external managed PostgreSQL database plus the current app on Render
- a paid Render plan or another host with more stable resources
- a dedicated scraping worker/provider that allows the target site under its terms

Do **not** try to bypass Render limits or a target site's anti-bot protections. That can break platform terms or the target site's rules, and this project does not include any such bypass mechanism.
