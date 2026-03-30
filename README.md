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
- Image storage ready for imgbb cloud upload (configurable in Settings)
- EXIF/GPS data processing at application level before upload

### 👥 Team collaboration
- One server, anyone can use — cooperative inspection tool
- Inspector on the field uploads photos; office colleague fills the quiz
- Live gallery view refreshes automatically so the office user always sees the latest images
- Attach any house photo to one or more quiz questions via the image picker

### 📤 Export and reporting
- Export house data and inspection results as JSON, CSV, or PDF
- Use built-in AI analysis settings for richer property evaluation workflows

### 🔍 Property finder and market research
- Search listing URLs and generate property analysis pages
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

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
- npm

### Clone the repository

```bash
git clone https://github.com/harifaka/house-hunt.git
cd house-hunt
```

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm start
```

The app runs at `http://localhost:3000` by default.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP server port | `3000` |
| `SESSION_SECRET` | Session encryption secret | Random value |
| `DATABASE_PATH` | SQLite database location | `./db/house_hunt.sqlite` |

## Quality checks

```bash
npm test
npm run lint
```

## Deployment

- Render.com blueprint: `render.yaml`
- Additional deployment notes: [DEPLOY.md](DEPLOY.md)

## Release notes

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for a summary of features and recent changes.

## Project structure

```text
house-hunt/
├── app.js
├── public/
│   ├── css/style.css
│   └── js/
│       ├── app.js
│       ├── lightbox.js
│       └── toast.js
├── src/
│   ├── database.js
│   ├── questions.js
│   ├── scraper.js
│   ├── logger.js
│   ├── ai-service.js
│   └── routes/
├── tests/
├── views/
│   ├── guide.ejs
│   ├── house-detail.ejs
│   ├── quiz-group.ejs
│   └── partials/
├── DEPLOY.md
└── render.yaml
```

## License

This project is currently unlicensed.
