# House Hunt

**House Hunt** is a Node.js + Express application for tracking homes, running structured inspections, exporting reports, and exploring property opportunities in Hungarian or English.

## Features

### 🏠 House management
- Add, edit, and delete homes with address, asking price, and notes
- Track multiple houses from a single dashboard
- Review inspection progress and average scores at a glance
- House card thumbnails showing the first uploaded photo

### ✅ Guided inspection workflow
- Run a weighted house inspection quiz by category
- Save answers as you go — auto-save with instant toast feedback
- Upload photos during inspections for documentation
- Attach house gallery photos directly to quiz questions
- Review overall and per-category results with repair cost hints

### 📸 Modern image management
- Full-screen lightbox viewer for photos with keyboard navigation (Esc, ← →)
- Photo gallery per house with live-updating view (10-second polling)
- Clickable thumbnails on house cards across the dashboard
- Photos are uploaded straight to Cloudflare R2 and served from a public bucket domain
- Image uploads are streamed from memory — nothing is written to the container filesystem
- EXIF/GPS data processing at application level before upload

### 👥 Team collaboration
- One server, anyone can use — cooperative inspection tool
- Inspector on the field uploads photos; office colleague fills the quiz
- Live gallery view refreshes automatically so the office user always sees the latest images
- Attach any house photo to one or more quiz questions via the image picker

### 📤 Export and reporting
- Export house data and inspection results as JSON, CSV, or PDF
- Use built-in AI analysis settings for richer property evaluation workflows

### 🤖 On-demand AI vision analysis
- Analyze every photo of a house with **DeepSeek Vision** from the House Detail page
- Analysis only runs when the user presses **🤖 Analyze Images with DeepSeek** — page views never cost API credits
- The model reports structural condition, visible damage (cracks, leaks), room state, and repair needs as markdown
- Photos are passed as public R2 URLs, so nothing extra is uploaded from the container
- Results are stored in D1 (`houses.ai_vision_notes`) and shown again on every page load

### 🔍 Property finder and market research
- Search listing URLs and generate property analysis pages
- Browse every listing photo in a full-screen viewer with next/previous buttons and arrow keys
- Add a loaded listing to Houses for a structured inspection; repeated additions reuse the same house record
- Search city information with configured AI, or Google result snippets and linked sources when AI is unavailable
- Use demo mode when live scraping or AI services are unavailable
- Review city-level market context and property details

### ⚡ Calculators
- Energy calculator for appliance consumption estimates
- Heating calculator for insulation and heat-loss based estimates

### 📖 User guide
- Interactive tutorial page covering all features, workflows, and keyboard shortcuts
- Quick-start guide, feature map, and team collaboration tips

### 🌐 Bilingual UI
- Hungarian and English interface with session-based language switching

### 💰 Advertisement-ready placements
- Shared sidebar and footer ad slots are ready for Google AdSense or direct sponsor creatives
- Demo advertisements are included so monetization placements are visible immediately after deployment

## Architecture

House Hunt is a **stateless, cloud-native** application. The Node.js process holds no
durable state, so it can run on any ephemeral container platform (Google Cloud Run,
Cloud Run via Cloud Zephyr, Kubernetes, …) and scale to zero.

| Concern | Technology | Why |
| --- | --- | --- |
| Relational data | **Cloudflare D1** over the HTTP REST API | No local `.sqlite` file, no Worker bindings — plain HTTPS calls |
| Image storage | **Cloudflare R2** (S3-compatible API) | Uploads never touch the container filesystem |
| Sessions | In-memory Express session store | Only holds the UI language preference, so nothing needs to be shared between instances |
| Static assets | Bundled into the container image | Read-only files (`views/`, `public/`, `data/`, `fonts/`) |

The database schema is created automatically on startup (`CREATE TABLE IF NOT EXISTS`
plus idempotent column migrations), so a brand-new D1 database bootstraps itself on the
first request cycle.

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v20 or later (Node 22/24 LTS recommended)
- npm
- A Cloudflare account with a D1 database and an R2 bucket

> The Jest suite uses Node's built-in `node:sqlite` module to emulate the D1 REST API,
> which requires Node.js 22.5+ (Node 24 recommended).

### Clone the repository

```bash
git clone https://github.com/harifaka/house-hunt.git
cd house-hunt
```

### Install dependencies

```bash
npm install
```

### Configure
Copy `.env.example` to `.env` and fill in the Cloudflare credentials (or export the
same variables in your shell):

```bash
cp .env.example .env
```

### Start the app

```bash
npm start
```

The app runs at `http://localhost:8080` by default (Cloud Run overrides this with `PORT`).

## Environment variables

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `PORT` | No | HTTP server port (Cloud Run sets this automatically) | `8080` |
| `NODE_ENV` | No | Environment (`production`, `development`) | `development` |
| `SESSION_SECRET` | Recommended | Session encryption secret | Random per process |
| `CLOUDFLARE_ACCOUNT_ID` | **Yes** | Cloudflare account ID holding the D1 database | — |
| `CLOUDFLARE_API_TOKEN` | **Yes** | API token with **D1 Edit** permission | — |
| `CLOUDFLARE_D1_DATABASE_ID` | **Yes** | D1 database UUID | — |
| `CLOUDFLARE_API_BASE_URL` | No | Override the Cloudflare API base URL | `https://api.cloudflare.com/client/v4` |
| `R2_ACCOUNT_ID` | **Yes** | Cloudflare account ID for R2 | — |
| `R2_ACCESS_KEY_ID` | **Yes** | R2 S3 API access key ID | — |
| `R2_SECRET_ACCESS_KEY` | **Yes** | R2 S3 API secret access key | — |
| `R2_BUCKET_NAME` | **Yes** | Bucket that stores uploaded photos | — |
| `R2_PUBLIC_DOMAIN` | Recommended | Public bucket/custom domain used for image URLs | — |
| `R2_OBJECT_KEY_PREFIX` | No | Folder prefix for uploaded objects | `house-hunt/images` |
| `R2_ENDPOINT` | No | Override the R2 S3 endpoint | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `LOG_RETENTION_DAYS` | No | Days to keep audit logs | `30` |
| `DEEPSEEK_API_KEY` | No | API key for on-demand AI vision analysis | — |
| `DEEPSEEK_BASE_URL` | No | OpenAI-compatible base URL (OpenRouter works too) | `https://api.deepseek.com/v1` |
| `DEEPSEEK_VISION_MODEL` | No | Vision-capable model used for photo analysis | `deepseek-v4-flash-vision-exp` |

The app exposes `GET /healthz` for container health checks; it returns `503` until the
D1 schema has been verified.

### AI vision analysis

`POST /api/houses/:id/analyze-vision` collects the house gallery photos, resolves them
to their public `R2_PUBLIC_DOMAIN` URLs, and sends them to the configured
OpenAI-compatible vision model. By default the DeepSeek endpoint is used; set
`DEEPSEEK_BASE_URL` to an OpenRouter-compatible URL to route elsewhere. When no
`DEEPSEEK_API_KEY` is set, the provider configured in the admin UI is used instead.

The returned markdown is saved in `houses.ai_vision_notes` and rendered on the House
Detail page. The endpoint is rate limited and maps failures to standard status codes:
`400` (no photos, or photos not publicly reachable), `404` (unknown house), `429`
(provider rate limit), `502` (provider failure or empty answer), `503` (vision not
configured) and `504` (provider timeout).

## Quality checks

```bash
npm test
npm run lint
```

## Deploy to Google Cloud Run

Cloud Run runs the container on an ephemeral filesystem — every restart wipes local
files. This app therefore keeps **all** state outside the container: structured data in
**Cloudflare D1** and images in **Cloudflare R2**.

### 1. Create the Cloudflare resources

```bash
# D1 database
npx wrangler d1 create house-hunt

# R2 bucket
npx wrangler r2 bucket create house-hunt-images

# Public access (either enable the r2.dev domain or attach a custom domain)
npx wrangler r2 bucket domain add house-hunt-images --domain images.example.com
```

Create an R2 API token (**R2 → Manage R2 API Tokens → Object Read & Write**) and a
Cloudflare API token with the **D1 Edit** permission.

### 2. Deploy

```bash
# Build and push the image (Cloud Build / Artifact Registry)
gcloud builds submit --tag europe-west3-docker.pkg.dev/PROJECT/house-hunt/house-hunt

# Deploy to Cloud Run
gcloud run deploy house-hunt \
  --image europe-west3-docker.pkg.dev/PROJECT/house-hunt/house-hunt \
  --platform managed \
  --region europe-west3 \
  --port 8080 \
  --set-env-vars NODE_ENV=production \
  --set-secrets SESSION_SECRET=session-secret:latest,CLOUDFLARE_API_TOKEN=cf-api-token:latest,R2_SECRET_ACCESS_KEY=r2-secret:latest,DEEPSEEK_API_KEY=deepseek-api-key:latest \
  --set-env-vars CLOUDFLARE_ACCOUNT_ID=...,CLOUDFLARE_D1_DATABASE_ID=...,R2_ACCOUNT_ID=...,R2_ACCESS_KEY_ID=...,R2_BUCKET_NAME=house-hunt-images,R2_PUBLIC_DOMAIN=https://images.example.com
```

Or deploy through Cloud Zephyr using the same environment variables. The container:

- builds with `npm ci --omit=dev` (no dev dependencies in the image),
- listens on `$PORT` (Cloud Run assigns it dynamically, falling back to `8080`),
- serves `/healthz` for startup/readiness probes,
- needs no volumes, disks, or write access.

### 3. Local container test

```bash
docker build -t house-hunt .
docker run --rm -p 8080:8080 --env-file .env house-hunt
curl -s http://localhost:8080/healthz
```

Additional deployment notes: [DEPLOY.md](DEPLOY.md).

## Release notes

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for a summary of features and recent changes.

## Project structure

```text
house-hunt/
├── app.js
├── Dockerfile
├── .dockerignore
├── public/
│   ├── css/style.css
│   └── js/
│       ├── app.js
│       ├── backup.js
│       ├── lightbox.js
│       ├── theme.js
│       └── toast.js
├── src/
│   ├── ai-service.js
│   ├── database.js      # Cloudflare D1 REST client + schema migrations
│   ├── image-service.js # Cloudflare R2 uploads (S3-compatible)
│   ├── logger.js
│   ├── questions.js
│   ├── scraper.js
│   └── routes/
│       ├── admin.js
│       ├── api.js
│       ├── calculators.js
│       ├── home.js
│       ├── legal.js
│       ├── property-finder.js
│       └── quiz.js
├── tests/
│   └── helpers/
│       └── d1-emulator.js
├── views/
│   ├── admin.ejs
│   ├── guide.ejs
│   ├── home.ejs
│   ├── house-detail.ejs
│   ├── property-finder.ejs
│   ├── quiz-group.ejs
│   └── partials/
├── DEPLOY.md
└── RELEASE_NOTES.md
```

## License

This project is currently unlicensed.
