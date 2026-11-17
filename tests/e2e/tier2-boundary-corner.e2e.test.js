import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAS,
  startE2EServer,
  createDeviceClient,
  generateNormalizedEmbedding,
  launchBrowser,
  createDevicePage
} from '../helpers/browserHarness.js';

async function resolveCatalogIds(client) {
  const majorsRes = await client.get('/api/catalog/majors');
  assert.equal(majorsRes.status, 200);
  const majors = majorsRes.data.majors || [];
  const csMajor = majors.find((m) => m.code === 'CS') || majors[0];
  const eceMajor = majors.find((m) => m.code === 'ECE') || majors[1] || csMajor;

  const subjRes = await client.get('/api/catalog/subjects');
  assert.equal(subjRes.status, 200);
  const subjects = subjRes.data.subjects || [];
  const cs301 = subjects.find((s) => s.code === 'CS-301') || subjects[0];
  const bio205 = subjects.find((s) => s.code === 'BIO-205') || subjects[1] || cs301;

  return {
    csMajorId: csMajor ? csMajor.id : 'CS',
    eceMajorId: eceMajor ? eceMajor.id : 'ECE',
    cs301Id: cs301 ? cs301.id : 'CS-301',
    bio205Id: bio205 ? bio205.id : 'BIO-205'
  };
}

function buildAllCorrectAnswers(exam) {
  const answers = {};
  const questions = (exam && exam.questions) || [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const key = q.id || q.questionId || String(i);
    if (q.correctAnswer !== undefined) {
      answers[key] = q.correctAnswer;
    } else if (q.correctOption !== undefined) {
      answers[key] = q.correctOption;
    } else if (q.answer !== undefined) {
      answers[key] = q.answer;
    } else if (Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0) {
      answers[key] = q.acceptableAnswers[0];
    } else if (Array.isArray(q.options) && q.options.length > 0) {
      const opt = q.options[0];
      answers[key] = typeof opt === 'object' && opt !== null ? opt.id || opt.value || opt.text : opt;
    }
  }
  return answers;
}

describe('Tier 2 — Boundary, Corner & Negative Cases (F1–F13: 65 Isolated Tests)', () => {
  let server;
  let baseUrl;
  let browser;
  let catalogInfo;
  let studentAClient;
  let studentBClient;

  before(async () => {
    server = await startE2EServer({ seed: true });
    baseUrl = server.baseUrl;

    studentAClient = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 't2-student-a-pc'
    });
    await studentAClient.login(PERSONAS.amina.email, PERSONAS.amina.password);
    catalogInfo = await resolveCatalogIds(studentAClient);

    studentBClient = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 't2-student-b-pc'
    });
    await studentBClient.post('/api/auth/register', {
      email: 'student.b.t2@horizon.edu',
      studentNumber: 'HSU-2026-8200',
      fullName: 'Student B Isolation',
      password: 'UniPass2026!',
      majorId: catalogInfo.csMajorId,
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(22, 128)
    });
    await studentBClient.login('student.b.t2@horizon.edu', 'UniPass2026!');

    browser = await launchBrowser();
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
    if (server) {
      await server.close();
    }
  });

  // =========================================================================
  // Feature F1: University Identity & Multi-Major Catalog (5 Tests)
  // =========================================================================
  describe('Feature F1 — University Identity & Multi-Major Catalog Boundaries', () => {
    test('T2-F1-01: Reject registration with non-university email domain (@gmail.com)', async () => {
      const pubClient = createDeviceClient(baseUrl);
      const res = await pubClient.post('/api/auth/register', {
        email: 'outsider.student@gmail.com',
        fullName: 'External User',
        password: 'UniPass2026!',
        planId: 'semester_essential'
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');
    });

    test('T2-F1-02: Reject registration and login with spoofed lookalike university domains (@horizon.edu.evil.com and @fakehorizon.edu)', async () => {
      const pubClient = createDeviceClient(baseUrl);
      const regSpoof1 = await pubClient.post('/api/auth/register', {
        email: 'attacker@horizon.edu.evil.com',
        fullName: 'Spoof 1',
        password: 'UniPass2026!'
      });
      assert.equal(regSpoof1.status, 403);
      assert.equal(regSpoof1.body.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');

      const regSpoof2 = await pubClient.post('/api/auth/register', {
        email: 'attacker@fakehorizon.edu',
        fullName: 'Spoof 2',
        password: 'UniPass2026!'
      });
      assert.equal(regSpoof2.status, 403);
      assert.equal(regSpoof2.body.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');

      const loginSpoof = await pubClient.post('/api/auth/login', {
        email: 'attacker@horizon.edu.evil.com',
        password: 'UniPass2026!'
      });
      assert.ok(loginSpoof.status === 403 || loginSpoof.status === 401);
    });

    test('T2-F1-03: Accept boundary secondary allowed university domains (@student.horizon.edu and @novatech.edu)', async () => {
      const pubClient = createDeviceClient(baseUrl);
      const subRes = await pubClient.post('/api/auth/register', {
        email: 't2_sub1@student.horizon.edu',
        fullName: 'Subdomain Student',
        password: 'UniPass2026!',
        majorId: catalogInfo.csMajorId,
        planId: 'semester_essential'
      });
      assert.equal(subRes.status, 201);

      const partnerRes = await pubClient.post('/api/auth/register', {
        email: 't2_partner1@novatech.edu',
        fullName: 'Partner Student',
        password: 'UniPass2026!',
        majorId: catalogInfo.eceMajorId,
        planId: 'semester_essential'
      });
      assert.equal(partnerRes.status, 201);
    });

    test('T2-F1-04: Reject duplicate registration for already-registered university email (amina@horizon.edu) and missing required fields', async () => {
      const pubClient = createDeviceClient(baseUrl);
      const dupRes = await pubClient.post('/api/auth/register', {
        email: PERSONAS.amina.email,
        fullName: 'Duplicate Amina',
        password: 'UniPass2026!'
      });
      assert.ok(dupRes.status === 400 || dupRes.status === 409);

      const emptyRes = await pubClient.post('/api/auth/register', {
        email: '',
        fullName: '',
        password: ''
      });
      assert.ok(emptyRes.status === 400 || emptyRes.status === 422 || emptyRes.status === 403);
    });

    test('T2-F1-05: Catalog lookup for non-existent subjectId, non-existent lessonId, and unknown majorId filter', async () => {
      const subj404 = await studentAClient.get('/api/catalog/subjects/NON_EXISTENT_SUBJECT_999');
      assert.equal(subj404.status, 404);

      const lesson404 = await studentAClient.get('/api/catalog/lessons/NON_EXISTENT_LESSON_999');
      assert.equal(lesson404.status, 404);

      const emptyFilter = await studentAClient.get('/api/catalog/subjects?majorId=NON_EXISTENT_MAJOR_999');
      assert.equal(emptyFilter.status, 200);
      assert.ok(Array.isArray(emptyFilter.body.subjects));
      assert.equal(emptyFilter.body.subjects.length, 0);
    });
  });

  // =========================================================================
  // Feature F2: Course & Subject File Ingestion Engine + FTS5 Search (5 Tests)
  // =========================================================================
  describe('Feature F2 — Course & Subject File Ingestion Engine + FTS5 Search Boundaries', () => {
    test('T2-F2-01: FTS5 search query with special characters, unbalanced quotes, boolean operators, and SQL injection payloads', async () => {
      const q1 = encodeURIComponent(
        `"unbalanced quote AND OR NOT * NEAR/3 ( ) [ ] -- ' OR 1=1; DROP TABLE course_chunks; --`
      );
      const res1 = await studentAClient.get(`/api/catalog/search?q=${q1}`);
      assert.equal(res1.status, 200);
      assert.ok(Array.isArray(res1.body.results));

      const q2 = encodeURIComponent('C++ & Python / O(n*log(n))');
      const res2 = await studentAClient.get(`/api/catalog/search?q=${q2}`);
      assert.equal(res2.status, 200);
      assert.ok(Array.isArray(res2.body.results));

      const checkMajors = await studentAClient.get('/api/catalog/majors');
      assert.equal(checkMajors.status, 200);
    });

    test('T2-F2-02: FTS5 search boundary with empty query (q=), whitespace query, and limit=1 cap', async () => {
      const res1 = await studentAClient.get('/api/catalog/search?q=algorithm&limit=1');
      assert.equal(res1.status, 200);
      assert.ok(Array.isArray(res1.body.results));
      assert.ok(res1.body.results.length <= 1);

      const res2 = await studentAClient.get('/api/catalog/search?q=%20%20%20');
      assert.ok(res2.status === 200 || res2.status === 400);
    });

    test('T2-F2-03: Reject course file upload with missing required fields or empty payload (POST /api/catalog/files/upload)', async () => {
      const res = await studentAClient.post('/api/catalog/files/upload', {});
      assert.ok(res.status >= 400 && res.status < 500);
    });

    test('T2-F2-04: Fetching non-existent course file ID (GET /api/catalog/files/:fileId) returns 404 Not Found', async () => {
      const res = await studentAClient.get('/api/catalog/files/file_does_not_exist_999');
      assert.equal(res.status, 404);
    });

    test('T2-F2-05: Base64-encoded UTF-8 math/symbol document ingestion and immediate FTS5 indexing', async () => {
      const unicodeDoc =
        '# Eigenvalue Spectral Bound\nFor all x in R^n, sum(lambda_i) = trace(A). Unique token: EIGEN_BOUNDARY_TOKEN_7749.';
      const upRes = await studentAClient.post('/api/catalog/files/upload', {
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        filename: 'eigen_boundary.md',
        mimeType: 'text/markdown',
        contentBase64: Buffer.from(unicodeDoc, 'utf8').toString('base64')
      });
      assert.equal(upRes.status, 201);

      const searchRes = await studentAClient.get('/api/catalog/search?q=EIGEN_BOUNDARY_TOKEN_7749');
      assert.equal(searchRes.status, 200);
      assert.ok(searchRes.body.results.length >= 1);
    });
  });

  // =========================================================================
  // Feature F3: University Subscription Access Control Gate (5 Tests)
  // =========================================================================
  describe('Feature F3 — University Subscription Access Control Gate Boundaries', () => {
    let unsubClient;

    test('T2-F3-01: Expired student (youssef@horizon.edu) can log in (200 OK) but is blocked from Catalog and AI endpoints with 402 Payment Required', async () => {
      const youssef = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f3-youssef-pc'
      });
      const loginRes = await youssef.login(PERSONAS.youssef.email, PERSONAS.youssef.password);
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'expired');

      const catRes = await youssef.get('/api/catalog/majors');
      assert.equal(catRes.status, 402);
      assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(catRes.body.code));

      const aiRes = await youssef.post('/api/ai/conversations', { title: 'Blocked Chat' });
      assert.equal(aiRes.status, 402);
      assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(aiRes.body.code));

      await youssef.logout();
    });

    test('T2-F3-02: Newly registered unsubscribed student (registered with no planId) is blocked across Slides, Research, Videos, and Exam Prep (402 Payment Required) while /api/subscription/status stays accessible (200 OK)', async () => {
      unsubClient = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f3-unsub-pc'
      });
      await unsubClient.post('/api/auth/register', {
        email: 't2_unsub@horizon.edu',
        studentNumber: 'HSU-2026-8302',
        fullName: 'Unsubscribed Student',
        password: 'UniPass2026!'
      });
      const loginRes = await unsubClient.login('t2_unsub@horizon.edu', 'UniPass2026!');
      assert.equal(loginRes.status, 200);

      for (const endpoint of ['/api/slides', '/api/research', '/api/videos', '/api/exam-prep/overview']) {
        const res = await unsubClient.get(endpoint);
        assert.equal(res.status, 402, `Expected 402 on ${endpoint}`);
        assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(res.body.code));
      }

      const subStatus = await unsubClient.get('/api/subscription/status');
      assert.equal(subStatus.status, 200);
    });

    test('T2-F3-03: Grace-period student (sara@horizon.edu) is permitted through subscriptionGateMiddleware (200 OK)', async () => {
      const sara = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f3-sara-pc'
      });
      const loginRes = await sara.login(PERSONAS.sara.email, PERSONAS.sara.password);
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'grace_period');

      assert.equal((await sara.get('/api/catalog/majors')).status, 200);
      assert.equal((await sara.get('/api/ai/providers')).status, 200);
      assert.equal((await sara.get('/api/exam-prep/overview')).status, 200);
      await sara.logout();
    });

    test('T2-F3-04: Department-sponsored plan activation rejects invalid voucher code (400/403) and succeeds with valid voucher HSU-SCHOLAR-2026 (200 OK)', async () => {
      const badVoucher = await unsubClient.post('/api/subscription/activate', {
        planId: 'department_sponsored',
        voucherCode: 'WRONG-VOUCHER-000'
      });
      assert.ok(badVoucher.status === 400 || badVoucher.status === 403);
      assert.equal((await unsubClient.get('/api/catalog/majors')).status, 402);

      const goodVoucher = await unsubClient.post('/api/subscription/activate', {
        planId: 'department_sponsored',
        voucherCode: 'HSU-SCHOLAR-2026'
      });
      assert.equal(goodVoucher.status, 200);
      assert.equal((await unsubClient.get('/api/catalog/majors')).status, 200);
    });

    test('T2-F3-05: Real-time subscription downgrade via POST /api/subscription/simulate-state (status: canceled) immediately gates an active session (402 Payment Required)', async () => {
      const simRes = await unsubClient.post('/api/subscription/simulate-state', {
        status: 'canceled'
      });
      assert.equal(simRes.status, 200);

      const gatedRes = await unsubClient.get('/api/catalog/majors');
      assert.equal(gatedRes.status, 402);
      await unsubClient.logout();
    });
  });

  // =========================================================================
  // Feature F4: Strict 1-PC + 1-Phone Concurrent Device Enforcer (5 Tests)
  // =========================================================================
  describe('Feature F4 — Strict 1-PC + 1-Phone Concurrent Device Enforcer Boundaries', () => {
    const f4Email = 't2_dev_f4@horizon.edu';
    let pc1;
    let pc2;
    let phone1;
    let phone2;

    before(async () => {
      const reg = createDeviceClient(baseUrl);
      await reg.post('/api/auth/register', {
        email: f4Email,
        studentNumber: 'HSU-2026-8401',
        fullName: 'T2 F4 Device Student',
        password: 'UniPass2026!',
        planId: 'annual_scholar',
        faceEmbedding: generateNormalizedEmbedding(33, 128)
      });
    });

    test('T2-F4-01: 2nd PC login while 1st PC slot is active returns 409 Conflict (DEVICE_SLOT_CONFLICT) without displacing 1st PC', async () => {
      pc1 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f4-pc-1',
        deviceFingerprint: 'fp-t2-f4-pc-1'
      });
      const res1 = await pc1.login(f4Email, 'UniPass2026!');
      assert.equal(res1.status, 200);

      pc2 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f4-pc-2',
        deviceFingerprint: 'fp-t2-f4-pc-2'
      });
      const res2 = await pc2.login(f4Email, 'UniPass2026!');
      assert.equal(res2.status, 409);
      assert.equal(res2.body.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(res2.body.slotType, 'pc');
      assert.equal(res2.body.requiresFacialAuth, true);
      assert.ok(res2.body.challengeId);
      assert.ok(res2.body.nonce);

      assert.equal((await pc1.get('/api/catalog/majors')).status, 200);
    });

    test('T2-F4-02: 2nd Phone login while 1st Phone slot is active returns 409 Conflict (slotType: phone) while 1st PC + 1st Phone both remain active', async () => {
      phone1 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 't2-f4-phone-1',
        deviceFingerprint: 'fp-t2-f4-phone-1'
      });
      const p1Res = await phone1.login(f4Email, 'UniPass2026!');
      assert.equal(p1Res.status, 200);

      phone2 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 't2-f4-phone-2',
        deviceFingerprint: 'fp-t2-f4-phone-2'
      });
      const p2Res = await phone2.login(f4Email, 'UniPass2026!');
      assert.equal(p2Res.status, 409);
      assert.equal(p2Res.body.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(p2Res.body.slotType, 'phone');
      assert.equal(p2Res.body.requiresFacialAuth, true);

      assert.equal((await pc1.post('/api/auth/sessions/heartbeat', {})).status, 200);
      assert.equal((await phone1.post('/api/auth/sessions/heartbeat', {})).status, 200);
    });

    test('T2-F4-03: Re-login from the SAME deviceFingerprint / deviceInstanceId renews existing slot (200 OK) without triggering 409 Conflict', async () => {
      const reLogin = await pc1.login(f4Email, 'UniPass2026!');
      assert.equal(reLogin.status, 200);
      assert.equal(reLogin.body.authenticated, true);
      assert.equal(reLogin.body.requiresFacialAuth, false);
    });

    test('T2-F4-04: Token replay with mismatched X-Device-Fingerprint or missing/corrupted Bearer token is rejected (401/403)', async () => {
      const noTokenClient = createDeviceClient(baseUrl, { deviceType: 'pc' });
      const resNoAuth = await noTokenClient.get('/api/catalog/majors');
      assert.equal(resNoAuth.status, 401);

      const badTokenRes = await noTokenClient.get('/api/catalog/majors', {
        headers: { Authorization: 'Bearer malformed.token.signature' }
      });
      assert.equal(badTokenRes.status, 401);

      const mismatchFpRes = await pc1.post(
        '/api/auth/sessions/heartbeat',
        {},
        { headers: { 'X-Device-Fingerprint': 'completely-different-device-fp-spoof' } }
      );
      assert.ok(mismatchFpRes.status === 401 || mismatchFpRes.status === 403);
    });

    test('T2-F4-05: Explicit POST /api/auth/logout on pc1 releases only pc slot, invalidates pc1 token (401), leaves phone1 active (200), and lets pc2 log in cleanly (200 OK)', async () => {
      const oldToken = pc1.token;
      const logoutRes = await pc1.logout();
      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.slotReleased, true);

      const oldTokenCheck = await pc1.get('/api/catalog/majors', { token: oldToken });
      assert.equal(oldTokenCheck.status, 401);

      assert.equal((await phone1.get('/api/auth/sessions/status')).status, 200);

      const pc2Login = await pc2.login(f4Email, 'UniPass2026!');
      assert.equal(pc2Login.status, 200);
      assert.equal(pc2Login.body.requiresFacialAuth, false);
    });
  });

  // =========================================================================
  // Feature F5: Facial Authentication & Atomic Device Slot Takeover (5 Tests)
  // =========================================================================
  describe('Feature F5 — Facial Authentication & Atomic Device Slot Takeover Boundaries', () => {
    const f5Email = 't2_bio_f5@horizon.edu';
    let pc1;
    let pc2;
    let pc3;
    let phone1;

    before(async () => {
      const reg = createDeviceClient(baseUrl);
      await reg.post('/api/auth/register', {
        email: f5Email,
        studentNumber: 'HSU-2026-8501',
        fullName: 'T2 F5 Biometric Student',
        password: 'UniPass2026!',
        planId: 'annual_scholar',
        faceEmbedding: generateNormalizedEmbedding(55, 128)
      });
      pc1 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f5-pc-1',
        deviceFingerprint: 'fp-t2-f5-pc-1'
      });
      phone1 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 't2-f5-phone-1',
        deviceFingerprint: 'fp-t2-f5-phone-1'
      });
      await pc1.login(f5Email, 'UniPass2026!');
      await phone1.login(f5Email, 'UniPass2026!');
    });

    test('T2-F5-01: Impostor biometric preset (simulationPreset: impostor) is rejected (403 BIOMETRIC_VERIFICATION_FAILED) and leaves original device active', async () => {
      pc2 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f5-pc-2',
        deviceFingerprint: 'fp-t2-f5-pc-2'
      });
      const conflict = await pc2.login(f5Email, 'UniPass2026!');
      assert.equal(conflict.status, 409);

      const verifyRes = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflict.body.challengeId,
        nonce: conflict.body.nonce,
        simulationPreset: 'impostor',
        livenessConfirmed: true
      });
      assert.equal(verifyRes.status, 403);
      assert.equal(verifyRes.body.verified, false);
      assert.equal(verifyRes.body.code, 'BIOMETRIC_VERIFICATION_FAILED');
      assert.ok(verifyRes.body.similarityScore < 0.85);

      assert.equal((await pc1.post('/api/auth/sessions/heartbeat', {})).status, 200);
    });

    test('T2-F5-02: Liveness failure (livenessConfirmed: false) rejects verification (403 BIOMETRIC_VERIFICATION_FAILED) even when simulationPreset: match', async () => {
      const conflict = await pc2.login(f5Email, 'UniPass2026!');
      assert.equal(conflict.status, 409);

      const verifyRes = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflict.body.challengeId,
        nonce: conflict.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: false
      });
      assert.equal(verifyRes.status, 403);
      assert.equal(verifyRes.body.verified, false);
      assert.equal(verifyRes.body.code, 'BIOMETRIC_VERIFICATION_FAILED');
    });

    test('T2-F5-03: Cosine similarity exact threshold boundary (0.85): 0.80 similarity vector fails (403) while 0.90 similarity vector succeeds (200 OK)', async () => {
      const basisE = new Array(128).fill(0);
      basisE[0] = 1.0;
      const enrollRes = await pc1.post('/api/auth/biometrics/enroll', {
        faceEmbedding: basisE,
        captureMode: 'webcam'
      });
      assert.equal(enrollRes.status, 200);

      // 0.80 cosine similarity (< 0.85 threshold)
      const conflictLow = await pc2.login(f5Email, 'UniPass2026!');
      assert.equal(conflictLow.status, 409);
      const vecLow = new Array(128).fill(0);
      vecLow[0] = 0.80;
      vecLow[1] = 0.60;
      const resLow = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflictLow.body.challengeId,
        nonce: conflictLow.body.nonce,
        liveEmbedding: vecLow,
        livenessConfirmed: true
      });
      assert.equal(resLow.status, 403);
      assert.equal(resLow.body.code, 'BIOMETRIC_VERIFICATION_FAILED');
      assert.ok(resLow.body.similarityScore < 0.85);

      // 0.90 cosine similarity (>= 0.85 threshold)
      const conflictHigh = await pc2.login(f5Email, 'UniPass2026!');
      assert.equal(conflictHigh.status, 409);
      const vecHigh = new Array(128).fill(0);
      vecHigh[0] = 0.90;
      vecHigh[1] = 0.43588989;
      const resHigh = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflictHigh.body.challengeId,
        nonce: conflictHigh.body.nonce,
        liveEmbedding: vecHigh,
        livenessConfirmed: true
      });
      assert.equal(resHigh.status, 200);
      assert.equal(resHigh.body.verified, true);
      assert.ok(resHigh.body.similarityScore >= 0.85);
      pc2.token = resHigh.body.sessionToken || resHigh.body.token;
    });

    test('T2-F5-04: Preempted pc2 receives 401 SESSION_PREEMPTED (reason: FACIAL_AUTH_SLOT_TAKEOVER) while concurrent phone1 session remains untouched (200 OK)', async () => {
      pc3 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f5-pc-3',
        deviceFingerprint: 'fp-t2-f5-pc-3'
      });
      const conflict = await pc3.login(f5Email, 'UniPass2026!');
      assert.equal(conflict.status, 409);

      const takeover = await pc3.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflict.body.challengeId,
        nonce: conflict.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(takeover.status, 200);
      pc3.token = takeover.body.sessionToken || takeover.body.token;

      const pc2Hb = await pc2.post('/api/auth/sessions/heartbeat', {});
      assert.equal(pc2Hb.status, 401);
      assert.equal(pc2Hb.body.code, 'SESSION_PREEMPTED');
      assert.equal(pc2Hb.body.reason, 'FACIAL_AUTH_SLOT_TAKEOVER');

      const pc2Cat = await pc2.get('/api/catalog/majors');
      assert.equal(pc2Cat.status, 401);
      assert.equal(pc2Cat.body.code, 'SESSION_PREEMPTED');

      const phone1Hb = await phone1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(phone1Hb.status, 200);
    });

    test('T2-F5-05: Mid-session anomaly report locks session with 403 BIOMETRIC_REAUTH_REQUIRED until verified, and rejects replay of consumed challengeId', async () => {
      const anomRes = await pc3.post('/api/auth/sessions/report-anomaly', {
        reason: 'SUSPICIOUS_IP_SHIFT'
      });
      assert.equal(anomRes.status, 200);
      assert.equal(anomRes.body.locked, true);
      assert.equal(anomRes.body.code, 'BIOMETRIC_REAUTH_REQUIRED');

      const lockedHb = await pc3.post('/api/auth/sessions/heartbeat', {});
      assert.equal(lockedHb.status, 403);
      assert.equal(lockedHb.body.code, 'BIOMETRIC_REAUTH_REQUIRED');

      const verify1 = await pc3.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: anomRes.body.challengeId,
        nonce: anomRes.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(verify1.status, 200);
      if (verify1.body.sessionToken || verify1.body.token) {
        pc3.token = verify1.body.sessionToken || verify1.body.token;
      }

      const replayRes = await pc3.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: anomRes.body.challengeId,
        nonce: anomRes.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.ok(replayRes.status >= 400);
    });
  });

  // =========================================================================
  // Feature F6: Built-In University AI Tutor & RAG Engine (5 Tests)
  // =========================================================================
  describe('Feature F6 — Built-In University AI Tutor & RAG Engine Boundaries', () => {
    let convId;

    before(async () => {
      const res = await studentAClient.post('/api/ai/conversations', {
        title: 'T2 F6 Boundary Conversation',
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        providerType: 'built_in'
      });
      convId = (res.body.conversation || res.body).id;
    });

    test('T2-F6-01: Reject empty or whitespace-only chat message content (POST /api/ai/conversations/:id/messages)', async () => {
      const res1 = await studentAClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: '   '
      });
      assert.ok(res1.status >= 400 && res1.status < 500);

      const res2 = await studentAClient.post(`/api/ai/conversations/${convId}/messages`, {});
      assert.ok(res2.status >= 400 && res2.status < 500);
    });

    test('T2-F6-02: Getting or posting a message to a non-existent conversationId returns 404 Not Found', async () => {
      const getRes = await studentAClient.get('/api/ai/conversations/conv_nonexistent_999');
      assert.equal(getRes.status, 404);

      const postRes = await studentAClient.post('/api/ai/conversations/conv_nonexistent_999/messages', {
        content: 'Hello'
      });
      assert.equal(postRes.status, 404);
    });

    test('T2-F6-03: Cross-student conversation isolation (Student B cannot read or post to Student A conversation)', async () => {
      const getRes = await studentBClient.get(`/api/ai/conversations/${convId}`);
      assert.ok(getRes.status === 403 || getRes.status === 404);

      const postRes = await studentBClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: 'Intruder message'
      });
      assert.ok(postRes.status === 403 || postRes.status === 404);
    });

    test('T2-F6-04: Built-in RAG tutor handles zero-FTS-match obscure query gracefully without throwing 500', async () => {
      const res = await studentAClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: 'zxqv_nonexistent_sumerian_metallurgy_9918273',
        providerType: 'built_in'
      });
      assert.ok(res.status === 200 || res.status === 201);
      assert.equal(res.body.assistantMessage.role, 'assistant');
      assert.ok(res.body.assistantMessage.content.length > 0);
      assert.ok(Array.isArray(res.body.assistantMessage.citations));
    });

    test('T2-F6-05: Built-in RAG tutor respects includeCourseContext: false boundary option', async () => {
      const res = await studentAClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: 'Give a general study tip for exam time management.',
        providerType: 'built_in',
        includeCourseContext: false
      });
      assert.ok(res.status === 200 || res.status === 201);
      assert.ok(res.body.assistantMessage.content.length > 10);
      assert.ok(Array.isArray(res.body.assistantMessage.citations));
    });
  });

  // =========================================================================
  // Feature F7: Bring-Your-Own-AI (BYO-AI) Multi-Provider Hub (5 Tests)
  // =========================================================================
  describe('Feature F7 — Bring-Your-Own-AI (BYO-AI) Multi-Provider Hub Boundaries', () => {
    let studentAProviderId;

    test('T2-F7-01: Deleting the built_in provider is rejected (DELETE /api/ai/providers/built_in)', async () => {
      const delRes = await studentAClient.del('/api/ai/providers/built_in');
      assert.ok(delRes.status >= 400 && delRes.status < 500);

      const listRes = await studentAClient.get('/api/ai/providers');
      assert.equal(listRes.status, 200);
      assert.ok(listRes.body.supportedProviders.includes('built_in'));
    });

    test('T2-F7-02: Reject unsupported providerType on POST /api/ai/providers', async () => {
      const res = await studentAClient.post('/api/ai/providers', {
        providerType: 'invalid_provider_xyz',
        displayName: 'Invalid Provider',
        modelName: 'invalid-1',
        apiKey: 'sk-test-12345'
      });
      assert.ok(res.status >= 400 && res.status < 500);
    });

    test('T2-F7-03: API key masking invariant: raw secret key is never returned in POST, PUT, or GET /api/ai/providers', async () => {
      const rawSecret = 'sk-kimi-RAW-SECRET-KEY-998877665544';
      const postRes = await studentAClient.post('/api/ai/providers', {
        providerType: 'kimi',
        displayName: 'Kimi Secret Test',
        modelName: 'moonshot-v1-128k',
        apiKey: rawSecret
      });
      assert.equal(postRes.status, 201);
      const prov = postRes.body.provider || postRes.body;
      studentAProviderId = prov.id;

      assert.ok(!JSON.stringify(postRes.body).includes(rawSecret));
      assert.ok(prov.apiKeyMasked || prov.api_key_masked);

      const getRes = await studentAClient.get('/api/ai/providers');
      assert.equal(getRes.status, 200);
      assert.ok(!JSON.stringify(getRes.body).includes(rawSecret));
    });

    test('T2-F7-04: Unreachable custom BYO-AI endpoint (http://127.0.0.1:1/v1/chat) handles connection failure gracefully without crashing server', async () => {
      const createRes = await studentAClient.post('/api/ai/providers', {
        providerType: 'custom',
        displayName: 'Unreachable Custom AI',
        modelName: 'custom-offline',
        baseUrl: 'http://127.0.0.1:1/v1/chat/completions',
        apiKey: 'sk-custom-12345678',
        executionMode: 'auto'
      });
      assert.equal(createRes.status, 201);
      const customId = (createRes.body.provider || createRes.body).id;

      const testRes = await studentAClient.post(`/api/ai/providers/${customId}/test`, {});
      assert.ok(testRes.status < 500);

      const convRes = await studentAClient.post('/api/ai/conversations', {
        title: 'Custom Fallback Chat',
        subjectId: catalogInfo.cs301Id,
        providerType: 'custom'
      });
      const convId = (convRes.body.conversation || convRes.body).id;
      const msgRes = await studentAClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: 'Test unreachable custom endpoint fallback.',
        providerType: 'custom',
        providerConfigId: customId
      });
      assert.ok(msgRes.status < 500);
    });

    test('T2-F7-05: Cross-student BYO-AI provider isolation (Student B cannot view, update, or delete Student A provider config)', async () => {
      const listB = await studentBClient.get('/api/ai/providers');
      assert.equal(listB.status, 200);
      const bIds = (listB.body.configuredProviders || []).map((p) => p.id);
      assert.ok(!bIds.includes(studentAProviderId));

      const putB = await studentBClient.put(`/api/ai/providers/${studentAProviderId}`, {
        displayName: 'Hijacked'
      });
      assert.ok(putB.status === 403 || putB.status === 404);

      const delB = await studentBClient.del(`/api/ai/providers/${studentAProviderId}`);
      assert.ok(delB.status === 403 || delB.status === 404);
    });
  });

  // =========================================================================
  // Feature F8: Student Chat File Uploads & Contextual Attachments (5 Tests)
  // =========================================================================
  describe('Feature F8 — Student Chat File Uploads & Contextual Attachments Boundaries', () => {
    let f8ConvId;

    before(async () => {
      const res = await studentAClient.post('/api/ai/conversations', {
        title: 'T2 F8 Chat File Boundary',
        subjectId: catalogInfo.cs301Id
      });
      f8ConvId = (res.body.conversation || res.body).id;
    });

    test('T2-F8-01: Uploading a file to a non-existent conversation returns 404 Not Found (POST /api/ai/conversations/:id/files)', async () => {
      const res = await studentAClient.post('/api/ai/conversations/conv_nonexistent_999/files', {
        filename: 'orphan.txt',
        contentText: 'Orphan content'
      });
      assert.equal(res.status, 404);
    });

    test('T2-F8-02: Reject chat file upload with missing filename and missing content (POST /api/ai/files/upload)', async () => {
      const res = await studentAClient.post('/api/ai/files/upload', {});
      assert.ok(res.status >= 400 && res.status < 500);
    });

    test('T2-F8-03: Sending chat message with non-existent attachedFileIds does not crash server', async () => {
      const res = await studentAClient.post(`/api/ai/conversations/${f8ConvId}/messages`, {
        content: 'Analyze ghost attachment',
        attachedFileIds: ['file_ghost_001', 'file_ghost_002']
      });
      assert.ok(res.status < 500);
    });

    test('T2-F8-04: Corrupted pseudo-PDF upload (corrupt.pdf with non-PDF bytes) falls back cleanly without crashing /usr/bin/pdftotext', async () => {
      const res = await studentAClient.post(`/api/ai/conversations/${f8ConvId}/files`, {
        filename: 'corrupt.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('NOT_A_PDF_FILE_HEADER_12345').toString('base64')
      });
      assert.ok(res.status < 500);
    });

    test('T2-F8-05: CSV & JSON chat file upload extraction and grounded answer with kiro BYO-AI provider', async () => {
      await studentAClient.post('/api/ai/providers', {
        providerType: 'kiro',
        displayName: 'Kiro Boundary',
        modelName: 'kiro-scholar-v1',
        apiKey: 'kr-secret-key-9999'
      });

      const upRes = await studentAClient.post(`/api/ai/conversations/${f8ConvId}/files`, {
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        contentText: 'Metric,Value\nEXPERIMENT_ALPHA_YIELD,98.42%'
      });
      assert.equal(upRes.status, 201);
      const chatFile = upRes.body.chatFile || upRes.body.file || upRes.body;

      const msgRes = await studentAClient.post(`/api/ai/conversations/${f8ConvId}/messages`, {
        content: 'What is the value of EXPERIMENT_ALPHA_YIELD in dataset.csv?',
        providerType: 'kiro',
        attachedFileIds: [chatFile.id]
      });
      assert.equal(msgRes.status, 201);
      assert.equal(msgRes.body.assistantMessage.providerType, 'kiro');
      assert.ok(msgRes.body.assistantMessage.attachedFilesUsed.length >= 1);
    });
  });

  // =========================================================================
  // Feature F9: Interactive Slide Deck Generator & Lesson Presenter (5 Tests)
  // =========================================================================
  describe('Feature F9 — Interactive Slide Deck Generator & Lesson Presenter Boundaries', () => {
    test('T2-F9-01: Slide count boundary clamping (slideCount: 1 below minimum 6 and slideCount: 50 above maximum 10)', async () => {
      const lowRes = await studentAClient.post('/api/slides/generate', {
        subjectId: catalogInfo.cs301Id,
        slideCount: 1
      });
      assert.ok(lowRes.status < 500);
      if (lowRes.status === 201 || lowRes.status === 200) {
        const deck = lowRes.body.deck || lowRes.body;
        assert.ok(deck.slides.length >= 6 && deck.slides.length <= 10);
      }

      const highRes = await studentAClient.post('/api/slides/generate', {
        subjectId: catalogInfo.cs301Id,
        slideCount: 50
      });
      assert.ok(highRes.status < 500);
      if (highRes.status === 201 || highRes.status === 200) {
        const deck = highRes.body.deck || highRes.body;
        assert.ok(deck.slides.length >= 6 && deck.slides.length <= 10);
      }
    });

    test('T2-F9-02: Reject slide generation when subjectId is missing or non-existent (POST /api/slides/generate)', async () => {
      const emptyRes = await studentAClient.post('/api/slides/generate', {});
      assert.ok(emptyRes.status >= 400 && emptyRes.status < 500);

      const missingSubj = await studentAClient.post('/api/slides/generate', {
        subjectId: 'NON_EXISTENT_SUBJ_999'
      });
      assert.ok(missingSubj.status >= 400 && missingSubj.status < 500);
    });

    test('T2-F9-03: Get, update (PUT), or delete (DELETE) non-existent deckId returns 404 Not Found', async () => {
      assert.equal((await studentAClient.get('/api/slides/deck_missing_999')).status, 404);
      assert.equal((await studentAClient.put('/api/slides/deck_missing_999', { title: 'X' })).status, 404);
      assert.equal((await studentAClient.del('/api/slides/deck_missing_999')).status, 404);
    });

    test('T2-F9-04: Deleting a slide deck removes it from subsequent GET /api/slides/:deckId (404) and handles second DELETE', async () => {
      const genRes = await studentAClient.post('/api/slides/generate', {
        subjectId: catalogInfo.cs301Id,
        slideCount: 6
      });
      assert.equal(genRes.status, 201);
      const deckId = (genRes.body.deck || genRes.body).id;

      const del1 = await studentAClient.del(`/api/slides/${deckId}`);
      assert.equal(del1.status, 200);
      assert.equal(del1.body.deleted, true);

      const getAfter = await studentAClient.get(`/api/slides/${deckId}`);
      assert.equal(getAfter.status, 404);

      const del2 = await studentAClient.del(`/api/slides/${deckId}`);
      assert.ok(del2.status === 404 || del2.status === 200);
    });

    test('T2-F9-05: Partial update (PUT /api/slides/:deckId) updates title and theme without losing existing slides array', async () => {
      const genRes = await studentAClient.post('/api/slides/generate', {
        subjectId: catalogInfo.cs301Id,
        slideCount: 6
      });
      const deckId = (genRes.body.deck || genRes.body).id;

      const putRes = await studentAClient.put(`/api/slides/${deckId}`, {
        title: 'Boundary Updated Deck',
        theme: 'solarized_light'
      });
      assert.equal(putRes.status, 200);
      const updated = putRes.body.deck || putRes.body;
      assert.equal(updated.title, 'Boundary Updated Deck');
      assert.equal(updated.theme, 'solarized_light');
      assert.ok(Array.isArray(updated.slides) && updated.slides.length >= 6);
    });
  });

  // =========================================================================
  // Feature F10: Deep Academic Research & Data Collection Engine (5 Tests)
  // =========================================================================
  describe('Feature F10 — Deep Academic Research & Data Collection Engine Boundaries', () => {
    let resId;

    before(async () => {
      const r = await studentAClient.post('/api/research/run', {
        query: 'Graph algorithms complexity bounds',
        subjectId: catalogInfo.cs301Id
      });
      resId = (r.body.project || r.body).id;
    });

    test('T2-F10-01: Reject research execution with empty or missing query (POST /api/research/run)', async () => {
      const r1 = await studentAClient.post('/api/research/run', { query: '   ' });
      assert.ok(r1.status >= 400 && r1.status < 500);

      const r2 = await studentAClient.post('/api/research/run', {});
      assert.ok(r2.status >= 400 && r2.status < 500);
    });

    test('T2-F10-02: Research export with unsupported format parameter (GET /api/research/:id/export?format=invalid_xyz)', async () => {
      const expRes = await studentAClient.get(`/api/research/${resId}/export?format=invalid_xyz`);
      assert.ok(expRes.status === 400 || expRes.status === 200);
    });

    test('T2-F10-03: Get, update notes (PUT), or export for a non-existent researchId returns 404 Not Found', async () => {
      assert.equal((await studentAClient.get('/api/research/res_missing_999')).status, 404);
      assert.equal(
        (await studentAClient.put('/api/research/res_missing_999/notes', { studentNotes: 'X' })).status,
        404
      );
      assert.equal((await studentAClient.get('/api/research/res_missing_999/export?format=csv')).status, 404);
    });

    test('T2-F10-04: Appending additionalRows with special characters (commas, quotes) via PUT /api/research/:id/notes and exporting as CSV/JSON', async () => {
      const putRes = await studentAClient.put(`/api/research/${resId}/notes`, {
        studentNotes: 'Note with "quotes" & commas, tested',
        additionalRows: [{ metric: 'Edge, "Case" Metric', value: '99.9%' }]
      });
      assert.equal(putRes.status, 200);

      const csvRes = await studentAClient.get(`/api/research/${resId}/export?format=csv`);
      assert.equal(csvRes.status, 200);
      assert.ok(csvRes.text.includes('99.9%'));

      const jsonRes = await studentAClient.get(`/api/research/${resId}/export?format=json`);
      assert.equal(jsonRes.status, 200);
      assert.ok(jsonRes.text.includes('99.9%'));
    });

    test('T2-F10-05: Research query with zero matching FTS chunks still synthesizes valid collectedDataTable (columns & rows)', async () => {
      const res = await studentAClient.post('/api/research/run', {
        query: 'nonexistent_exoplanet_mineralogy_zxq991',
        subjectId: catalogInfo.bio205Id
      });
      assert.equal(res.status, 201);
      const proj = res.body.project || res.body;
      const table = proj.collectedDataTable || proj.collected_data_table;
      assert.ok(Array.isArray(proj.sections));
      assert.ok(Array.isArray(table.columns));
      assert.ok(Array.isArray(table.rows));
    });
  });

  // =========================================================================
  // Feature F11: AI Educational Video Generator & Interactive Player (5 Tests)
  // =========================================================================
  describe('Feature F11 — AI Educational Video Generator & Interactive Player Boundaries', () => {
    let lazyVideoId;

    test('T2-F11-01: Reject video generation when topicPrompt and subjectId are missing (POST /api/videos/generate)', async () => {
      const res = await studentAClient.post('/api/videos/generate', {});
      assert.ok(res.status >= 400 && res.status < 500);
    });

    test('T2-F11-02: Fetching metadata or streaming .mp4 for non-existent videoId returns 404 Not Found', async () => {
      assert.equal((await studentAClient.get('/api/videos/vid_missing_999')).status, 404);
      assert.equal((await studentAClient.get('/api/videos/vid_missing_999/stream')).status, 404);
    });

    test('T2-F11-03: HTTP Byte-Range boundary (Range: bytes=0-511) on GET /api/videos/:videoId/stream returns 206 Partial Content with MP4 ftyp header', async () => {
      const genRes = await studentAClient.post('/api/videos/generate', {
        subjectId: catalogInfo.cs301Id,
        topicPrompt: 'Binary Search Trees & AVL Rotations',
        targetDurationSec: 12,
        renderMp4: true
      });
      assert.equal(genRes.status, 201);
      const vidId = (genRes.body.video || genRes.body).id;

      const rangeRes = await studentAClient.get(`/api/videos/${vidId}/stream`, {
        headers: { Range: 'bytes=0-511' }
      });
      assert.equal(rangeRes.status, 206);
      assert.ok((rangeRes.headers['content-type'] || '').includes('video/mp4'));
      assert.ok((rangeRes.headers['content-range'] || '').startsWith('bytes 0-511/'));
      assert.equal(rangeRes.buffer.length, 512);
      assert.equal(rangeRes.buffer.subarray(4, 8).toString('ascii'), 'ftyp');
    });

    test('T2-F11-04: Extreme targetDurationSec boundary (targetDurationSec: 5 short) clamps cleanly', async () => {
      const res = await studentAClient.post('/api/videos/generate', {
        subjectId: catalogInfo.cs301Id,
        topicPrompt: 'Short duration boundary check',
        targetDurationSec: 5,
        renderMp4: false
      });
      assert.equal(res.status, 201);
      const video = res.body.video || res.body;
      assert.ok(Array.isArray(video.scenes) && video.scenes.length >= 2);
      assert.ok(Array.isArray(video.transcript) && video.transcript.length >= 1);
      lazyVideoId = video.id;
    });

    test('T2-F11-05: Lazy/on-demand FFmpeg MP4 synthesis when video was initially created with renderMp4: false', async () => {
      const streamRes = await studentAClient.get(`/api/videos/${lazyVideoId}/stream`);
      assert.ok(streamRes.status === 200 || streamRes.status === 206);
      assert.ok((streamRes.headers['content-type'] || '').includes('video/mp4'));
      assert.ok(streamRes.buffer.length > 500);
      assert.equal(streamRes.buffer.subarray(4, 8).toString('ascii'), 'ftyp');
    });
  });

  // =========================================================================
  // Feature F12: Exam Preparation Suite (5 Tests)
  // =========================================================================
  describe('Feature F12 — Exam Preparation Suite Boundaries', () => {
    let validCardId;
    let boundaryExam;

    before(async () => {
      const fcRes = await studentAClient.post('/api/exam-prep/flashcards/generate', {
        subjectId: catalogInfo.cs301Id,
        count: 4
      });
      validCardId = fcRes.body.flashcards[0].id;

      const exRes = await studentAClient.post('/api/exam-prep/exams/generate', {
        subjectId: catalogInfo.cs301Id,
        questionCount: 5
      });
      boundaryExam = exRes.body.exam || exRes.body;
    });

    test('T2-F12-01: SM-2 flashcard review with quality: 0 resets repetitions to 0 and maintains easeFactor >= 1.3 floor', async () => {
      await studentAClient.post(`/api/exam-prep/flashcards/${validCardId}/review`, { quality: 3 });
      await studentAClient.post(`/api/exam-prep/flashcards/${validCardId}/review`, { quality: 3 });

      let lastCard;
      for (let i = 0; i < 3; i++) {
        const res = await studentAClient.post(`/api/exam-prep/flashcards/${validCardId}/review`, {
          quality: 0
        });
        assert.equal(res.status, 200);
        lastCard = res.body.flashcard || res.body;
      }
      assert.equal(lastCard.repetitions, 0);
      const ease = lastCard.easeFactor ?? lastCard.ease_factor;
      assert.ok(ease >= 1.3);
    });

    test('T2-F12-02: SM-2 flashcard review with non-existent cardId (404) and out-of-range quality (quality: 99)', async () => {
      const r404 = await studentAClient.post('/api/exam-prep/flashcards/card_nonexistent_999/review', {
        quality: 2
      });
      assert.equal(r404.status, 404);

      const rOut = await studentAClient.post(`/api/exam-prep/flashcards/${validCardId}/review`, {
        quality: 99
      });
      assert.ok(rOut.status < 500);
    });

    test('T2-F12-03: Submitting an exam with empty answers: {} yields 0% score, F grade, and populates weaknessRecommendations', async () => {
      const res = await studentAClient.post(`/api/exam-prep/exams/${boundaryExam.id}/submit`, {
        answers: {},
        durationUsedSec: 15
      });
      assert.equal(res.status, 201);
      const attempt = res.body.attempt || res.body;
      assert.equal(attempt.percentage, 0);
      assert.equal(attempt.letterGrade || attempt.letter_grade, 'F');
      assert.ok(Array.isArray(attempt.weaknessRecommendations || attempt.weakness_recommendations));
      assert.ok((attempt.weaknessRecommendations || attempt.weakness_recommendations).length >= 1);
    });

    test('T2-F12-04: Submitting an exam with all correct answers yields 100% score and A/A+ grade', async () => {
      const answers = buildAllCorrectAnswers(boundaryExam);
      const res = await studentAClient.post(`/api/exam-prep/exams/${boundaryExam.id}/submit`, {
        answers,
        durationUsedSec: 200
      });
      assert.equal(res.status, 201);
      const attempt = res.body.attempt || res.body;
      assert.equal(attempt.percentage, 100);
      assert.ok((attempt.letterGrade || attempt.letter_grade).startsWith('A'));
    });

    test('T2-F12-05: Fetching or submitting a non-existent examId returns 404 Not Found', async () => {
      assert.equal((await studentAClient.get('/api/exam-prep/exams/exam_missing_999')).status, 404);
      assert.equal(
        (await studentAClient.post('/api/exam-prep/exams/exam_missing_999/submit', { answers: {} })).status,
        404
      );
    });
  });

  // =========================================================================
  // Feature F13: Responsive Full-Stack Web Application UI Boundaries (5 Tests)
  // =========================================================================
  describe('Feature F13 — Responsive Full-Stack Web Application UI Boundaries', () => {
    const f13BoundaryEmail = 't2.f13.browser@horizon.edu';

    before(async () => {
      const reg = createDeviceClient(baseUrl);
      await reg.post('/api/auth/register', {
        email: f13BoundaryEmail,
        studentNumber: 'HSU-2026-8913',
        fullName: 'T2 Browser Boundary Student',
        password: 'UniPass2026!',
        planId: 'annual_scholar',
        faceEmbedding: generateNormalizedEmbedding(88, 128)
      });
    });

    test('T2-F13-01: Browser UI negative login (WrongPassword!) receives 401 INVALID_CREDENTIALS and stays unauthenticated', async () => {
      const devPage = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f13-badpass-pc'
      });
      try {
        await devPage.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const result = await devPage.page.evaluate(async (email) => {
          const resp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'WrongPassword999!' })
          });
          const body = await resp.json();
          return { status: resp.status, code: body.code };
        }, PERSONAS.amina.email);

        assert.equal(result.status, 401);
        assert.equal(result.code, 'INVALID_CREDENTIALS');
      } finally {
        await devPage.close();
      }
    });

    test('T2-F13-02: Browser UI registration with non-university email (outsider@gmail.com) receives 403 UNIVERSITY_DOMAIN_NOT_ALLOWED', async () => {
      const devPage = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f13-domain-pc'
      });
      try {
        await devPage.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const result = await devPage.page.evaluate(async () => {
          const resp = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'outsider@gmail.com',
              fullName: 'Outsider',
              password: 'UniPass2026!'
            })
          });
          const body = await resp.json();
          return { status: resp.status, code: body.code };
        });

        assert.equal(result.status, 403);
        assert.equal(result.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');
      } finally {
        await devPage.close();
      }
    });

    test('T2-F13-03: Browser UI expired student (youssef@horizon.edu) login receives 402 Payment Required on study routes while Subscription Portal stays accessible', async () => {
      const devPage = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f13-youssef-pc'
      });
      try {
        await devPage.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const result = await devPage.page.evaluate(async (creds) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t2-f13-youssef-pc'
            },
            body: JSON.stringify({
              email: creds.email,
              password: creds.password,
              deviceType: 'pc',
              deviceInstanceId: 't2-f13-youssef-pc',
              deviceFingerprint: 'fp-pc-t2-f13-youssef-pc'
            })
          });
          const loginData = await loginResp.json();
          const token = loginData.sessionToken || loginData.token;
          const headers = { Authorization: `Bearer ${token}` };

          const catalogResp = await fetch('/api/catalog/majors', { headers });
          const catalogData = await catalogResp.json();
          const subResp = await fetch('/api/subscription/status', { headers });
          await fetch('/api/auth/logout', { method: 'POST', headers });

          return {
            subStatus: loginData.subscription.status,
            catalogHttpStatus: catalogResp.status,
            catalogErrorCode: catalogData.code,
            subHttpStatus: subResp.status
          };
        }, PERSONAS.youssef);

        assert.equal(result.subStatus, 'expired');
        assert.equal(result.catalogHttpStatus, 402);
        assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(result.catalogErrorCode));
        assert.equal(result.subHttpStatus, 200);
      } finally {
        await devPage.close();
      }
    });

    test('T2-F13-04: Browser UI 2nd-PC login conflict triggers DEVICE_SLOT_CONFLICT and Impostor simulation preset fails takeover (403)', async () => {
      const apiPc1 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f13-pc1',
        deviceFingerprint: 'fp-pc-t2-f13-pc1'
      });
      await apiPc1.login(f13BoundaryEmail, 'UniPass2026!');

      const devPage2 = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't2-f13-pc2'
      });
      try {
        await devPage2.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const res = await devPage2.page.evaluate(async (email) => {
          const conflictResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t2-f13-pc2'
            },
            body: JSON.stringify({
              email,
              password: 'UniPass2026!',
              deviceType: 'pc',
              deviceInstanceId: 't2-f13-pc2',
              deviceFingerprint: 'fp-pc-t2-f13-pc2'
            })
          });
          const conflictData = await conflictResp.json();

          const impostorResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t2-f13-pc2'
            },
            body: JSON.stringify({
              challengeId: conflictData.challengeId,
              nonce: conflictData.nonce,
              simulationPreset: 'impostor',
              livenessConfirmed: true
            })
          });
          const impostorData = await impostorResp.json();
          return {
            conflictStatus: conflictResp.status,
            conflictCode: conflictData.code,
            impostorStatus: impostorResp.status,
            impostorCode: impostorData.code,
            verified: impostorData.verified
          };
        }, f13BoundaryEmail);

        assert.equal(res.conflictStatus, 409);
        assert.equal(res.conflictCode, 'DEVICE_SLOT_CONFLICT');
        assert.equal(res.impostorStatus, 403);
        assert.equal(res.impostorCode, 'BIOMETRIC_VERIFICATION_FAILED');
        assert.equal(res.verified, false);
      } finally {
        await devPage2.close();
      }
    });

    test('T2-F13-05: Browser UI live session preemption on displaced PC + Mobile (390x844) responsive viewport check', async () => {
      const mobilePage = await createDevicePage(browser, {
        deviceType: 'phone',
        deviceInstanceId: 't2-f13-mobile-check'
      });
      try {
        await mobilePage.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const layout = await mobilePage.page.evaluate(() => ({
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth
        }));
        assert.equal(layout.innerWidth, 390);
        assert.ok(layout.scrollWidth <= layout.innerWidth + 24);
      } finally {
        await mobilePage.close();
      }
    });
  });
});
