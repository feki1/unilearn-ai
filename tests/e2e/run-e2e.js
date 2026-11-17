import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const HARNESS_FILE = path.join(ROOT_DIR, 'tests/helpers/browserHarness.js');

const TIER_MAP = {
  '1': {
    tier: 1,
    name: 'Tier 1 — Feature Coverage (Happy Path F1–F13)',
    file: path.join(__dirname, 'tier1-feature-coverage.e2e.test.js'),
    minTests: 65
  },
  '2': {
    tier: 2,
    name: 'Tier 2 — Boundary, Corner & Negative Cases (F1–F13)',
    file: path.join(__dirname, 'tier2-boundary-corner.e2e.test.js'),
    minTests: 65
  },
  '3': {
    tier: 3,
    name: 'Tier 3 — Cross-Feature Pairwise & Multi-Feature Workflows',
    file: path.join(__dirname, 'tier3-cross-feature.e2e.test.js'),
    minTests: 15
  },
  '4': {
    tier: 4,
    name: 'Tier 4 — Real-World Student Scenarios (API + Headless Chrome)',
    file: path.join(__dirname, 'tier4-real-world-scenarios.e2e.test.js'),
    minTests: 7
  },
  '5': {
    tier: 5,
    name: 'Tier 5 — Adversarial White-Box Hardening Suite',
    file: path.join(__dirname, 'tier5-adversarial.e2e.test.js'),
    minTests: 1,
    optional: true
  }
};

function parseArgs(argv) {
  const opts = {
    tiers: [],
    filter: null,
    concurrency: 1,
    syntaxCheck: false,
    list: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--syntax-check' || arg === '--check') {
      opts.syntaxCheck = true;
    } else if (arg === '--list') {
      opts.list = true;
    } else if (arg.startsWith('--tier=')) {
      const val = arg.slice('--tier='.length).trim();
      for (const part of val.split(',')) {
        if (part.trim()) opts.tiers.push(part.trim());
      }
    } else if (arg === '--tier' && argv[i + 1]) {
      i++;
      for (const part of argv[i].split(',')) {
        if (part.trim()) opts.tiers.push(part.trim());
      }
    } else if (arg.startsWith('--filter=')) {
      opts.filter = arg.slice('--filter='.length).trim();
    } else if (arg === '--filter' && argv[i + 1]) {
      i++;
      opts.filter = argv[i].trim();
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = Math.max(1, Number(arg.slice('--concurrency='.length)) || 1);
    }
  }

  return opts;
}

function countTestsInFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const matches = src.match(/\b(?:test|it)\s*\(\s*['"`]/g);
  return matches ? matches.length : 0;
}

async function runSyntaxAndSmokeCheck() {
  console.log('=== UniLearn AI E2E Syntax, Structure & Environment Smoke Check ===');
  const filesToCheck = [HARNESS_FILE, __filename];
  for (const key of ['1', '2', '3', '4', '5']) {
    const info = TIER_MAP[key];
    if (fs.existsSync(info.file)) {
      filesToCheck.push(info.file);
    } else if (!info.optional) {
      console.error(`[FAIL] Missing required E2E tier file: ${info.file}`);
      process.exit(1);
    }
  }

  for (const file of filesToCheck) {
    const res = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`[FAIL] Syntax check failed for ${file}`);
      process.exit(res.status || 1);
    }
    console.log(`[PASS] Syntax valid: ${path.relative(ROOT_DIR, file)}`);
  }

  let totalTests = 0;
  for (const key of ['1', '2', '3', '4', '5']) {
    const info = TIER_MAP[key];
    if (!fs.existsSync(info.file)) continue;
    const count = countTestsInFile(info.file);
    totalTests += count;
    if (count < info.minTests) {
      console.error(
        `[FAIL] ${info.name} has ${count} tests, which is below minimum required (${info.minTests})`
      );
      process.exit(1);
    }
    console.log(`[PASS] ${info.name}: ${count} test cases (required >= ${info.minTests})`);
  }
  console.log(`[PASS] Total E2E Test Cases across Tiers: ${totalTests}`);

  // Smoke check harness utilities (PDF generation + pdftotext + embeddings + headless Chrome)
  const harness = await import(HARNESS_FILE);
  const sampleText = 'Horizon State University Smoke Check Token 9942';
  const pdfBuf = harness.createSamplePdfBuffer(sampleText);
  const tmpPdf = path.join(os.tmpdir(), `unilearn-smoke-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPdf, pdfBuf);
  const extracted = execFileSync('/usr/bin/pdftotext', [tmpPdf, '-'], { encoding: 'utf8' }).trim();
  fs.unlinkSync(tmpPdf);
  if (!extracted.includes('Horizon State University Smoke Check Token 9942')) {
    console.error(`[FAIL] pdftotext smoke check failed. Extracted: ${extracted}`);
    process.exit(1);
  }
  console.log('[PASS] createSamplePdfBuffer + /usr/bin/pdftotext extraction verified');

  const emb = harness.generateNormalizedEmbedding(1, 128);
  const perturbed = harness.perturbEmbedding(emb, 0.02);
  const dot = emb.reduce((acc, v, i) => acc + v * perturbed[i], 0);
  if (emb.length !== 128 || dot < 0.95) {
    console.error(`[FAIL] Embedding generator smoke check failed (dot=${dot})`);
    process.exit(1);
  }
  console.log(`[PASS] 128-d normalized face embedding generator verified (cosine similarity=${dot.toFixed(4)})`);

  const browser = await harness.launchBrowser();
  try {
    const devPage = await harness.createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 'smoke-pc-1'
    });
    await devPage.close();
    console.log('[PASS] Headless Google Chrome + puppeteer-core BrowserContext smoke check verified');
  } finally {
    await browser.close();
  }

  console.log('=== All Syntax, Test Count, and Harness Smoke Checks PASSED 100% ===');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.syntaxCheck) {
    await runSyntaxAndSmokeCheck();
    return;
  }

  const selectedKeys =
    opts.tiers.length > 0 ? opts.tiers : ['1', '2', '3', '4', '5'];

  const targetFiles = [];
  for (const key of selectedKeys) {
    const info = TIER_MAP[key];
    if (!info) {
      console.error(`Unknown tier "${key}". Supported tiers: 1, 2, 3, 4, 5`);
      process.exit(1);
    }
    if (fs.existsSync(info.file)) {
      targetFiles.push(info.file);
    } else if (!info.optional || opts.tiers.includes(key)) {
      console.error(`Required E2E test file does not exist: ${info.file}`);
      process.exit(1);
    }
  }

  if (opts.list) {
    for (const file of targetFiles) {
      console.log(`${path.relative(ROOT_DIR, file)} (${countTestsInFile(file)} tests)`);
    }
    return;
  }

  const nodeArgs = ['--test', `--test-concurrency=${opts.concurrency}`];
  if (opts.filter) {
    nodeArgs.push(`--test-name-pattern=${opts.filter}`);
  }
  nodeArgs.push(...targetFiles);

  console.log(`Running UniLearn AI E2E Suite (${targetFiles.length} tier file(s))...`);
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env }
  });

  process.exit(result.status === null ? 1 : result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
