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

6. Add a **Persistent Disk**:

| Setting | Value |
|---|---|
| **Name** | `house-hunt-data` |
| **Mount Path** | `/var/data` |
| **Size** | 1 GB |

7. Click **Create Web Service**

> **Important:** The persistent disk ensures your SQLite database is preserved across deploys and restarts. Without it, your data will be lost each time the service restarts.

---

## Persistent Database

The application uses SQLite by default. The database file location is controlled by the `DATABASE_PATH` environment variable.

- **Local development:** defaults to `./db/house_hunt.sqlite` (project directory)
- **Render.com:** set to `/var/data/house_hunt.sqlite` (persistent disk)

To migrate to a different database in the future, you only need to update `src/database.js` to use your preferred database driver and connection string.

---

## Environment Variables Reference

| Variable | Required | Description | Default |
|---|---|---|---|
| `PORT` | No | HTTP server port | `3000` |
| `SESSION_SECRET` | Recommended | Secret for session encryption | Random (changes on restart) |
| `DATABASE_PATH` | No | Full path to SQLite database file | `./db/house_hunt.sqlite` |
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
