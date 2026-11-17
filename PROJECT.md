# Project: UniLearn AI — University Multi-Major Study, BYO-AI, Concurrent Device Security & Exam Platform

## Architecture

### 1. Stack & Environment Constraints
- **Zero-External-Install Node.js v24.22.2 Full-Stack Architecture**:
  - Outbound `registry.npmjs.org` requests return HTTP `403 Forbidden` in this sandboxed environment. Therefore, the application MUST NOT rely on `npm install` from the internet.
  - **Backend Runtime**: Node.js `v24.22.2` using built-in `node:http`, `node:sqlite` (`DatabaseSync` with FTS5 full-text search), `node:crypto` (HMAC-SHA256 tokens, password hashing, encryption at rest), `node:fs`, `node:path`, `node:child_process` (`/usr/bin/pdftotext` for PDF text extraction, `/usr/bin/ffmpeg` for MP4/WebM video rendering), and native SSE (`/api/auth/sessions/events`) + RFC 6455 WebSocket (`/ws`).
  - **SQLite Caveat**: Node's `node:sqlite` disables double-quoted string literals (`DQS_DDL`/`DQS_DML`) by default. All SQL string literals MUST use single quotes (`'active'`) or prepared statement parameters (`?` / `:param`). Always enable `PRAGMA foreign_keys = ON;`.
  - **Frontend SPA**: Self-contained Vanilla ES Modules (`src/public/index.html`, `src/public/css/styles.css`, `src/public/js/*.js`) served statically by the Node HTTP server.
  - **Testing & Browser Automation**: Built-in `node --test` (`node:test` + `node:assert/strict`) for unit, API, and E2E tests, plus pre-installed `puppeteer-core@25.11.0` imported from `/usr/local/lib/node_modules/chrome-devtools-mcp/build/src/third_party/index.js` driving `/usr/bin/google-chrome` in headless mode (`--no-sandbox --disable-setuid-sandbox --use-fake-ui-for-media-stream --use-fake-device-for-media-stream`).

### 2. Core Data Flow & Security Pipeline
1. **University Identity & Subscription Gate**:
   - Dedicated to **Horizon State University (`HSU`)** (allowed email domains: `@horizon.edu`, `@student.horizon.edu`, `@novatech.edu`). Non-university emails are rejected at registration/login with `403 UNIVERSITY_DOMAIN_NOT_ALLOWED`.
   - Every protected `/api/*` route passes through:
     - `authMiddleware`: Verifies HMAC-SHA256 signed `sessionToken` (`Authorization: Bearer <token>` or `?token=<token>`), checks `device_fingerprint_hash` & `device_type` binding, and confirms the session is `active` in `user_sessions` and `active_device_slots`. If preempted, returns `401 Unauthorized` with `{ code: "SESSION_PREEMPTED", reason: "FACIAL_AUTH_SLOT_TAKEOVER" }`. If locked by anomaly, returns `403 Forbidden` with `{ code: "BIOMETRIC_REAUTH_REQUIRED", requiresFacialAuth: true, challengeId }`.
     - `subscriptionGateMiddleware`: Verifies the student's subscription status (`active` or `grace_period`). If `expired`, `past_due`, `canceled`, or `unsubscribed`, blocks access to protected study/AI/course/slide/video/exam APIs with `402 Payment Required` (`{ code: "SUBSCRIPTION_REQUIRED" | "SUBSCRIPTION_EXPIRED" }`), while still permitting `/api/subscription/*` and `/api/auth/*`.
2. **Strict 1-PC + 1-Phone Concurrent Device Slot Registry & Facial Authentication Takeover**:
   - The `active_device_slots` table enforces `UNIQUE(student_id, device_type)` where `device_type IN ('pc', 'phone')`.
   - A subscribed student can have **at most 1 active `pc` session and 1 active `phone` session simultaneously**.
   - Opening the app on a 1st PC and 1st Phone simultaneously succeeds (`200 OK` on both).
   - Opening the app on a **2nd PC** (while `pc` slot has an active lease) or a **2nd Phone** (while `phone` slot has an active lease) returns HTTP `409 Conflict` (`{ code: "DEVICE_SLOT_CONFLICT", slotType: "pc" | "phone", requiresFacialAuth: true, challengeId, nonce, activeDevice }`).
   - **Facial Authentication & Atomic Slot Takeover**:
     - Supports both real WebRTC webcam capture (`navigator.mediaDevices.getUserMedia({ video: true })` + `<canvas>` frame extraction) AND deterministic Biometric Camera Simulator presets (`simulationPreset: "match" | "impostor"` or `liveEmbedding: number[128]`).
     - Computes cosine similarity between the student's enrolled 128-d normalized face embedding and the live candidate embedding.
     - If `cosineSimilarity >= 0.85` and liveness confirmed, executes an atomic SQLite `BEGIN IMMEDIATE` transaction that marks the challenge verified, revokes ONLY the previous session on that `target_slot_type` (`pc` or `phone`), updates `active_device_slots` (`slot_version + 1`), pushes a real-time `SESSION_PREEMPTED` event over SSE/WebSocket to the displaced device, and issues a new active `sessionToken` for the new device (leaving the other device class untouched!).

---

## Feature Inventory
Every Survey feature is assigned a milestone (none unassigned).

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | University Identity & Multi-Major Catalog | University-specific portal (`HSU` / `@horizon.edu`), hierarchical catalog (`Majors -> Subjects -> Lessons -> Files`), pre-seeded with 4+ majors (`CS`, `ECE`, `BIO`, `ECON`) and 8+ subjects with full lessons, formulas, and syllabi. | M1 | survey_1, survey_2, survey_3 |
| F2 | Course & Subject File Ingestion Engine + FTS5 Search | Multi-format course data & file ingestion (`.pdf` via `/usr/bin/pdftotext`, `.md`, `.txt`, `.json`, `.csv`), dynamic creation of majors/subjects/lessons, semantic chunking (`course_chunks`), and SQLite FTS5 (`course_chunks_fts`) BM25 full-text search with highlighted snippets. | M2 | survey_1, survey_3 |
| F3 | University Subscription Access Control Gate | Subscription lifecycle (`active`, `grace_period`, `expired`, `unsubscribed`), plan tiers (`semester_essential`, `annual_scholar`, `department_sponsored` with voucher `HSU-SCHOLAR-2026`), and `402 Payment Required` gate blocking unsubscribed students from protected study/AI routes. | M1 | survey_1, survey_2 |
| F4 | Strict 1-PC + 1-Phone Concurrent Device Enforcer | Deterministic `pc` vs `phone` classification (`X-Device-Type`, UA, viewport), HMAC-SHA256 `device_fingerprint_hash` bound into `sessionToken`, SQLite `active_device_slots` (`UNIQUE(student_id, device_type)`), 15s heartbeat (`POST /api/auth/sessions/heartbeat`), SSE/WS real-time push (`GET /api/auth/sessions/events`), and `409 DEVICE_SLOT_CONFLICT` when a 2nd PC or 2nd Phone connects. | M1 | survey_1, survey_2 |
| F5 | Facial Authentication & Atomic Device Slot Takeover | 128-d normalized face embedding enrollment (`POST /api/auth/biometrics/enroll`), challenge creation on 2nd-PC/2nd-Phone conflict or mid-session security anomaly (`POST /api/auth/sessions/report-anomaly`), dual-mode verification (WebRTC webcam + deterministic `match`/`impostor` simulator), cosine similarity ($\ge 0.85$) check, and atomic preemption of old `pc` or `phone` session (`POST /api/auth/biometrics/verify-and-takeover`). | M1 | survey_1, survey_2 |
| F6 | Built-In University AI Tutor & RAG Engine | Out-of-the-box University AI assistant grounded in FTS5-retrieved course chunks and lesson formulas, providing cited explanations, step-by-step derivations, and quick study actions. | M2 | survey_1, survey_3 |
| F7 | Bring-Your-Own-AI (BYO-AI) Multi-Provider Hub | Student configuration and switching across `built_in`, `gemini`, `claude`, `kimi`, `kiro`, `openai`, and `custom` endpoints (`POST /api/ai/providers`), masked API key storage (`api_key_masked`), connectivity test (`POST /api/ai/providers/:id/test`), and dual-mode execution (Live HTTP adapter + deterministic course-grounded RAG synthesis). | M2 | survey_1, survey_3 |
| F8 | Student Chat File Uploads & Contextual Attachments | Direct file upload into AI conversations (`POST /api/ai/conversations/:id/files` and `POST /api/ai/files/upload`), extracting text from PDF/MD/TXT/CSV/JSON so any selected AI provider (`built_in`, `gemini`, `claude`, `kimi`, `kiro`, etc.) answers questions grounded in both student-uploaded files and university course data. | M2 | survey_1, survey_3 |
| F9 | Interactive Slide Deck Generator & Lesson Presenter | Generates 6–10 structured slides per deck from any lesson, uploaded file, or topic (`POST /api/slides/generate`) with layouts (`title_overview`, `core_concept`, `visual_diagram` with SVG flowcharts/diagrams, `formula_derivation`, `checkpoint_quiz`, `exam_takeaways`), speaker notes, keyboard/button navigation, and embedded interactive quiz checkpoints. | M3 | survey_1, survey_3 |
| F10 | Deep Academic Research & Data Collection Engine | Executes topic research across course repositories and uploaded files (`POST /api/research/run`), extracts structured quantitative/comparative data tables (`collectedDataTable` with columns & rows), provides cited synthesis reports, supports student notes, and exports CSV/JSON/Markdown (`GET /api/research/:id/export`). | M3 | survey_1, survey_3 |
| F11 | AI Educational Video Generator & Interactive Player | Generates playable multi-scene educational videos (`POST /api/videos/generate`) with timed scenes, animated HTML5 Canvas/SVG visual diagrams, Web Speech API narration, synchronized captions, timeline scrubbing, speed controls, clickable transcript, AND real playable `.mp4` rendering via `/usr/bin/ffmpeg` (`GET /api/videos/:id/stream` / `GET /api/videos/:id/render`). | M3 | survey_1, survey_3 |
| F12 | Exam Preparation Suite (Quizzes, SM-2 Flashcards, Timed Mock Exams & Study Guides) | Practice quizzes with instant grading & explanations, SM-2 spaced-repetition flashcards (`POST /api/exam-prep/flashcards/:id/review`), timed mock exams with countdown timer and per-topic weakness analytics (`POST /api/exam-prep/exams/:id/submit`), and structured high-yield exam study guides (`POST /api/exam-prep/study-guides/generate`). | M3 | survey_1, survey_3 |
| F13 | Responsive Full-Stack Web Application UI (PC & Phone Adaptive Views) | Unified SPA (`src/public/`) integrating Auth & University Subscription Portal, Live 1-PC + 1-Phone Device Status Bar, Webcam/Simulated Facial Auth Takeover Modal, Preempted Session Lock Screen, Course & File Ingestion Hub, BYO-AI Chat Hub with File Upload, Interactive Slide Presenter, Research & Video Studio, and Exam Prep Center. | M4 | survey_1, survey_2, survey_3 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Server, SQLite Schema & University Seed, Subscription Gate, Strict 1-PC + 1-Phone Enforcer & Facial Auth | `package.json`, `src/config.js`, `src/db/connection.js`, `src/db/schema.js`, `src/db/seed.js`, `src/middleware/*`, `src/modules/auth-security/*`, `src/server.js`, `src/app.js`, and unit/API tests (`tests/api/subscription-device-facial.test.js`). | none | DONE (`22/22` tests passing, Gate PASS, Auditor CLEAN) |
| M2 | Course & File Ingestion Engine (FTS5) + Built-In & BYO-AI Multi-Provider Hub (Gemini, Claude, Kimi, Kiro, OpenAI, Custom) with File Uploads | `src/modules/catalog/*`, `src/modules/ai-hub/*`, `data/seed_files/*`, and unit/API tests (`tests/api/catalog-ingestion.test.js`, `tests/api/ai-hub-uploads.test.js`). | M1 (DB schema & middleware contracts) | IN_PROGRESS (`15c07820a60b083713c432d2b9547102`) |
| M3 | Interactive Slide Deck Generator, Deep Research & Data Collector, AI Video Generator (Storyboard + FFmpeg MP4), and Exam Prep Suite | `src/modules/learning-studio/*`, `src/modules/research-media/*`, and unit/API tests (`tests/api/slides-exams-research-video.test.js`). | M1, M2 (DB schema & catalog/RAG services) | IN_PROGRESS (`836c6b20331b2772eba21c3ce205cb7c`) |
| M4 | Full-Stack Responsive Frontend SPA & Real-Time Multi-Device Integration | `src/public/index.html`, `src/public/css/styles.css`, `src/public/js/*` (all 7 interactive views + SSE/WebSocket live session preemption + Webcam/Simulator Facial Auth Modal + responsive PC/Phone layout) and integration tests (`tests/api/frontend-integration.test.js`). | M1, M2, M3 | PLANNED |
| M5 | Final Milestone: Phase 1 (Pass 100% E2E Tests Tiers 1–4) & Phase 2 (Tier 5 Adversarial Coverage Hardening) | Execute full E2E test suite (`TEST_READY.md`) across Tiers 1–4 until 100% pass, followed by Phase 2 white-box Challenger → Worker → Reviewer adversarial hardening loop. | M1, M2, M3, M4 + `TEST_READY.md` | PLANNED |

*(Note: The **E2E Testing Orchestrator** (`af8f4d97fe36fcad37cb90a8a5e52d9e`) has **COMPLETED** the E2E Testing Track (`Gate Result: **PASS**`, Auditor `CLEAN`), delivering `154` E2E test cases across Tiers 1–4 in `tests/e2e/` and publishing `/home/antigravity/TEST_READY.md`.)*

---

## Code Layout

```text
/home/antigravity/
├── package.json
├── PROJECT.md
├── TEST_INFRA.md
├── TEST_READY.md
├── src/
│   ├── config.js
│   ├── server.js
│   ├── app.js
│   ├── db/
│   │   ├── connection.js
│   │   ├── schema.js
│   │   └── seed.js
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── subscriptionGate.js
│   │   └── deviceGuard.js
│   ├── modules/
│   │   ├── auth-security/
│   │   │   ├── authService.js
│   │   │   ├── subscriptionService.js
│   │   │   ├── deviceSessionService.js
│   │   │   ├── facialAuthService.js
│   │   │   ├── realtimeHub.js
│   │   │   └── securityRoutes.js
│   │   ├── catalog/
│   │   │   ├── catalogService.js
│   │   │   ├── ingestionService.js
│   │   │   └── catalogRoutes.js
│   │   ├── ai-hub/
│   │   │   ├── providerRegistry.js
│   │   │   ├── ragEngine.js
│   │   │   ├── chatService.js
│   │   │   └── aiHubRoutes.js
│   │   ├── learning-studio/
│   │   │   ├── slideGeneratorService.js
│   │   │   ├── examPrepService.js
│   │   │   └── learningRoutes.js
│   │   └── research-media/
│   │       ├── researchService.js
│   │       ├── videoGeneratorService.js
│   │       └── mediaRoutes.js
│   └── public/
│       ├── index.html
│       ├── css/
│       │   └── styles.css
│       └── js/
│           ├── app.js
│           ├── api.js
│           └── components/
│               ├── authSubscriptionView.js
│               ├── deviceFacialModal.js
│               ├── catalogIngestionView.js
│               ├── aiChatByoView.js
│               ├── slidePresenterView.js
│               ├── examStudioView.js
│               └── researchVideoView.js
├── data/
│   ├── seed_files/
│   ├── uploads/
│   └── videos/
└── tests/
    ├── helpers/
    │   ├── testServer.js
    │   └── browserHarness.js
    ├── api/
    │   ├── subscription-device-facial.test.js
    │   ├── catalog-ingestion.test.js
    │   ├── ai-hub-uploads.test.js
    │   ├── slides-exams-research-video.test.js
    │   └── frontend-integration.test.js
    └── e2e/
        ├── run-e2e.js
        ├── tier1-feature-coverage.e2e.test.js
        ├── tier2-boundary-corner.e2e.test.js
        ├── tier3-cross-feature.e2e.test.js
        ├── tier4-real-world-scenarios.e2e.test.js
        └── tier5-adversarial.e2e.test.js
```

---

## Interface Contracts

### 1. Server Bootstrap & Test Harness Contract (`src/app.js` & `src/server.js`)
- `createApp({ dbPath = ':memory:', dataDir = '/home/antigravity/data', seed = true })`:
  - Initializes SQLite database via `node:sqlite` (`DatabaseSync`), runs `schema.js` and `seed.js` (if `seed === true`), mounts all routes (`/api/auth/*`, `/api/subscription/*`, `/api/subscriptions/*`, `/api/devices/*`, `/api/security/*`, `/api/catalog/*`, `/api/ai/*`, `/api/slides/*`, `/api/learning/*`, `/api/research/*`, `/api/videos/*`, `/api/media/*`, `/api/exam-prep/*`), and serves static frontend files from `src/public/`.
  - Returns `{ app, server, db, close() }` so automated tests can start an isolated HTTP server on an ephemeral port (`server.listen(0, '127.0.0.1')`).
- `npm start` / `node src/server.js`:
  - Listens on `process.env.PORT || 3000` (`127.0.0.1` / `0.0.0.0`).
- `GET /api/health`:
  - Returns `200 OK` `{ status: "ok", university: "Horizon State University", code: "HSU" }`.

### 2. Pre-Seeded University Personas (`src/db/seed.js`)
The seed script MUST populate these exact deterministic student accounts (plus 4 majors `CS`, `ECE`, `BIO`, `ECON` and 8 subjects `CS-301`, `CS-402`, `CS-450`, `ECE-210`, `ECE-340`, `BIO-205`, `ECON-201`, `FIN-320`):
1. **Active Subscribed Student**:
   - `email`: `'amina@horizon.edu'`, `studentNumber`: `'HSU-2026-0101'`, `password`: `'UniPass2026!'`
   - `subscription.status`: `'active'`, `planId`: `'annual_scholar'`
   - `biometrics`: Enrolled 128-d normalized vector (`enrolled: true`, deterministic seed vector where unit vector `[1/sqrt(128), ...]` or helper `getEnrolledEmbedding('amina@horizon.edu')` yields cosine similarity `>= 0.95` on `'match'` preset and `< 0.30` on `'impostor'` preset).
2. **Expired / Unsubscribed Student**:
   - `email`: `'youssef@horizon.edu'`, `studentNumber`: `'HSU-2026-0102'`, `password`: `'UniPass2026!'`
   - `subscription.status`: `'expired'`, `planId`: `'semester_essential'`
   - `biometrics`: Enrolled 128-d normalized vector.
3. **Grace Period Student**:
   - `email`: `'sara@horizon.edu'`, `studentNumber`: `'HSU-2026-0103'`, `password`: `'UniPass2026!'`
   - `subscription.status`: `'grace_period'`, `planId`: `'semester_essential'`
   - `biometrics`: Enrolled 128-d normalized vector.

### 3. Auth, Subscription, 1-PC + 1-Phone Device Slot & Facial Auth Contracts (`M1`)
- **`POST /api/auth/register`**:
  - Body: `{ email, studentNumber?, fullName, password, majorId?, planId?, faceEmbedding? }`
  - Rejects emails not ending in `@horizon.edu`, `@student.horizon.edu`, or `@novatech.edu` with `403 Forbidden` `{ error: "...", code: "UNIVERSITY_DOMAIN_NOT_ALLOWED" }`.
  - Creates student, subscription (`status: planId ? 'active' : 'unsubscribed'`), and optional initial face embedding. Returns `201 Created`.
- **`POST /api/auth/login`**:
  - Body: `{ email, password, deviceType?: 'pc' | 'phone', deviceInstanceId?: string, deviceFingerprint?: string, deviceLabel?: string }` (also checks `X-Device-Type` and `X-Device-Fingerprint` headers; defaults `deviceType` via UA/viewport heuristic to `'pc'` or `'phone'`).
  - If password invalid -> `401 Unauthorized` `{ code: "INVALID_CREDENTIALS" }`.
  - Checks `active_device_slots` for `(student_id, device_type)` where `lease_expires_at > now` and `status = 'active'`:
    - If slot is empty OR occupied by the SAME `device_fingerprint_hash`: acquires/renews slot (`slot_version`), creates/updates `user_sessions`, and returns `200 OK`:
      ```json
      {
        "authenticated": true,
        "requiresFacialAuth": false,
        "sessionToken": "<signed_token>",
        "token": "<signed_token>",
        "student": { "id": "...", "email": "...", "fullName": "...", "studentNumber": "...", "majorId": "..." },
        "subscription": { "status": "active", "planId": "annual_scholar" },
        "slot": { "deviceType": "pc", "deviceFingerprintHash": "...", "deviceLabel": "...", "slotVersion": 1 },
        "activeSlots": { "pc": { ... }, "phone": null }
      }
      ```
      *(Note: Login itself succeeds even for `expired`/`unsubscribed` students so they receive a token to view the Subscription Portal and call `/api/subscription/activate`, while all protected study/AI routes return `402 Payment Required` until their subscription is `active` or `grace_period`.)*
    - If slot for `deviceType` (`'pc'` or `'phone'`) is currently occupied by a DIFFERENT `device_fingerprint_hash`:
      - Does NOT displace the existing device yet. Creates a `biometric_challenges` record (`reason: deviceType === 'pc' ? 'SECOND_PC_CONFLICT' : 'SECOND_PHONE_CONFLICT'`) and returns `409 Conflict`:
        ```json
        {
          "authenticated": false,
          "code": "DEVICE_SLOT_CONFLICT",
          "slotType": "pc",
          "requiresFacialAuth": true,
          "challengeId": "chal_...",
          "nonce": "...",
          "activeDevice": { "deviceType": "pc", "deviceLabel": "...", "lastHeartbeatAt": "..." },
          "message": "Your account is already open on another PC. Complete Facial Authentication to transfer your PC slot to this device."
        }
        ```
- **`POST /api/auth/logout`**:
  - Releases the caller's active `pc` or `phone` slot in `active_device_slots` and marks `user_sessions.status = 'logged_out'`. Returns `200 OK` `{ slotReleased: true }`.
- **`GET /api/auth/sessions/status`** (alias `GET /api/auth/me` and `GET /api/devices/active`):
  - Returns `200 OK` `{ student, subscription, currentSession, slots: { pc: {...}|null, phone: {...}|null }, biometricEnrolled: boolean }`.
- **`POST /api/auth/sessions/heartbeat`** (alias `POST /api/devices/heartbeat`):
  - Verifies session is still `active` and `device_fingerprint_hash` matches. Extends `lease_expires_at` by +60s.
  - If session was preempted by facial auth on another device -> returns `401 Unauthorized` `{ code: "SESSION_PREEMPTED", reason: "FACIAL_AUTH_SLOT_TAKEOVER", slotType }`.
  - If session is locked due to anomaly -> returns `403 Forbidden` `{ code: "BIOMETRIC_REAUTH_REQUIRED", requiresFacialAuth: true, challengeId }`.
- **`GET /api/auth/sessions/events`**:
  - SSE stream (`Content-Type: text/event-stream`) emitting `event: session_preempted` or `event: anomaly_locked` in real time.
- **`POST /api/auth/sessions/report-anomaly`**:
  - Body: `{ reason?: string }`. Locks the current active slot (`status = 'locked_pending_biometric'`), generates a `biometric_challenges` row (`reason: 'SESSION_ANOMALY_REVERIFY'`), and returns `200 OK` `{ locked: true, code: "BIOMETRIC_REAUTH_REQUIRED", requiresFacialAuth: true, challengeId, nonce }`.
- **`POST /api/auth/biometrics/enroll`** (alias `POST /api/security/facial/enroll`):
  - Body: `{ faceEmbedding?: number[128], descriptor?: number[], captureMode?: 'webcam' | 'simulated', referenceImage?: string }`.
  - Normalizes and stores the 128-d face embedding in `student_biometrics`. Returns `200 OK` `{ enrolled: true, dimensions: 128, threshold: 0.85 }`.
- **`POST /api/auth/biometrics/challenge`**:
  - Body: `{ email?, targetSlotType: 'pc' | 'phone', deviceInstanceId?, deviceLabel?, reason? }`. Creates and returns a fresh `challengeId` and `nonce` (`201 Created`).
- **`POST /api/auth/biometrics/verify-and-takeover`** (alias `POST /api/security/facial/verify`):
  - Body: `{ challengeId, nonce?, liveEmbedding?: number[128], descriptor?: number[], simulationPreset?: 'match' | 'impostor', livenessConfirmed?: boolean }`.
  - Computes cosine similarity against the student's enrolled 128-d vector (if `simulationPreset === 'match'`, generates a perturbed vector from the enrolled embedding with similarity $\approx 0.96$; if `simulationPreset === 'impostor'`, generates an orthogonal/contrasting vector with similarity $\approx 0.21$; if `liveEmbedding`/`descriptor` array is passed, computes exact cosine similarity).
  - If `livenessConfirmed === false` or `similarityScore < 0.85`: marks challenge failed, leaves existing active device slot untouched, and returns `403 Forbidden` `{ verified: false, code: "BIOMETRIC_VERIFICATION_FAILED", similarityScore }`.
  - If `similarityScore >= 0.85`: runs atomic `BEGIN IMMEDIATE` transaction revoking the old session on `target_slot_type` (`pc` or `phone`), assigning `active_device_slots(student_id, target_slot_type)` to the new device, pushing `SESSION_PREEMPTED` over SSE/WS to the old session, and returning `200 OK`:
    ```json
    {
      "verified": true,
      "similarityScore": 0.96,
      "sessionToken": "<new_signed_token>",
      "token": "<new_signed_token>",
      "preemptedSessionId": "sess_...",
      "slot": { "deviceType": "pc", "deviceLabel": "...", "slotVersion": 2 },
      "activeSlots": { "pc": { ... }, "phone": { ... } }
    }
    ```
- **Subscription Endpoints**:
  - `GET /api/subscription/status` (alias `GET /api/subscriptions/status`): Returns student subscription state and available plans.
  - `POST /api/subscription/activate` (alias `POST /api/subscriptions/subscribe`): Body `{ planId, paymentMethod?, voucherCode? }`. Validates voucher `HSU-SCHOLAR-2026` (if `department_sponsored`) or payment method, sets `status = 'active'`, and returns `200 OK` `{ status: "active", subscription }`.
  - `POST /api/subscription/simulate-state` (alias `POST /api/subscriptions/cancel`): Body `{ studentId?, status: 'active' | 'grace_period' | 'expired' | 'unsubscribed' | 'canceled' }`. Updates subscription status for deterministic testing.

### 4. Course Catalog & File Ingestion Contracts (`M2`)
*(All routes below require `authMiddleware` + `subscriptionGateMiddleware`)*
- `GET /api/catalog/majors` -> `{ majors: [...] }` (4+ pre-seeded majors with subject/lesson/file counts).
- `POST /api/catalog/majors` -> Body `{ code, name, faculty, description }` -> `201 Created` `{ major }`.
- `GET /api/catalog/subjects?majorId=&q=` -> `{ subjects: [...] }`.
- `POST /api/catalog/subjects` -> Body `{ majorId, code, title, semester, credits, instructor, syllabusSummary }` -> `201 Created` `{ subject }`.
- `GET /api/catalog/subjects/:subjectId` -> `{ subject, lessons: [...], files: [...], slideDecks: [...], videos: [...], exams: [...] }`.
- `POST /api/catalog/subjects/:subjectId/lessons` -> Body `{ moduleNumber, title, summary, contentMarkdown, keyConcepts }` -> chunks & indexes into FTS5 -> `201 Created` `{ lesson, chunksCreated }`.
- `GET /api/catalog/lessons/:lessonId` -> `{ lesson, subject, files, chunks }`.
- `POST /api/catalog/files/upload` (alias `POST /api/catalog/ingest`) -> Supports both JSON `{ majorId, subjectId, lessonId?, filename, mimeType?, contentText?, contentBase64? }` and `multipart/form-data`. Extracts text (using `/usr/bin/pdftotext` for PDFs or UTF-8 text parser for MD/TXT/CSV/JSON), splits into chunks in `course_chunks`, indexes into `course_chunks_fts`, and returns `201 Created` `{ file, chunksCreated, extractedTopics }`.
- `GET /api/catalog/files?subjectId=&majorId=` -> `{ files: [...] }`.
- `GET /api/catalog/files/:fileId` -> `{ file, chunks: [...] }`.
- `GET /api/catalog/search?q=&majorId=&subjectId=&limit=20` -> Searches `course_chunks_fts` (with LIKE fallback for special characters) and returns `{ results: [{ chunkId, subjectId, lessonId, fileId, sourceType, sourceTitle, heading, snippet, content, score }] }`.

### 5. Built-In AI & BYO-AI Multi-Provider Hub + Chat File Uploads Contracts (`M2`)
- `GET /api/ai/providers` -> Returns `{ supportedProviders: ['built_in', 'gemini', 'claude', 'kimi', 'kiro', 'openai', 'custom'], configuredProviders: [...] }` (all saved keys masked as `api_key_masked`, never raw keys).
- `POST /api/ai/providers` -> Body `{ providerType, displayName, modelName, baseUrl?, apiKey, executionMode?: 'auto'|'live'|'local_rag', temperature?, isDefault? }`. Encrypts `apiKey` at rest, computes `apiKeyMasked`, upserts config, returns `201 Created` `{ provider }`.
- `PUT /api/ai/providers/:providerId` -> Updates provider config, returns `200 OK` `{ provider }`.
- `DELETE /api/ai/providers/:providerId` -> Deletes provider config (`built_in` cannot be deleted), returns `200 OK` `{ deleted: true }`.
- `POST /api/ai/providers/:providerId/test` -> Tests provider configuration (if `executionMode === 'live'` with reachable local/remote URL, makes HTTP call; otherwise validates config & local RAG readiness) -> returns `200 OK` `{ status: 'ok', providerType, modelName, executionMode, sampleResponse }`.
- `GET /api/ai/conversations?subjectId=` (alias `GET /api/ai/chat/threads`) -> `{ conversations: [...] }`.
- `POST /api/ai/conversations` (alias `POST /api/ai/chat/threads`) -> Body `{ title?, majorId?, subjectId?, lessonId?, providerConfigId?, providerType? }` -> `201 Created` `{ conversation }`.
- `GET /api/ai/conversations/:conversationId` -> `{ conversation, messages: [...], files: [...] }`.
- `POST /api/ai/conversations/:conversationId/files` (alias `POST /api/ai/files/upload`) -> Body `{ filename, mimeType?, contentText?, contentBase64?, conversationId? }` or `multipart/form-data`. Extracts text from uploaded file, stores in `ai_chat_files` (and indexes chunks), returns `201 Created` `{ chatFile }`.
- `POST /api/ai/conversations/:conversationId/messages` (alias `POST /api/ai/chat/messages`) -> Body `{ content, providerConfigId?, providerType?, attachedFileIds?: string[], includeCourseContext?: boolean }`. Retrieves top FTS5 course chunks + attached chat file contents, routes through selected provider (`built_in`, `gemini`, `claude`, `kimi`, `kiro`, `openai`, `custom`), persists user & assistant messages with `citations` and `attachedFilesUsed`, and returns `201 Created`:
  ```json
  {
    "userMessage": { ... },
    "assistantMessage": {
      "id": "...",
      "role": "assistant",
      "content": "...",
      "providerType": "kimi",
      "modelName": "moonshot-v1-128k",
      "executionMode": "course_grounded_rag",
      "citations": [ ... ],
      "attachedFilesUsed": [ ... ]
    }
  }
  ```

### 6. Interactive Slide Generator, Deep Research & Data Collection, AI Video Studio & Exam Prep Contracts (`M3`)
- **Interactive Slides (`/api/slides/*` & `/api/learning/slides/*`)**:
  - `GET /api/slides?subjectId=&lessonId=` -> `{ slideDecks: [...] }`.
  - `POST /api/slides/generate` (alias `POST /api/learning/slides/generate`) -> Body `{ subjectId, lessonId?, fileId?, customTopic?, slideCount?: number, theme?, providerType? }`. Generates 6–10 structured slides (`title_overview`, `core_concept`, `visual_diagram` with `diagramSpec` + `diagramSvg`, `formula_derivation`, `real_world_application`, `checkpoint_quiz`, `exam_takeaways`) grounded in the subject/lesson/file content. Returns `201 Created` `{ deck }`.
  - `GET /api/slides/:deckId` (alias `GET /api/learning/slides/:deckId`) -> `{ deck }`.
  - `PUT /api/slides/:deckId` -> Updates slide deck title, theme, or slides array -> `200 OK` `{ deck }`.
  - `DELETE /api/slides/:deckId` -> `200 OK` `{ deleted: true }`.
- **Deep Research & Data Collection (`/api/research/*`)**:
  - `GET /api/research?subjectId=&majorId=` (alias `GET /api/research/projects`) -> `{ projects: [...] }`.
  - `POST /api/research/run` -> Body `{ query, title?, majorId?, subjectId?, includeUploadedFiles?: boolean, providerType? }`. Searches FTS5 course chunks & uploaded files, synthesizes structured `sections`, extracts a quantitative `collectedDataTable` (`{ title, columns, rows, unitNotes }`), maps `citations`, persists in `research_projects`, and returns `201 Created` `{ project }`.
  - `GET /api/research/:researchId` -> `{ project }`.
  - `PUT /api/research/:researchId/notes` -> Body `{ studentNotes?, additionalRows?: object[] }` -> `200 OK` `{ project }`.
  - `GET /api/research/:researchId/export?format=csv|json|md` -> Returns downloadable CSV, JSON, or Markdown representation of the research project and collected data table.
- **AI Educational Video Studio (`/api/videos/*` & `/api/media/videos/*`)**:
  - `GET /api/videos?subjectId=&lessonId=` -> `{ videos: [...] }`.
  - `POST /api/videos/generate` (alias `POST /api/media/videos/generate`) -> Body `{ subjectId, lessonId?, researchId?, topicPrompt, targetDurationSec?: number, styleTheme?, renderMp4?: boolean }`. Generates a multi-scene educational video (`scenes` array with timed `narrationText`, `captions`, `visualScene` spec for animated Canvas/SVG rendering, `transcript`, `keyTakeaways`) AND synthesizes a real playable `.mp4` file via `/usr/bin/ffmpeg` in `data/videos/<id>.mp4`. Returns `201 Created` `{ video }`.
  - `GET /api/videos/:videoId` -> `{ video }`.
  - `GET /api/videos/:videoId/stream` (alias `GET /api/videos/:videoId/render` and `GET /api/media/videos/:videoId/stream`) -> Streams the generated `.mp4` video file (`Content-Type: video/mp4`, supporting HTTP `200 OK` and `206 Partial Content` range requests; generates on-demand via `ffmpeg` if not yet cached on disk).
- **Exam Preparation Suite (`/api/exam-prep/*` & `/api/learning/exams/*`)**:
  - `GET /api/exam-prep/overview?subjectId=` -> `{ readinessScore, flashcardStats, recentAttempts, weakTopics, studyGuides }`.
  - `GET /api/exam-prep/flashcards?subjectId=&dueOnly=false` -> `{ flashcards: [...] }`.
  - `POST /api/exam-prep/flashcards/generate` -> Body `{ subjectId, lessonId?, fileId?, count?: number }` -> Generates flashcards from course content -> `201 Created` `{ flashcards: [...] }`.
  - `POST /api/exam-prep/flashcards/:cardId/review` -> Body `{ quality: 0 | 1 | 2 | 3 }`. Applies SM-2 spaced repetition algorithm (`easeFactor`, `intervalDays`, `repetitions`, `masteryLevel`, `nextReviewAt`) -> `200 OK` `{ flashcard }`.
  - `GET /api/exam-prep/exams?subjectId=&mode=` -> `{ exams: [...] }`.
  - `POST /api/exam-prep/exams/generate` (alias `POST /api/learning/exams/generate`) -> Body `{ subjectId, lessonId?, mode?: 'practice_quiz' | 'timed_mock_exam', difficulty?: 'intro' | 'intermediate' | 'exam_hard', questionCount?: number, timeLimitSec?: number }` -> `201 Created` `{ exam }`.
  - `GET /api/exam-prep/exams/:examId` -> `{ exam }`.
  - `POST /api/exam-prep/exams/:examId/submit` (alias `POST /api/learning/exams/:examId/submit`) -> Body `{ answers: Record<string, any>, durationUsedSec?: number }`. Grades all questions, computes `percentage`, `letterGrade`, `topicBreakdown`, and `weaknessRecommendations` (linking weak topics to lessons/slides/videos), saves in `exam_attempts`, and returns `201 Created` `{ attempt }`.
  - `GET /api/exam-prep/attempts?subjectId=` -> `{ attempts: [...] }`.
  - `POST /api/exam-prep/study-guides/generate` -> Body `{ subjectId, focusWeakTopics?: boolean }` -> `201 Created` `{ studyGuide }`.
  - `GET /api/exam-prep/study-guides?subjectId=` -> `{ studyGuides: [...] }`.
