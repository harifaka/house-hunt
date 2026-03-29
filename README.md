# House Hunt

**House Hunt** is a Node.js + Express application for tracking homes, running structured inspections, exporting reports, and exploring property opportunities in Hungarian or English.

## Features

### 🏠 House management
- Add, edit, and delete homes with address, asking price, and notes
- Track multiple houses from a single dashboard
- Review inspection progress and average scores at a glance

### ✅ Guided inspection workflow
- Run a weighted house inspection quiz by category
- Save answers as you go and continue later
- Upload photos during inspections for documentation
- Review overall and per-category results with repair cost hints

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

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for a summary of existing features and the new demo advertisement placements.

## Project structure

```text
house-hunt/
├── app.js
├── public/
├── src/
│   ├── database.js
│   ├── questions.js
│   ├── scraper.js
│   └── routes/
├── tests/
├── views/
├── DEPLOY.md
└── render.yaml
```

## License

This project is currently unlicensed.
