# Release Notes

## Unreleased

### Cloud-native migration (Google Cloud Run)

- **Stateless database** — `src/database.js` now talks to **Cloudflare D1** over its HTTP REST API (`/accounts/{account}/d1/database/{database}/query`). `better-sqlite3` and `pg` were removed, and there is no local `db/` directory anymore. The schema + seed data migrate automatically on startup.
- **Stateless image storage** — `src/image-service.js` uploads photos to **Cloudflare R2** through the S3-compatible API (`@aws-sdk/client-s3`). Multer keeps files in memory, public URLs come from `R2_PUBLIC_DOMAIN`, and deleted photos are removed from the bucket.
- **Container packaging** — Added a multi-stage `Dockerfile` (`node:22-alpine`, `npm ci --omit=dev`, non-root user, `$PORT`) and a `.dockerignore`.
- **Health probe** — New `GET /healthz` endpoint for Cloud Run readiness checks.
- **Configuration** — `.env.example` documents the Cloudflare D1/R2 variables; `render.yaml` was removed.
- **Tests** — The Jest suite runs against an in-memory D1 REST emulator (`tests/helpers/d1-emulator.js`) built on Node's `node:sqlite`, so no network or Cloudflare credentials are required.

### Property Finder
- Added previous/next controls, photo count, and keyboard navigation to property listing image viewer.
- Added an action to copy a loaded listing into Houses for inspection, reusing the record when the same listing is added again.
- Added city information lookup using configured AI with a Google Search snippets fallback and visible source links.

### AI vision analysis (DeepSeek)
- New on-demand `POST /api/houses/:id/analyze-vision` endpoint sends a house's gallery photos (public R2 URLs) to a vision-capable OpenAI-compatible model.
- The analysis is stored in the new `houses.ai_vision_notes` column (idempotent migration) and rendered as formatted markdown on the House Detail page, so it survives reloads.
- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `DEEPSEEK_VISION_MODEL` configure the provider (OpenRouter-compatible). Analysis only runs when the user presses the button, so page views carry no API cost.
- Provider failures map to standard HTTP codes (`429`, `502`, `503`, `504`) and the UI reports them through the existing toast notifications.

## v1.2.0

### Highlights
- **Modern image lightbox** — Full-screen image viewer with keyboard navigation (Esc to close, ← → to navigate). Works across house gallery, quiz images, and results pages.
- **House card thumbnails** — House cards on the dashboard and houses list now show the first uploaded photo as a thumbnail for quick visual identification.
- **Quiz UX overhaul** — Notes and image buttons are properly aligned in a consistent action row. All AJAX saves (answers, notes, image uploads) now show toast notifications confirming success or failure. A per-question "Saved" indicator flashes on save.
- **Team collaboration workflow** — The app now works as a cooperative tool: an inspector on the field uploads photos to the house gallery, while an office colleague fills the quiz using the shared image picker. The house detail gallery auto-refreshes every 10 seconds with a LIVE badge.
- **Attach house photos to quiz questions** — Office users can click any house gallery photo to attach it directly to a quiz question, enabling seamless remote collaboration via video call or radio.
- **imgbb image storage preparation** — New admin settings section for configuring image storage provider (local or imgbb). Enter your imgbb API key in Settings to prepare for cloud image uploads. EXIF/GPS data is noted for application-level processing before upload.
- **Interactive user guide** — New `/guide` page with quick-start tutorial, feature map, keyboard shortcuts, team collaboration workflow tips, and quick links to all app sections. Accessible from the sidebar.
- **Updated documentation** — README and release notes updated to reflect all new features and the cooperative workflow.

### New files
- `public/js/lightbox.js` — Lightbox image viewer component
- `public/js/toast.js` — Toast notification system
- `views/guide.ejs` — User guide / tutorial page

### Changed files
- `views/house-detail.ejs` — Lightbox on gallery images, LIVE badge, auto-refresh polling, upload toast feedback
- `views/quiz-group.ejs` — Aligned action row for notes/image buttons, toast feedback on all saves, house image picker for attaching photos
- `views/quiz-results.ejs` — Lightbox on result images
- `views/home.ejs` — House card thumbnails
- `views/houses.ejs` — House card thumbnails (mobile)
- `views/admin.ejs` — Image storage settings section (local/imgbb)
- `views/partials/sidebar.ejs` — User Guide link
- `views/partials/head.ejs` — Inter font preconnect
- `views/partials/scripts.ejs` — Lightbox and toast JS includes
- `public/css/style.css` — Lightbox, toast, guide, thumbnail, live badge styles
- `src/routes/home.js` — Thumbnail query, house images API, guide route
- `src/routes/quiz.js` — House images in quiz view, attach-image endpoint
- `src/routes/admin.js` — Image storage settings save route

## v1.1.0

### Highlights
- Added reusable advertisement placements in the shared sidebar and footer.
- Filled the new placements with demo advertisements so the monetization areas are visible immediately.
- Kept the slots AdSense-ready through dedicated ad container markup and data attributes.

### Previously delivered features
- House dashboard for managing multiple properties with progress and score summaries.
- Guided inspection quiz with saved answers, weighted scoring, and photo uploads.
- House detail and results pages with category-based insights and estimated repair impact.
- Export support for JSON, CSV, and PDF downloads.
- Property Finder pages for listing analysis and demo-mode property research.
- Energy and heating calculators for running-cost estimation.
- AI analysis configuration for property evaluation workflows.
- Hungarian and English user interface support.

### Notes for monetization rollout
- Replace the demo ad cards with your Google AdSense script or direct sponsor creative when ready.
- The current placements are in shared partials, so updates appear across the application without editing each page.
