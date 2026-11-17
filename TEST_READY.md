# E2E Test Suite Ready (`TEST_READY.md`)

- **Status**: **READY**
- **Track Orchestrator**: `sub_orch_e2e_track` (`af8f4d97fe36fcad37cb90a8a5e52d9e`)
- **Gate Result**: **PASS** (`2/2` Reviewers `APPROVE`, `2/2` Challengers `APPROVE`, `1/1` Forensic Auditor `CLEAN`)

## 1. E2E Suite Inventory (154 Total E2E Test Cases across F1–F13)

| Tier | File Path | Required | Implemented | Description |
|---|---|---|---|---|
| **Harness** | `/home/antigravity/tests/helpers/browserHarness.js` | 1 | **1** | Ephemeral server bootstrap (`startE2EServer`), multi-device client (`createDeviceClient`), PDF generator (`createSamplePdfBuffer`), 128-d biometric embedding generator (`generateNormalizedEmbedding`), and headless Chrome automation (`launchBrowser`, `createDevicePage`) via bundled `puppeteer-core@25.11.0`. |
| **Runner** | `/home/antigravity/tests/e2e/run-e2e.js` | 1 | **1** | Self-contained CLI runner supporting all tiers or `--tier=1|2|3|4|5`, `--filter=<pattern>`, `--list`, and `--syntax-check`. |
| **Tier 1** | `/home/antigravity/tests/e2e/tier1-feature-coverage.e2e.test.js` | `>= 65` (`>= 5` x 13) | **65** | 5 isolated happy-path E2E tests per feature across all 13 features (`F1`–`F13`, IDs `T1-F1-01`..`T1-F13-05`). |
| **Tier 2** | `/home/antigravity/tests/e2e/tier2-boundary-corner.e2e.test.js` | `>= 65` (`>= 5` x 13) | **65** | 5 isolated boundary, corner, and negative E2E tests per feature across all 13 features (`F1`–`F13`, IDs `T2-F1-01`..`T2-F13-05`). |
| **Tier 3** | `/home/antigravity/tests/e2e/tier3-cross-feature.e2e.test.js` | `>= 15` | **16** | 16 pairwise & multi-feature cross-feature E2E workflows (`T3-CF-01`..`T3-CF-16`). |
| **Tier 4** | `/home/antigravity/tests/e2e/tier4-real-world-scenarios.e2e.test.js` | `>= 7` | **8** | 8 full end-to-end real-world university student scenarios exercising REST/SSE APIs and real headless Chrome PC (`1280x800`) + Phone (`390x844`) browser contexts with fake WebRTC camera streams (`T4-SCENARIO-01`..`T4-SCENARIO-08`). |

## 2. Execution Commands for Final Milestone (M5)

```bash
# Run all E2E Tiers (1–4, plus Tier 5 when added)
node /home/antigravity/tests/e2e/run-e2e.js

# Run individual E2E Tiers
node /home/antigravity/tests/e2e/run-e2e.js --tier=1
node /home/antigravity/tests/e2e/run-e2e.js --tier=2
node /home/antigravity/tests/e2e/run-e2e.js --tier=3
node /home/antigravity/tests/e2e/run-e2e.js --tier=4

# Pre-flight syntax, test count & Chrome/PDF/Biometric smoke check
node /home/antigravity/tests/e2e/run-e2e.js --syntax-check
```
