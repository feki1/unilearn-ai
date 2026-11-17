# E2E Test Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Architecture
The **UniLearn AI** E2E test suite is a requirement-driven, opaque-box, 4-tier (+ Tier 5 adversarial) automated test suite built on Node.js v24's built-in `node:test` and `node:assert/strict` runners, native `fetch` / `WebSocket`, and pre-bundled `puppeteer-core@25.11.0` driving `/usr/bin/google-chrome` in headless mode with simulated WebRTC media streams.

- **Opaque-Box Contract Enforcement**: Tests never mutate SQLite tables directly or mock internal services. Every test interacts strictly through the public HTTP REST API (`/api/*`), Server-Sent Events (`/api/auth/sessions/events`), WebSocket (`/ws`), and the served Single-Page Application (`http://127.0.0.1:<port>/`) rendered in headless Chrome.
- **Zero External Network Dependency**: Runs 100% locally in the sandboxed environment without internet access.
- **Total Implemented E2E Test Cases**: **154 tests** across Tiers 1–4 (`65` Tier 1 + `65` Tier 2 + `16` Tier 3 + `8` Tier 4).

## 2. Directory & File Structure
```text
/home/antigravity/
├── TEST_INFRA.md                                      # E2E infrastructure & runner documentation
├── TEST_READY.md                                      # Published when Tiers 1-4 pass verification gate
└── tests/
    ├── helpers/
    │   └── browserHarness.js                          # Ephemeral app server, multi-device HTTP client, PDF/Embedding & Puppeteer harness
    └── e2e/
        ├── run-e2e.js                                 # Unified CLI runner (--tier=1|2|3|4|5, --filter, --syntax-check, --list)
        ├── tier1-feature-coverage.e2e.test.js         # Tier 1: 65 tests (5 happy-path tests x 13 features F1-F13)
        ├── tier2-boundary-corner.e2e.test.js          # Tier 2: 65 tests (5 boundary/negative tests x 13 features F1-F13)
        ├── tier3-cross-feature.e2e.test.js            # Tier 3: 16 pairwise & multi-feature integration workflows (T3-CF-01..16)
        └── tier4-real-world-scenarios.e2e.test.js     # Tier 4: 8 full-stack API + Headless Chrome (PC & Phone) scenarios (T4-SCENARIO-01..08)
```

## 3. Running the E2E Suite
- **Pre-Flight Syntax, Test Count & Harness Smoke Check**:
  ```bash
  node /home/antigravity/tests/e2e/run-e2e.js --syntax-check
  ```
- **Run All Tiers (1–4, plus Tier 5 if present)**:
  ```bash
  node /home/antigravity/tests/e2e/run-e2e.js
  ```
- **Run Specific Tier**:
  ```bash
  node /home/antigravity/tests/e2e/run-e2e.js --tier=1
  node /home/antigravity/tests/e2e/run-e2e.js --tier=2
  node /home/antigravity/tests/e2e/run-e2e.js --tier=3
  node /home/antigravity/tests/e2e/run-e2e.js --tier=4
  node /home/antigravity/tests/e2e/run-e2e.js --tier=5
  ```
- **Run Individual Test File Directly**:
  ```bash
  node --test /home/antigravity/tests/e2e/tier1-feature-coverage.e2e.test.js
  ```

## 4. Test Harness API (`tests/helpers/browserHarness.js`)
- `PERSONAS`: Deterministic seeded accounts (`amina@horizon.edu` active, `youssef@horizon.edu` expired, `sara@horizon.edu` grace_period).
- `startE2EServer(options)`: Dynamically imports `createApp` from `/home/antigravity/src/app.js` with an isolated `:memory:` SQLite database (`seed: true`) and temporary `dataDir`, binds to `127.0.0.1:0`, and returns `{ baseUrl, wsUrl, port, appInstance, dataDir, close() }`.
- `createDeviceClient(baseUrl, { deviceType: 'pc'|'phone', deviceInstanceId, deviceFingerprint, deviceLabel, token })`: Returns an opaque-box HTTP/Multipart/SSE/WebSocket client bound to a deterministic device identity (`X-Device-Type`, `X-Device-Fingerprint`, `X-Device-Instance-Id`, `X-Device-Label`, `Authorization: Bearer <token>`), exposing both `res.data` and `res.body` aliases.
- `createSamplePdfBuffer(text)`: Generates a valid PDF-1.4 binary `Buffer` extractable via `/usr/bin/pdftotext`.
- `generateNormalizedEmbedding(seed, dimensions)` & `perturbEmbedding(baseVector, noiseAmplitude)`: Generates deterministic unit-normalized 128-d biometric embedding vectors.
- `launchBrowser()`: Launches `/usr/bin/google-chrome` via `/usr/local/lib/node_modules/chrome-devtools-mcp/build/src/third_party/index.js` (`puppeteer-core@25.11.0`) with `--no-sandbox --disable-setuid-sandbox --use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
- `createDevicePage(browser, { deviceType: 'pc'|'phone', deviceInstanceId, viewport })`: Creates an isolated `BrowserContext` + `Page` pre-configured for either Desktop PC (`1280x800`) or Mobile Phone (`390x844`, mobile UA & touch).
