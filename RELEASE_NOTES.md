# Release Notes

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
