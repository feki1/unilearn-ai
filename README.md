# UniLearn AI — Horizon State University

Zero-dependency Node.js 24+ app (built-in `node:sqlite`, `node:http`).

## Run locally
```bash
PORT=4100 node src/server.js   # then open http://localhost:4100
```
Requires Node >= 24. Optional: `pdftotext` (poppler) for PDFs, `ffmpeg` for MP4 videos.

## Demo accounts (password `UniPass2026!`)
- amina@horizon.edu (active) · sara@horizon.edu (grace) · youssef@horizon.edu (expired; voucher `HSU-SCHOLAR-2026`)

## Tests
```bash
npm test && node tests/e2e/run-e2e.js
```
