# House Hunt Helper

**House Hunt Helper** is your all-in-one toolkit for finding, planning, and swapping your dream home. Whether you're buying, selling, or renovating, this repository provides a collection of helpful resources and tools to make every step of your home journey easier and more organized.

## Features

### 🏡 Energy Planner
A helpful tool to calculate your home's energy needs, potential savings, and efficiency improvements. Make informed decisions on insulation, appliances, and energy sources to reduce costs and environmental impact.

### 📝 Technical Detail List
A comprehensive list of essential technical details to consider when evaluating potential homes. This includes things like plumbing, electrical systems, roofing, foundation, and more.

### ✅ Question List Guide & Checklist
A guide with the most important questions to ask during a house hunt and things to check before purchasing.

### 🔍 Property Finder
Search and analyze real estate listings, compare properties, and generate PDF reports with AI-powered analysis.

### 📊 Calculators
Energy and heating calculators to help evaluate running costs for potential homes.

---

## Setup & Usage

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm (comes with Node.js)

### Clone the Repository

```bash
git clone https://github.com/harifaka/house-hunt-helper.git
cd house-hunt-helper
```

### Install Dependencies

```bash
npm install
```

### Run the Application

```bash
npm start
```

The app will be available at `http://localhost:3000`.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `SESSION_SECRET` | Session encryption secret | Random value |
| `DATABASE_PATH` | Path to SQLite database file | `./db/house_hunt.sqlite` |

### Run Tests

```bash
npm test
```

### Run Linter

```bash
npm run lint
```

---

## Deployment

See [DEPLOY.md](DEPLOY.md) for deployment instructions (Render.com and other platforms).

---

## Directory Structure

```
house-hunt-helper/
├── app.js                 # Express application setup
├── render.yaml            # Render.com deployment blueprint
├── eslint.config.js       # ESLint configuration
├── src/
│   ├── database.js        # SQLite database initialization
│   ├── questions.js       # Quiz question management
│   ├── scraper.js         # Web scraper for property listings
│   └── routes/
│       ├── home.js        # Dashboard & house management
│       ├── quiz.js        # House inspection quiz
│       ├── admin.js       # Settings & admin
│       ├── api.js         # REST API & export (JSON/CSV/PDF)
│       ├── calculators.js # Energy & heating calculators
│       └── property-finder.js  # Property search & analysis
├── views/                 # EJS templates
├── public/                # Static assets (CSS, JS)
├── data/                  # Question data (JSON)
├── tests/                 # Jest test suites
└── .github/workflows/     # CI/CD pipelines
```

---

## Contributing

We welcome contributions to **House Hunt Helper**!

1. Fork the repository
2. Create your branch (`git checkout -b feature-xyz`)
3. Commit your changes (`git commit -m 'Add new feature'`)
4. Push to your branch (`git push origin feature-xyz`)
5. Create a pull request

---

## License

This project is unlicensed yet.
