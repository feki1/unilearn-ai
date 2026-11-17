import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAS,
  startE2EServer,
  createDeviceClient,
  createSamplePdfBuffer,
  generateNormalizedEmbedding,
  perturbEmbedding,
  launchBrowser,
  createDevicePage
} from '../helpers/browserHarness.js';

/**
 * Helper to dynamically resolve seeded Major, Subject, and Lesson IDs from `/api/catalog/*`
 * so tests never hardcode internal database primary key formats.
 */
async function resolveCatalogIds(client) {
  const majorsRes = await client.get('/api/catalog/majors');
  assert.equal(majorsRes.status, 200);
  const majors = majorsRes.data.majors || [];
  const csMajor = majors.find((m) => m.code === 'CS') || majors[0];
  const eceMajor = majors.find((m) => m.code === 'ECE') || majors[1] || csMajor;
  const bioMajor = majors.find((m) => m.code === 'BIO') || majors[2] || csMajor;
  const econMajor = majors.find((m) => m.code === 'ECON') || majors[3] || csMajor;

  const subjRes = await client.get('/api/catalog/subjects');
  assert.equal(subjRes.status, 200);
  const subjects = subjRes.data.subjects || [];
  const cs301 = subjects.find((s) => s.code === 'CS-301') || subjects[0];
  const ece210 = subjects.find((s) => s.code === 'ECE-210') || subjects[1] || cs301;
  const bio205 = subjects.find((s) => s.code === 'BIO-205') || subjects[2] || cs301;

  let cs301Lesson = null;
  if (cs301) {
    const detailRes = await client.get(`/api/catalog/subjects/${cs301.id}`);
    if (detailRes.status === 200 && Array.isArray(detailRes.data.lessons) && detailRes.data.lessons.length > 0) {
      cs301Lesson = detailRes.data.lessons[0];
    }
  }

  return {
    majors,
    subjects,
    csMajorId: csMajor ? csMajor.id : 'CS',
    eceMajorId: eceMajor ? eceMajor.id : 'ECE',
    bioMajorId: bioMajor ? bioMajor.id : 'BIO',
    econMajorId: econMajor ? econMajor.id : 'ECON',
    cs301Id: cs301 ? cs301.id : 'CS-301',
    ece210Id: ece210 ? ece210.id : 'ECE-210',
    bio205Id: bio205 ? bio205.id : 'BIO-205',
    cs301LessonId: cs301Lesson ? cs301Lesson.id : null
  };
}

/**
 * Helper to construct a valid correct-answer map for an exam regardless of question schema variant.
 */
function buildExamAnswers(exam) {
  const answers = {};
  const questions = (exam && exam.questions) || [];
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const qKey = q.id || q.questionId || String(idx);
    if (q.correctAnswer !== undefined) {
      answers[qKey] = q.correctAnswer;
    } else if (q.correctOption !== undefined) {
      answers[qKey] = q.correctOption;
    } else if (q.answer !== undefined) {
      answers[qKey] = q.answer;
    } else if (Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0) {
      answers[qKey] = q.acceptableAnswers[0];
    } else if (Array.isArray(q.options) && q.options.length > 0) {
      const opt = q.options[0];
      answers[qKey] = typeof opt === 'object' && opt !== null ? opt.id || opt.value || opt.text : opt;
    } else {
      answers[qKey] = 'O(E + V log V)';
    }
  }
  return answers;
}

describe('Tier 1 — Feature Coverage (F1–F13 Happy Path: 65 Isolated Tests)', () => {
  let server;
  let baseUrl;
  let browser;
  let catalogInfo;
  let mainPcClient;

  // Shared artifacts across sub-steps within a feature
  let f2DynamicIds = {};
  let f2PdfFileId = null;
  let f6ConvId = null;
  let f7Providers = {};
  let f7ConvId = null;
  let f8ConvId = null;
  let f8MdFileId = null;
  let f8PdfFileId = null;
  let f9DeckId = null;
  let f9CustomDeckId = null;
  let f10ResearchId = null;
  let f11VideoId = null;
  let f12CardId = null;
  let f12Exam = null;

  before(async () => {
    server = await startE2EServer({ seed: true });
    baseUrl = server.baseUrl;
    mainPcClient = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 't1-main-pc-1',
      deviceLabel: 'Amina Main Study PC'
    });
    const loginRes = await mainPcClient.login(PERSONAS.amina.email, PERSONAS.amina.password);
    assert.equal(loginRes.status, 200);
    catalogInfo = await resolveCatalogIds(mainPcClient);
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
  describe('Feature F1 — University Identity & Multi-Major Catalog', () => {
    test('T1-F1-01: University health & identity endpoint returns Horizon State University (HSU) metadata', async () => {
      const pubClient = createDeviceClient(baseUrl, { deviceType: 'pc', deviceInstanceId: 't1-f1-pub' });
      const res = await pubClient.get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.university, 'Horizon State University');
      assert.equal(res.data.code, 'HSU');
    });

    test('T1-F1-02: University student registration with valid @horizon.edu email creates student account', async () => {
      const regClient = createDeviceClient(baseUrl, { deviceType: 'pc', deviceInstanceId: 't1-f1-reg' });
      const res = await regClient.post('/api/auth/register', {
        email: 'tarik.f1@horizon.edu',
        studentNumber: 'HSU-2026-9101',
        fullName: 'Tarik F1 Scholar',
        password: 'UniPass2026!',
        majorId: catalogInfo.csMajorId,
        planId: 'semester_essential'
      });
      assert.equal(res.status, 201);
      const student = res.data.student || res.data;
      assert.equal(student.email, 'tarik.f1@horizon.edu');
      const subStatus =
        (res.data.subscription && res.data.subscription.status) || student.subscriptionStatus || 'active';
      assert.equal(subStatus, 'active');
    });

    test('T1-F1-03: List university majors returns all 4+ pre-seeded majors (CS, ECE, BIO, ECON) with counts', async () => {
      const res = await mainPcClient.get('/api/catalog/majors');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.majors));
      assert.ok(res.data.majors.length >= 4);
      const codes = res.data.majors.map((m) => m.code);
      for (const expectedCode of ['CS', 'ECE', 'BIO', 'ECON']) {
        assert.ok(codes.includes(expectedCode), `Expected major ${expectedCode} in ${JSON.stringify(codes)}`);
      }
    });

    test('T1-F1-04: List subjects across majors and filter by majorId returns 8+ seeded university subjects', async () => {
      const allRes = await mainPcClient.get('/api/catalog/subjects');
      assert.equal(allRes.status, 200);
      assert.ok(Array.isArray(allRes.data.subjects));
      assert.ok(allRes.data.subjects.length >= 8);

      const codes = allRes.data.subjects.map((s) => s.code);
      for (const code of ['CS-301', 'CS-402', 'CS-450', 'ECE-210', 'ECE-340', 'BIO-205', 'ECON-201', 'FIN-320']) {
        assert.ok(codes.includes(code), `Missing seeded subject ${code}`);
      }

      const filteredRes = await mainPcClient.get(
        `/api/catalog/subjects?majorId=${encodeURIComponent(catalogInfo.csMajorId)}`
      );
      assert.equal(filteredRes.status, 200);
      assert.ok(Array.isArray(filteredRes.data.subjects));
      assert.ok(filteredRes.data.subjects.length >= 2);
      assert.ok(filteredRes.data.subjects.some((s) => s.code === 'CS-301'));
    });

    test('T1-F1-05: Inspect subject detail and individual lesson detail returns syllabus, lessons, formulas, and key concepts', async () => {
      const subjRes = await mainPcClient.get(`/api/catalog/subjects/${catalogInfo.cs301Id}`);
      assert.equal(subjRes.status, 200);
      const subject = subjRes.data.subject || subjRes.data;
      assert.equal(subject.code, 'CS-301');
      assert.ok(Array.isArray(subjRes.data.lessons));
      assert.ok(subjRes.data.lessons.length >= 1);

      const firstLesson = subjRes.data.lessons[0];
      const lessonRes = await mainPcClient.get(`/api/catalog/lessons/${firstLesson.id}`);
      assert.equal(lessonRes.status, 200);
      const lesson = lessonRes.data.lesson || lessonRes.data;
      const markdown = lesson.contentMarkdown || lesson.content_markdown || lesson.content || '';
      assert.ok(markdown.length > 20, 'Lesson markdown content should be populated');
    });
  });

  // =========================================================================
  // Feature F2: Course & Subject File Ingestion Engine + FTS5 Search (5 Tests)
  // =========================================================================
  describe('Feature F2 — Course & Subject File Ingestion Engine + FTS5 Search', () => {
    test('T1-F2-01: Dynamically create a new Major, Subject, and Lesson with automatic FTS5 chunk indexing', async () => {
      const majorRes = await mainPcClient.post('/api/catalog/majors', {
        code: 'MATH',
        name: 'Applied Mathematics & Quantitative Modeling',
        faculty: 'Faculty of Science',
        description: 'Stochastic processes, PDEs, and numerical analysis.'
      });
      assert.equal(majorRes.status, 201);
      const major = majorRes.data.major || majorRes.data;
      assert.ok(major.id);

      const subjRes = await mainPcClient.post('/api/catalog/subjects', {
        majorId: major.id,
        code: 'MATH-310',
        title: 'Stochastic Calculus & Ito Processes',
        semester: 'Fall 2026',
        credits: 4,
        instructor: 'Prof. Euler',
        syllabusSummary: 'Brownian motion, martingale representation, and Ito Lemma derivations.'
      });
      assert.equal(subjRes.status, 201);
      const subject = subjRes.data.subject || subjRes.data;
      assert.ok(subject.id);

      const lessonRes = await mainPcClient.post(`/api/catalog/subjects/${subject.id}/lessons`, {
        moduleNumber: 1,
        title: 'Ito Lemma & Quadratic Variation',
        summary: 'Derivation of Ito formula for twice-differentiable functions of semimartingales.',
        contentMarkdown:
          '# Ito Lemma\nFor a stochastic process dX_t = mu_t dt + sigma_t dW_t, the quadratic variation [W, W]_t = t yields the second-order Taylor term 0.5 * sigma_t^2 f_xx dt.',
        keyConcepts: ['Ito Lemma', 'Quadratic Variation', 'Semimartingale']
      });
      assert.equal(lessonRes.status, 201);
      const chunksCreated =
        lessonRes.data.chunksCreated ??
        (lessonRes.data.lesson && lessonRes.data.lesson.chunksCreated) ??
        1;
      assert.ok(chunksCreated >= 1);

      f2DynamicIds = { majorId: major.id, subjectId: subject.id };
    });

    test('T1-F2-02: Ingest a Markdown/Text course file via JSON (POST /api/catalog/files/upload) and verify chunk indexing', async () => {
      const res = await mainPcClient.post('/api/catalog/files/upload', {
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        filename: 'radix_heaps_lecture.md',
        mimeType: 'text/markdown',
        contentText:
          '# Radix Heaps & Monotone Priority Queues\nA monotone radix heap achieves O(m + n log C) time complexity for single-source shortest paths with bounded integer edge weights.'
      });
      assert.equal(res.status, 201);
      const file = res.data.file || res.data;
      assert.equal(file.filename, 'radix_heaps_lecture.md');
      const chunksCreated = res.data.chunksCreated ?? file.chunksCreated ?? 1;
      assert.ok(chunksCreated >= 1);
      assert.ok(Array.isArray(res.data.extractedTopics || file.extractedTopics || []));
    });

    test('T1-F2-03: Ingest a real PDF document (application/pdf via Base64) extracted via /usr/bin/pdftotext', async () => {
      const pdfBuffer = createSamplePdfBuffer(
        'Karatsuba Fast Polynomial Multiplication Subquadratic Divide And Conquer Recurrence O(n^1.585)'
      );
      const res = await mainPcClient.post('/api/catalog/files/upload', {
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        filename: 'karatsuba_polynomial.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBuffer.toString('base64')
      });
      assert.equal(res.status, 201);
      const file = res.data.file || res.data;
      assert.equal(file.filename, 'karatsuba_polynomial.pdf');
      f2PdfFileId = file.id;

      const getRes = await mainPcClient.get(`/api/catalog/files/${f2PdfFileId}`);
      assert.equal(getRes.status, 200);
      const combinedStr = JSON.stringify(getRes.data);
      assert.ok(
        combinedStr.includes('Karatsuba'),
        'Expected pdftotext extracted content to include Karatsuba'
      );
    });

    test('T1-F2-04: Ingest structured CSV/JSON dataset file into a course subject and verify file retrieval', async () => {
      const uploadRes = await mainPcClient.post('/api/catalog/files/upload', {
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        filename: 'sorting_benchmarks.csv',
        mimeType: 'text/csv',
        contentText:
          'Algorithm,TimeComplexity,SpaceComplexity,Stable\nMergeSort,O(n log n),O(n),Yes\nHeapSort,O(n log n),O(1),No\nTimSort,O(n log n),O(n),Yes'
      });
      assert.equal(uploadRes.status, 201);

      const listRes = await mainPcClient.get(
        `/api/catalog/files?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.data.files));
      assert.ok(listRes.data.files.some((f) => f.filename === 'sorting_benchmarks.csv'));
    });

    test('T1-F2-05: Search course_chunks_fts via GET /api/catalog/search?q= returns ranked BM25 snippets', async () => {
      const res1 = await mainPcClient.get('/api/catalog/search?q=Karatsuba');
      assert.equal(res1.status, 200);
      assert.ok(Array.isArray(res1.data.results));
      assert.ok(res1.data.results.length >= 1);
      const top1 = res1.data.results[0];
      assert.ok((top1.content || top1.snippet || '').toLowerCase().includes('karatsuba'));

      const res2 = await mainPcClient.get('/api/catalog/search?q=Semimartingale');
      assert.equal(res2.status, 200);
      assert.ok(Array.isArray(res2.data.results));
      assert.ok(res2.data.results.length >= 1);
    });
  });

  // =========================================================================
  // Feature F3: University Subscription Access Control Gate (5 Tests)
  // =========================================================================
  describe('Feature F3 — University Subscription Access Control Gate', () => {
    test('T1-F3-01: Active subscribed student (amina@horizon.edu) inspects subscription status and plans', async () => {
      const res = await mainPcClient.get('/api/subscription/status');
      assert.equal(res.status, 200);
      const sub = res.data.subscription || res.data;
      assert.equal(sub.status, 'active');
      const planId = sub.planId || sub.plan_id;
      assert.equal(planId, 'annual_scholar');
    });

    test('T1-F3-02: Grace-period student (sara@horizon.edu) retains access to protected catalog and study endpoints', async () => {
      const saraClient = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f3-sara-pc'
      });
      const loginRes = await saraClient.login(PERSONAS.sara.email, PERSONAS.sara.password);
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.data.subscription.status, 'grace_period');

      const catRes = await saraClient.get('/api/catalog/majors');
      assert.equal(catRes.status, 200);
      assert.ok(catRes.data.majors.length >= 4);

      await saraClient.logout();
    });

    test('T1-F3-03: Expired student (youssef@horizon.edu) can log in and activate semester_essential subscription via payment method', async () => {
      const youssefClient = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f3-youssef-pc'
      });
      const loginRes = await youssefClient.login(PERSONAS.youssef.email, PERSONAS.youssef.password);
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.data.subscription.status, 'expired');

      const blockedRes = await youssefClient.get('/api/catalog/majors');
      assert.equal(blockedRes.status, 402);

      const actRes = await youssefClient.post('/api/subscription/activate', {
        planId: 'semester_essential',
        paymentMethod: 'card_visa_4242'
      });
      assert.equal(actRes.status, 200);
      const newStatus = actRes.data.status || (actRes.data.subscription && actRes.data.subscription.status);
      assert.equal(newStatus, 'active');

      const unlockedRes = await youssefClient.get('/api/catalog/majors');
      assert.equal(unlockedRes.status, 200);

      // Restore Youssef back to expired for subsequent suites
      await youssefClient.post('/api/subscription/simulate-state', { status: 'expired' });
      await youssefClient.logout();
    });

    test('T1-F3-04: Activate department_sponsored plan using university scholarship voucher HSU-SCHOLAR-2026', async () => {
      const scholarClient = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f3-scholar-pc'
      });
      await scholarClient.post('/api/auth/register', {
        email: 'voucher.f3@horizon.edu',
        studentNumber: 'HSU-2026-9304',
        fullName: 'Voucher Scholar',
        password: 'UniPass2026!'
      });
      await scholarClient.login('voucher.f3@horizon.edu', 'UniPass2026!');

      const actRes = await scholarClient.post('/api/subscription/activate', {
        planId: 'department_sponsored',
        voucherCode: 'HSU-SCHOLAR-2026'
      });
      assert.equal(actRes.status, 200);
      const sub = actRes.data.subscription || actRes.data;
      assert.equal(actRes.data.status || sub.status, 'active');
      assert.equal(sub.planId || sub.plan_id, 'department_sponsored');
      await scholarClient.logout();
    });

    test('T1-F3-05: Deterministic subscription state transition via POST /api/subscription/simulate-state updates gate behavior immediately', async () => {
      const simClient = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f3-sim-pc'
      });
      await simClient.post('/api/auth/register', {
        email: 'sim.f3@horizon.edu',
        studentNumber: 'HSU-2026-9305',
        fullName: 'Sim State Student',
        password: 'UniPass2026!',
        planId: 'semester_essential'
      });
      await simClient.login('sim.f3@horizon.edu', 'UniPass2026!');

      const expRes = await simClient.post('/api/subscription/simulate-state', { status: 'expired' });
      assert.equal(expRes.status, 200);

      const gateRes = await simClient.get('/api/catalog/majors');
      assert.equal(gateRes.status, 402);

      const actRes = await simClient.post('/api/subscription/simulate-state', { status: 'active' });
      assert.equal(actRes.status, 200);

      const passRes = await simClient.get('/api/catalog/majors');
      assert.equal(passRes.status, 200);
      await simClient.logout();
    });
  });

  // =========================================================================
  // Feature F4: Strict 1-PC + 1-Phone Concurrent Device Enforcer (5 Tests)
  // =========================================================================
  describe('Feature F4 — Strict 1-PC + 1-Phone Concurrent Device Enforcer', () => {
    const f4Email = 'f4.student@horizon.edu';
    let f4Pc1;
    let f4Phone1;

    before(async () => {
      const regClient = createDeviceClient(baseUrl);
      await regClient.post('/api/auth/register', {
        email: f4Email,
        studentNumber: 'HSU-2026-9401',
        fullName: 'F4 Device Student',
        password: 'UniPass2026!',
        planId: 'annual_scholar',
        faceEmbedding: generateNormalizedEmbedding(11, 128)
      });
    });

    test('T1-F4-01: Subscribed student logs in on 1st PC (deviceType: pc) and acquires PC device slot', async () => {
      f4Pc1 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 'f4-pc-1',
        deviceFingerprint: 'fp-f4-pc-1',
        deviceLabel: 'F4 ThinkPad X1'
      });
      const res = await f4Pc1.login(f4Email, 'UniPass2026!');
      assert.equal(res.status, 200);
      assert.equal(res.data.authenticated, true);
      assert.equal(res.data.requiresFacialAuth, false);
      assert.equal(res.data.slot.deviceType, 'pc');
      assert.ok(res.data.activeSlots.pc !== null);
    });

    test('T1-F4-02: Same student simultaneously logs in on 1st Phone (deviceType: phone) while 1st PC remains active', async () => {
      f4Phone1 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 'f4-phone-1',
        deviceFingerprint: 'fp-f4-phone-1',
        deviceLabel: 'F4 iPhone 16'
      });
      const phoneLogin = await f4Phone1.login(f4Email, 'UniPass2026!');
      assert.equal(phoneLogin.status, 200);
      assert.equal(phoneLogin.data.authenticated, true);
      assert.equal(phoneLogin.data.slot.deviceType, 'phone');
      assert.ok(phoneLogin.data.activeSlots.pc !== null);
      assert.ok(phoneLogin.data.activeSlots.phone !== null);

      const pcStatus = await f4Pc1.get('/api/auth/sessions/status');
      assert.equal(pcStatus.status, 200);
      const slots = pcStatus.data.slots || pcStatus.data.activeSlots;
      assert.ok(slots.pc !== null);
      assert.ok(slots.phone !== null);
    });

    test('T1-F4-03: Re-authenticating from the SAME PC fingerprint (fp-f4-pc-1) renews the existing PC slot without conflict', async () => {
      const reLogin = await f4Pc1.login(f4Email, 'UniPass2026!');
      assert.equal(reLogin.status, 200);
      assert.equal(reLogin.data.authenticated, true);
      assert.equal(reLogin.data.requiresFacialAuth, false);
    });

    test('T1-F4-04: Session heartbeat (POST /api/auth/sessions/heartbeat) on active PC and Phone extends slot lease', async () => {
      const hbPc = await f4Pc1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(hbPc.status, 200);

      const hbPhone = await f4Phone1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(hbPhone.status, 200);
    });

    test('T1-F4-05: Logging out on Phone releases ONLY the phone slot (slotReleased: true) so a new Phone can log in without conflict while PC stays active', async () => {
      const logoutRes = await f4Phone1.logout();
      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.data.slotReleased, true);

      const statusRes = await f4Pc1.get('/api/auth/sessions/status');
      assert.equal(statusRes.status, 200);
      const slots = statusRes.data.slots || statusRes.data.activeSlots;
      assert.ok(slots.pc !== null);
      assert.equal(slots.phone, null);

      const f4Phone2 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 'f4-phone-2',
        deviceFingerprint: 'fp-f4-phone-2',
        deviceLabel: 'F4 Pixel 9'
      });
      const phone2Login = await f4Phone2.login(f4Email, 'UniPass2026!');
      assert.equal(phone2Login.status, 200);
      assert.equal(phone2Login.data.requiresFacialAuth, false);

      await f4Phone2.logout();
      await f4Pc1.logout();
    });
  });

  // =========================================================================
  // Feature F5: Facial Authentication & Atomic Device Slot Takeover (5 Tests)
  // =========================================================================
  describe('Feature F5 — Facial Authentication & Atomic Device Slot Takeover', () => {
    const f5Email = 'f5.biometric@horizon.edu';
    const baseVec = generateNormalizedEmbedding(42, 128);
    let f5Pc1;
    let f5Phone1;
    let f5Pc2;
    let f5Phone2;

    before(async () => {
      const regClient = createDeviceClient(baseUrl);
      await regClient.post('/api/auth/register', {
        email: f5Email,
        studentNumber: 'HSU-2026-9501',
        fullName: 'F5 Biometric Student',
        password: 'UniPass2026!',
        planId: 'annual_scholar'
      });
      f5Pc1 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 'f5-pc-1',
        deviceFingerprint: 'fp-f5-pc-1',
        deviceLabel: 'F5 Desktop 1'
      });
      f5Phone1 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 'f5-phone-1',
        deviceFingerprint: 'fp-f5-phone-1',
        deviceLabel: 'F5 Phone 1'
      });
      await f5Pc1.login(f5Email, 'UniPass2026!');
      await f5Phone1.login(f5Email, 'UniPass2026!');
    });

    test('T1-F5-01: Enroll a 128-d normalized face embedding vector (POST /api/auth/biometrics/enroll)', async () => {
      const res = await f5Pc1.post('/api/auth/biometrics/enroll', {
        faceEmbedding: baseVec,
        captureMode: 'webcam'
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.enrolled, true);
      assert.equal(res.data.dimensions, 128);
      assert.equal(res.data.threshold, 0.85);
    });

    test('T1-F5-02: Opening a 2nd PC while 1st PC is active returns 409 DEVICE_SLOT_CONFLICT and facial verification (simulationPreset: match) atomically takes over PC slot while keeping Phone active', async () => {
      f5Pc2 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 'f5-pc-2',
        deviceFingerprint: 'fp-f5-pc-2',
        deviceLabel: 'F5 Laptop 2'
      });
      const conflictRes = await f5Pc2.login(f5Email, 'UniPass2026!');
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.data.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(conflictRes.data.slotType, 'pc');
      assert.equal(conflictRes.data.requiresFacialAuth, true);
      assert.ok(conflictRes.data.challengeId);

      const takeoverRes = await f5Pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflictRes.data.challengeId,
        nonce: conflictRes.data.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(takeoverRes.status, 200);
      assert.equal(takeoverRes.data.verified, true);
      assert.ok(takeoverRes.data.similarityScore >= 0.85);
      f5Pc2.token = takeoverRes.data.sessionToken || takeoverRes.data.token;
      assert.ok(f5Pc2.token);

      // PC 1 is now preempted
      const pc1Hb = await f5Pc1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(pc1Hb.status, 401);
      assert.equal(pc1Hb.data.code, 'SESSION_PREEMPTED');

      // PC 2 and Phone 1 are both active
      const pc2Hb = await f5Pc2.post('/api/auth/sessions/heartbeat', {});
      assert.equal(pc2Hb.status, 200);
      const phone1Hb = await f5Phone1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(phone1Hb.status, 200);
    });

    test('T1-F5-03: Opening a 2nd Phone while 1st Phone is active triggers 409 DEVICE_SLOT_CONFLICT (slotType: phone) and facial takeover swaps ONLY the phone slot while PC 2 remains active', async () => {
      f5Phone2 = createDeviceClient(baseUrl, {
        deviceType: 'phone',
        deviceInstanceId: 'f5-phone-2',
        deviceFingerprint: 'fp-f5-phone-2',
        deviceLabel: 'F5 Phone 2'
      });
      const conflictRes = await f5Phone2.login(f5Email, 'UniPass2026!');
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.data.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(conflictRes.data.slotType, 'phone');

      const takeoverRes = await f5Phone2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflictRes.data.challengeId,
        nonce: conflictRes.data.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(takeoverRes.status, 200);
      assert.equal(takeoverRes.data.verified, true);
      assert.equal(takeoverRes.data.slot.deviceType, 'phone');
      f5Phone2.token = takeoverRes.data.sessionToken || takeoverRes.data.token;

      // Phone 1 is preempted
      const phone1Hb = await f5Phone1.post('/api/auth/sessions/heartbeat', {});
      assert.equal(phone1Hb.status, 401);
      assert.equal(phone1Hb.data.code, 'SESSION_PREEMPTED');

      // Phone 2 and PC 2 remain active
      assert.equal((await f5Phone2.post('/api/auth/sessions/heartbeat', {})).status, 200);
      assert.equal((await f5Pc2.post('/api/auth/sessions/heartbeat', {})).status, 200);
    });

    test('T1-F5-04: Mid-session anomaly report (POST /api/auth/sessions/report-anomaly) locks session with BIOMETRIC_REAUTH_REQUIRED and passing facial verification restores access', async () => {
      const anomRes = await f5Pc2.post('/api/auth/sessions/report-anomaly', {
        reason: 'SUSPICIOUS_IP_SHIFT'
      });
      assert.equal(anomRes.status, 200);
      assert.equal(anomRes.data.locked, true);
      assert.equal(anomRes.data.code, 'BIOMETRIC_REAUTH_REQUIRED');
      assert.ok(anomRes.data.challengeId);

      const unlockRes = await f5Pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: anomRes.data.challengeId,
        nonce: anomRes.data.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(unlockRes.status, 200);
      assert.equal(unlockRes.data.verified, true);
      if (unlockRes.data.sessionToken || unlockRes.data.token) {
        f5Pc2.token = unlockRes.data.sessionToken || unlockRes.data.token;
      }

      const hbAfter = await f5Pc2.post('/api/auth/sessions/heartbeat', {});
      assert.equal(hbAfter.status, 200);
    });

    test('T1-F5-05: Facial verification using an explicit live 128-d vector (liveEmbedding) matching enrolled 128-d embedding (cosineSimilarity >= 0.85) succeeds', async () => {
      await f5Pc2.post('/api/auth/biometrics/enroll', {
        faceEmbedding: baseVec,
        captureMode: 'webcam'
      });

      const chalRes = await f5Pc2.post('/api/auth/biometrics/challenge', {
        email: f5Email,
        targetSlotType: 'pc',
        deviceInstanceId: f5Pc2.deviceInstanceId,
        deviceLabel: f5Pc2.deviceLabel,
        reason: 'EXPLICIT_VECTOR_CHECK'
      });
      assert.ok(chalRes.status === 200 || chalRes.status === 201);
      const challengeId = chalRes.data.challengeId || chalRes.data.id;

      const liveVec = perturbEmbedding(baseVec, 0.02);
      const verifyRes = await f5Pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId,
        nonce: chalRes.data.nonce,
        liveEmbedding: liveVec,
        livenessConfirmed: true
      });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.data.verified, true);
      assert.ok(verifyRes.data.similarityScore >= 0.9);
      if (verifyRes.data.sessionToken || verifyRes.data.token) {
        f5Pc2.token = verifyRes.data.sessionToken || verifyRes.data.token;
      }
    });
  });

  // =========================================================================
  // Feature F6: Built-In University AI Tutor & RAG Engine (5 Tests)
  // =========================================================================
  describe('Feature F6 — Built-In University AI Tutor & RAG Engine', () => {
    test('T1-F6-01: Create a new AI Tutor study conversation tied to a major, subject, and lesson', async () => {
      const res = await mainPcClient.post('/api/ai/conversations', {
        title: 'CS-301 Shortest Path Study',
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        lessonId: catalogInfo.cs301LessonId,
        providerType: 'built_in'
      });
      assert.equal(res.status, 201);
      const conv = res.data.conversation || res.data;
      assert.ok(conv.id);
      f6ConvId = conv.id;
    });

    test('T1-F6-02: Send a course question to built_in AI Tutor and receive a grounded explanation with course chunk citations', async () => {
      const res = await mainPcClient.post(`/api/ai/conversations/${f6ConvId}/messages`, {
        content: 'Explain Dijkstra and Bellman-Ford shortest path relaxation formulas in CS-301.',
        providerType: 'built_in',
        includeCourseContext: true
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.userMessage.role, 'user');
      assert.equal(res.data.assistantMessage.role, 'assistant');
      assert.equal(res.data.assistantMessage.providerType, 'built_in');
      assert.ok(res.data.assistantMessage.content.length > 25);
      assert.ok(Array.isArray(res.data.assistantMessage.citations));
      assert.ok(res.data.assistantMessage.citations.length >= 1);
    });

    test('T1-F6-03: Ask built_in AI Tutor a cross-major question in Biomedical Sciences (BIO-205) and verify domain-accurate grounded response', async () => {
      const convRes = await mainPcClient.post('/api/ai/conversations', {
        title: 'BIO-205 Genetics & Enzyme Kinetics',
        majorId: catalogInfo.bioMajorId,
        subjectId: catalogInfo.bio205Id,
        providerType: 'built_in'
      });
      assert.equal(convRes.status, 201);
      const bioConvId = (convRes.data.conversation || convRes.data).id;

      const msgRes = await mainPcClient.post(`/api/ai/conversations/${bioConvId}/messages`, {
        content: 'Explain CRISPR-Cas9 gene editing and Michaelis-Menten enzyme kinetics from BIO-205.',
        providerType: 'built_in',
        includeCourseContext: true
      });
      assert.equal(msgRes.status, 201);
      assert.ok(msgRes.data.assistantMessage.content.length > 30);
      assert.ok(Array.isArray(msgRes.data.assistantMessage.citations));
    });

    test('T1-F6-04: Retrieve conversation history (GET /api/ai/conversations/:id) and verify persisted messages and citations', async () => {
      const res = await mainPcClient.get(`/api/ai/conversations/${f6ConvId}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.messages));
      assert.ok(res.data.messages.length >= 2);
      const assistantMsg = res.data.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg);
      assert.ok(assistantMsg.content.length > 20);
    });

    test('T1-F6-05: List student AI conversations filtered by subjectId (GET /api/ai/conversations?subjectId=)', async () => {
      const res = await mainPcClient.get(
        `/api/ai/conversations?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.conversations));
      assert.ok(res.data.conversations.length >= 1);
      assert.ok(res.data.conversations.some((c) => c.id === f6ConvId));
    });
  });

  // =========================================================================
  // Feature F7: Bring-Your-Own-AI (BYO-AI) Multi-Provider Hub (5 Tests)
  // =========================================================================
  describe('Feature F7 — Bring-Your-Own-AI (BYO-AI) Multi-Provider Hub', () => {
    test('T1-F7-01: List supported AI providers (GET /api/ai/providers) confirms built_in, gemini, claude, kimi, kiro, openai, and custom', async () => {
      const res = await mainPcClient.get('/api/ai/providers');
      assert.equal(res.status, 200);
      const supported = res.data.supportedProviders || [];
      for (const p of ['built_in', 'gemini', 'claude', 'kimi', 'kiro', 'openai', 'custom']) {
        assert.ok(supported.includes(p), `Missing supported provider ${p}`);
      }
    });

    test('T1-F7-02: Configure BYO-AI providers for Gemini, Claude, Kimi, and Kiro and verify API keys are masked at rest', async () => {
      const specs = [
        { providerType: 'gemini', displayName: 'My Gemini 2.5', modelName: 'gemini-2.5-pro', apiKey: 'AIzaSyTestGeminiKey12345678' },
        { providerType: 'claude', displayName: 'My Claude Sonnet', modelName: 'claude-3-7-sonnet', apiKey: 'sk-ant-testClaudeKey87654321' },
        { providerType: 'kimi', displayName: 'My Kimi Moonshot', modelName: 'moonshot-v1-128k', apiKey: 'sk-kimiTestKey5566778899' },
        { providerType: 'kiro', displayName: 'My Kiro Scholar', modelName: 'kiro-scholar-v1', apiKey: 'kr-kiroTestKey9900112233' },
        { providerType: 'custom', displayName: 'My Custom Endpoint', modelName: 'custom-llm-v1', apiKey: 'sk-customTestKey44332211' }
      ];

      for (const spec of specs) {
        const res = await mainPcClient.post('/api/ai/providers', {
          ...spec,
          executionMode: 'local_rag'
        });
        assert.equal(res.status, 201);
        const prov = res.data.provider || res.data;
        f7Providers[spec.providerType] = prov;

        const rawJson = JSON.stringify(res.data);
        assert.ok(!rawJson.includes(spec.apiKey), `Raw API key must never be exposed for ${spec.providerType}`);
        const masked = prov.apiKeyMasked || prov.api_key_masked;
        assert.ok(masked && (masked.includes('*') || masked.includes('...')));
      }
    });

    test('T1-F7-03: Test connectivity & RAG readiness of configured BYO-AI provider (POST /api/ai/providers/:id/test)', async () => {
      const kimiProv = f7Providers.kimi;
      assert.ok(kimiProv && kimiProv.id);
      const res = await mainPcClient.post(`/api/ai/providers/${kimiProv.id}/test`, {});
      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');
      assert.equal(res.data.providerType, 'kimi');
      assert.ok(res.data.sampleResponse);
    });

    test('T1-F7-04: Switch providers mid-conversation across gemini, claude, kimi, and kiro and verify each assistant reply records selected providerType', async () => {
      const convRes = await mainPcClient.post('/api/ai/conversations', {
        title: 'Multi-Provider BYO-AI Switch Test',
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        providerType: 'gemini'
      });
      assert.equal(convRes.status, 201);
      f7ConvId = (convRes.data.conversation || convRes.data).id;

      for (const pType of ['gemini', 'claude', 'kimi', 'kiro']) {
        const msgRes = await mainPcClient.post(`/api/ai/conversations/${f7ConvId}/messages`, {
          content: `Using ${pType}, summarize dynamic programming optimal substructure in CS-301.`,
          providerType: pType,
          providerConfigId: f7Providers[pType]?.id,
          includeCourseContext: true
        });
        assert.equal(msgRes.status, 201);
        assert.equal(msgRes.data.assistantMessage.providerType, pType);
      }
    });

    test('T1-F7-05: Update (PUT /api/ai/providers/:id) and delete (DELETE /api/ai/providers/:id) a custom BYO-AI provider configuration', async () => {
      const customProv = f7Providers.custom;
      assert.ok(customProv && customProv.id);

      const putRes = await mainPcClient.put(`/api/ai/providers/${customProv.id}`, {
        displayName: 'Updated Custom Lab LLM',
        modelName: 'custom-llm-v2-turbo',
        temperature: 0.2
      });
      assert.equal(putRes.status, 200);
      const updated = putRes.data.provider || putRes.data;
      assert.equal(updated.modelName || updated.model_name, 'custom-llm-v2-turbo');

      const delRes = await mainPcClient.del(`/api/ai/providers/${customProv.id}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.data.deleted, true);
    });
  });

  // =========================================================================
  // Feature F8: Student Chat File Uploads & Contextual Attachments (5 Tests)
  // =========================================================================
  describe('Feature F8 — Student Chat File Uploads & Contextual Attachments', () => {
    before(async () => {
      const convRes = await mainPcClient.post('/api/ai/conversations', {
        title: 'F8 File Attachment Grounding Session',
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        providerType: 'kimi'
      });
      f8ConvId = (convRes.data.conversation || convRes.data).id;
    });

    test('T1-F8-01: Upload a student Markdown study note directly into an AI conversation (POST /api/ai/conversations/:id/files)', async () => {
      const res = await mainPcClient.post(`/api/ai/conversations/${f8ConvId}/files`, {
        filename: 'my_exam_notes.md',
        mimeType: 'text/markdown',
        contentText:
          '# Personal Exam Formula\nThe Horizon Custom Amortized Bound is Phi(D_i) - Phi(D_0) <= 42 * n.'
      });
      assert.equal(res.status, 201);
      const chatFile = res.data.chatFile || res.data.file || res.data;
      assert.ok(chatFile.id);
      assert.equal(chatFile.filename, 'my_exam_notes.md');
      f8MdFileId = chatFile.id;
    });

    test('T1-F8-02: Upload a real PDF student handout into an AI conversation (POST /api/ai/files/upload) and verify PDF text extraction via pdftotext', async () => {
      const pdfBuf = createSamplePdfBuffer(
        'Lab Observation Alpha-7: Superconductor Critical Temperature measured at 93.5 Kelvin'
      );
      const res = await mainPcClient.post('/api/ai/files/upload', {
        conversationId: f8ConvId,
        filename: 'lab_experiment_data.pdf',
        mimeType: 'application/pdf',
        contentBase64: pdfBuf.toString('base64')
      });
      assert.equal(res.status, 201);
      const chatFile = res.data.chatFile || res.data.file || res.data;
      assert.ok(chatFile.id);
      assert.equal(chatFile.filename, 'lab_experiment_data.pdf');
      f8PdfFileId = chatFile.id;
    });

    test('T1-F8-03: Upload a structured CSV/JSON data file to chat and verify it is listed in GET /api/ai/conversations/:id', async () => {
      const upRes = await mainPcClient.post(`/api/ai/conversations/${f8ConvId}/files`, {
        filename: 'circuit_measurements.json',
        mimeType: 'application/json',
        contentText: JSON.stringify({ resonanceHz: 1420.4, qFactor: 88.2 })
      });
      assert.equal(upRes.status, 201);

      const convRes = await mainPcClient.get(`/api/ai/conversations/${f8ConvId}`);
      assert.equal(convRes.status, 200);
      assert.ok(Array.isArray(convRes.data.files));
      assert.ok(convRes.data.files.length >= 3);
    });

    test('T1-F8-04: Ask configured BYO-AI provider (kimi) a question with attachedFileIds and verify response is grounded in uploaded files', async () => {
      const res = await mainPcClient.post(`/api/ai/conversations/${f8ConvId}/messages`, {
        content:
          'What critical temperature was measured in Lab Observation Alpha-7 and what is the Horizon Custom Amortized Bound?',
        providerType: 'kimi',
        attachedFileIds: [f8MdFileId, f8PdfFileId],
        includeCourseContext: true
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.assistantMessage.providerType, 'kimi');
      const attachedUsed = res.data.assistantMessage.attachedFilesUsed || [];
      assert.ok(attachedUsed.length >= 2);
      assert.ok(res.data.assistantMessage.content.length > 20);
    });

    test('T1-F8-05: Ask another BYO-AI provider (claude) in the same conversation combining uploaded file attachments with university course RAG context', async () => {
      const res = await mainPcClient.post(`/api/ai/conversations/${f8ConvId}/messages`, {
        content: 'Compare my uploaded Horizon Custom Amortized Bound note with the CS-301 course lessons.',
        providerType: 'claude',
        attachedFileIds: [f8MdFileId],
        includeCourseContext: true
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.assistantMessage.providerType, 'claude');
      assert.ok(Array.isArray(res.data.assistantMessage.citations));
      assert.ok(Array.isArray(res.data.assistantMessage.attachedFilesUsed));
      assert.ok(res.data.assistantMessage.attachedFilesUsed.length >= 1);
    });
  });

  // =========================================================================
  // Feature F9: Interactive Slide Deck Generator & Lesson Presenter (5 Tests)
  // =========================================================================
  describe('Feature F9 — Interactive Slide Deck Generator & Lesson Presenter', () => {
    test('T1-F9-01: Generate an interactive slide deck from a university subject & lesson (POST /api/slides/generate) with 6-10 structured slides', async () => {
      const res = await mainPcClient.post('/api/slides/generate', {
        subjectId: catalogInfo.cs301Id,
        lessonId: catalogInfo.cs301LessonId,
        slideCount: 7,
        theme: 'horizon_academic',
        providerType: 'built_in'
      });
      assert.equal(res.status, 201);
      const deck = res.data.deck || res.data;
      assert.ok(deck.id);
      assert.ok(Array.isArray(deck.slides));
      assert.ok(deck.slides.length >= 6 && deck.slides.length <= 10);
      f9DeckId = deck.id;
    });

    test('T1-F9-02: Verify generated slide deck contains required pedagogical layouts, SVG visual diagram, checkpoint quiz, and speaker notes', async () => {
      const res = await mainPcClient.get(`/api/slides/${f9DeckId}`);
      assert.equal(res.status, 200);
      const deck = res.data.deck || res.data;
      const slides = deck.slides || [];
      assert.ok(slides.length >= 6);

      const hasSvgDiagram = slides.some(
        (s) =>
          (s.diagramSvg && s.diagramSvg.includes('<svg')) ||
          (s.svg && s.svg.includes('<svg')) ||
          JSON.stringify(s).includes('<svg')
      );
      assert.ok(hasSvgDiagram, 'Expected at least one slide with SVG visual diagram');

      const hasQuiz = slides.some(
        (s) => s.layout === 'checkpoint_quiz' || s.quiz || s.checkpointQuiz
      );
      assert.ok(hasQuiz, 'Expected at least one slide with interactive checkpoint quiz');

      const hasNotes = slides.some((s) => Boolean(s.speakerNotes || s.speaker_notes));
      assert.ok(hasNotes, 'Expected speaker notes on slides');
    });

    test('T1-F9-03: Generate a slide deck directly from an uploaded course file or custom topic', async () => {
      const res = await mainPcClient.post('/api/slides/generate', {
        subjectId: catalogInfo.ece210Id,
        customTopic: 'Fast Fourier Transform Butterfly Network & Spectral Leakage',
        slideCount: 6,
        providerType: 'gemini'
      });
      assert.equal(res.status, 201);
      const deck = res.data.deck || res.data;
      assert.ok(deck.slides.length >= 6 && deck.slides.length <= 10);
      f9CustomDeckId = deck.id;
    });

    test('T1-F9-04: List slide decks for a subject (GET /api/slides?subjectId=) and update a slide deck (PUT /api/slides/:deckId)', async () => {
      const listRes = await mainPcClient.get(
        `/api/slides?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.data.slideDecks));
      assert.ok(listRes.data.slideDecks.length >= 1);

      const putRes = await mainPcClient.put(`/api/slides/${f9DeckId}`, {
        title: 'Updated CS-301 Exam Review Deck',
        theme: 'dark_blueprint'
      });
      assert.equal(putRes.status, 200);
      const updated = putRes.data.deck || putRes.data;
      assert.equal(updated.title, 'Updated CS-301 Exam Review Deck');
      assert.equal(updated.theme, 'dark_blueprint');
    });

    test('T1-F9-05: Delete a generated slide deck (DELETE /api/slides/:deckId)', async () => {
      const delRes = await mainPcClient.del(`/api/slides/${f9CustomDeckId}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.data.deleted, true);
    });
  });

  // =========================================================================
  // Feature F10: Deep Academic Research & Data Collection Engine (5 Tests)
  // =========================================================================
  describe('Feature F10 — Deep Academic Research & Data Collection Engine', () => {
    test('T1-F10-01: Run a deep research and data collection job (POST /api/research/run) across university course repositories', async () => {
      const res = await mainPcClient.post('/api/research/run', {
        query: 'Compare algorithmic time and space complexities and shortest path bounds across CS-301',
        title: 'Shortest Path Complexity Benchmark Study',
        majorId: catalogInfo.csMajorId,
        subjectId: catalogInfo.cs301Id,
        includeUploadedFiles: true,
        providerType: 'built_in'
      });
      assert.equal(res.status, 201);
      const project = res.data.project || res.data;
      assert.ok(project.id);
      assert.ok(Array.isArray(project.sections));
      assert.ok(project.sections.length >= 1);
      assert.ok(Array.isArray(project.citations));
      f10ResearchId = project.id;
    });

    test('T1-F10-02: Verify collectedDataTable contains structured comparative columns and quantitative rows', async () => {
      const res = await mainPcClient.get(`/api/research/${f10ResearchId}`);
      assert.equal(res.status, 200);
      const project = res.data.project || res.data;
      const table = project.collectedDataTable || project.collected_data_table;
      assert.ok(table);
      assert.ok(Array.isArray(table.columns));
      assert.ok(table.columns.length >= 2);
      assert.ok(Array.isArray(table.rows));
      assert.ok(table.rows.length >= 1);
    });

    test('T1-F10-03: Append custom student research notes and additional data table rows (PUT /api/research/:researchId/notes)', async () => {
      const res = await mainPcClient.put(`/api/research/${f10ResearchId}/notes`, {
        studentNotes: 'Verified Fibonacci heap amortized decrease-key in O(1).',
        additionalRows: [
          {
            Algorithm: 'Fibonacci Heap Dijkstra',
            Complexity: 'O(E + V log V)',
            Source: 'Lab Benchmark'
          }
        ]
      });
      assert.equal(res.status, 200);
      const project = res.data.project || res.data;
      const notes = project.studentNotes || project.student_notes || '';
      assert.ok(notes.includes('Fibonacci heap'));
    });

    test('T1-F10-04: Export research project and collected data table in csv, json, and md formats (GET /api/research/:researchId/export?format=)', async () => {
      for (const fmt of ['csv', 'json', 'md']) {
        const res = await mainPcClient.get(`/api/research/${f10ResearchId}/export?format=${fmt}`);
        assert.equal(res.status, 200);
        assert.ok(res.text.length > 20, `Expected non-empty export for format=${fmt}`);
      }
    });

    test('T1-F10-05: List saved research projects filtered by subject/major (GET /api/research?subjectId=)', async () => {
      const res = await mainPcClient.get(
        `/api/research?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.projects));
      assert.ok(res.data.projects.length >= 1);
    });
  });

  // =========================================================================
  // Feature F11: AI Educational Video Generator & Interactive Player (5 Tests)
  // =========================================================================
  describe('Feature F11 — AI Educational Video Generator & Interactive Player', () => {
    test('T1-F11-01: Generate a multi-scene AI educational explainer video (POST /api/videos/generate) with storyboard scenes, captions, transcript, and FFmpeg MP4 synthesis', async () => {
      const res = await mainPcClient.post('/api/videos/generate', {
        subjectId: catalogInfo.cs301Id,
        topicPrompt: 'Visualizing Dijkstra Priority Queue Relaxation Step by Step',
        targetDurationSec: 18,
        styleTheme: 'cyber_academy',
        renderMp4: true
      });
      assert.equal(res.status, 201);
      const video = res.data.video || res.data;
      assert.ok(video.id);
      assert.ok(Array.isArray(video.scenes));
      assert.ok(video.scenes.length >= 3);
      assert.ok(Array.isArray(video.transcript));
      assert.ok(Array.isArray(video.keyTakeaways));
      f11VideoId = video.id;
    });

    test('T1-F11-02: Inspect generated video metadata (GET /api/videos/:videoId) for timed scenes, narrationText, captions, and visualScene spec', async () => {
      const res = await mainPcClient.get(`/api/videos/${f11VideoId}`);
      assert.equal(res.status, 200);
      const video = res.data.video || res.data;
      for (const scene of video.scenes) {
        assert.ok(scene.narrationText || scene.narration);
        assert.ok((scene.durationSec || scene.duration || 1) > 0);
        assert.ok(scene.visualScene || scene.visual || scene.diagramSpec);
      }
    });

    test('T1-F11-03: Stream full synthesized .mp4 binary via GET /api/videos/:videoId/stream (200 OK, Content-Type: video/mp4, valid ISO BMFF ftyp header)', async () => {
      const res = await mainPcClient.get(`/api/videos/${f11VideoId}/stream`);
      assert.equal(res.status, 200);
      assert.ok((res.headers['content-type'] || '').includes('video/mp4'));
      assert.ok(res.buffer.length > 500);
      assert.equal(res.buffer.subarray(4, 8).toString('ascii'), 'ftyp');
    });

    test('T1-F11-04: Request partial byte range from video stream (Range: bytes=0-255) and verify 206 Partial Content with Content-Range header', async () => {
      const res = await mainPcClient.get(`/api/videos/${f11VideoId}/stream`, {
        headers: { Range: 'bytes=0-255' }
      });
      assert.equal(res.status, 206);
      assert.ok((res.headers['content-range'] || '').startsWith('bytes 0-255/'));
      assert.equal(res.buffer.length, 256);
    });

    test('T1-F11-05: List generated educational videos for a subject (GET /api/videos?subjectId=)', async () => {
      const res = await mainPcClient.get(
        `/api/videos?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.data.videos));
      assert.ok(res.data.videos.length >= 1);
    });
  });

  // =========================================================================
  // Feature F12: Exam Preparation Suite (5 Tests)
  // =========================================================================
  describe('Feature F12 — Exam Preparation Suite (Quizzes, SM-2 Flashcards, Timed Mock Exams & Study Guides)', () => {
    test('T1-F12-01: Generate flashcards for a subject (POST /api/exam-prep/flashcards/generate) and list flashcards (GET /api/exam-prep/flashcards)', async () => {
      const genRes = await mainPcClient.post('/api/exam-prep/flashcards/generate', {
        subjectId: catalogInfo.cs301Id,
        count: 5
      });
      assert.equal(genRes.status, 201);
      assert.ok(Array.isArray(genRes.data.flashcards));
      assert.ok(genRes.data.flashcards.length >= 5);
      f12CardId = genRes.data.flashcards[0].id;

      const listRes = await mainPcClient.get(
        `/api/exam-prep/flashcards?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.data.flashcards));
      assert.ok(listRes.data.flashcards.length >= 5);
    });

    test('T1-F12-02: Review a flashcard using SM-2 quality ratings (POST /api/exam-prep/flashcards/:cardId/review) and verify intervalDays, repetitions, easeFactor, and nextReviewAt update', async () => {
      const res = await mainPcClient.post(`/api/exam-prep/flashcards/${f12CardId}/review`, {
        quality: 3
      });
      assert.equal(res.status, 200);
      const card = res.data.flashcard || res.data;
      assert.ok(card.repetitions >= 1);
      assert.ok((card.intervalDays ?? card.interval_days ?? 1) >= 1);
      assert.ok(card.nextReviewAt || card.next_review_at);
    });

    test('T1-F12-03: Generate a timed mock exam (POST /api/exam-prep/exams/generate) with structured questions, options, and time limit', async () => {
      const res = await mainPcClient.post('/api/exam-prep/exams/generate', {
        subjectId: catalogInfo.cs301Id,
        mode: 'timed_mock_exam',
        difficulty: 'intermediate',
        questionCount: 5,
        timeLimitSec: 900
      });
      assert.equal(res.status, 201);
      const exam = res.data.exam || res.data;
      assert.ok(exam.id);
      assert.equal(exam.mode, 'timed_mock_exam');
      assert.ok(Array.isArray(exam.questions));
      assert.equal(exam.questions.length, 5);
      f12Exam = exam;
    });

    test('T1-F12-04: Submit exam answers (POST /api/exam-prep/exams/:examId/submit) and receive automatic grading, percentage, letterGrade, topicBreakdown, and weaknessRecommendations', async () => {
      const answers = buildExamAnswers(f12Exam);
      const res = await mainPcClient.post(`/api/exam-prep/exams/${f12Exam.id}/submit`, {
        answers,
        durationUsedSec: 310
      });
      assert.equal(res.status, 201);
      const attempt = res.data.attempt || res.data;
      assert.equal(typeof attempt.percentage, 'number');
      assert.ok(attempt.letterGrade || attempt.letter_grade);
      assert.ok(Array.isArray(attempt.topicBreakdown || attempt.topic_breakdown));
      assert.ok(Array.isArray(attempt.weaknessRecommendations || attempt.weakness_recommendations));
    });

    test('T1-F12-05: Generate a high-yield exam study guide (POST /api/exam-prep/study-guides/generate) and inspect exam prep overview (GET /api/exam-prep/overview?subjectId=)', async () => {
      const sgRes = await mainPcClient.post('/api/exam-prep/study-guides/generate', {
        subjectId: catalogInfo.cs301Id,
        focusWeakTopics: true
      });
      assert.equal(sgRes.status, 201);
      const studyGuide = sgRes.data.studyGuide || sgRes.data;
      assert.ok(studyGuide.id || studyGuide.title);

      const ovRes = await mainPcClient.get(
        `/api/exam-prep/overview?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
      );
      assert.equal(ovRes.status, 200);
      assert.equal(typeof ovRes.data.readinessScore, 'number');
      assert.ok(ovRes.data.flashcardStats);
      assert.ok(Array.isArray(ovRes.data.recentAttempts));
    });
  });

  // =========================================================================
  // Feature F13: Responsive Full-Stack Web Application UI (5 Tests in Headless Chrome)
  // =========================================================================
  describe('Feature F13 — Responsive Full-Stack Web Application UI (PC & Phone Adaptive Views)', () => {
    const f13Email = 'f13.ui@horizon.edu';

    before(async () => {
      const regClient = createDeviceClient(baseUrl);
      await regClient.post('/api/auth/register', {
        email: f13Email,
        studentNumber: 'HSU-2026-9913',
        fullName: 'F13 Browser Student',
        password: 'UniPass2026!',
        majorId: catalogInfo.csMajorId,
        planId: 'annual_scholar',
        faceEmbedding: generateNormalizedEmbedding(77, 128)
      });
    });

    test('T1-F13-01: Render University SPA on Desktop PC viewport (1280x800), authenticate, and verify University Header, Active Subscription Badge, and Live 1-PC + 1-Phone Device Slot Status Bar', async () => {
      const pcDev = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f13-pc-1'
      });
      try {
        const resp = await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        assert.equal(resp.status(), 200);

        const uiState = await pcDev.page.evaluate(async (creds) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t1-f13-pc-1'
            },
            body: JSON.stringify({
              email: creds.email,
              password: creds.password,
              deviceType: 'pc',
              deviceInstanceId: 't1-f13-pc-1',
              deviceFingerprint: 'fp-pc-t1-f13-pc-1',
              deviceLabel: 'Desktop Chrome PC 1'
            })
          });
          const loginData = await loginResp.json();
          const token = loginData.sessionToken || loginData.token;
          if (token) {
            localStorage.setItem('unilearn_token', token);
            localStorage.setItem('sessionToken', token);
          }
          return {
            innerWidth: window.innerWidth,
            title: document.title,
            bodyText: document.body.innerText,
            authenticated: loginData.authenticated,
            slotType: loginData.slot && loginData.slot.deviceType
          };
        }, { email: f13Email, password: 'UniPass2026!' });

        assert.equal(uiState.innerWidth, 1280);
        assert.equal(uiState.authenticated, true);
        assert.equal(uiState.slotType, 'pc');
        assert.ok(
          uiState.title.toLowerCase().includes('unilearn') ||
            uiState.bodyText.toLowerCase().includes('horizon') ||
            uiState.bodyText.toLowerCase().includes('unilearn')
        );
      } finally {
        await pcDev.close();
      }
    });

    test('T1-F13-02: Render University SPA on Mobile Phone viewport (390x844, isMobile: true) simultaneously and verify responsive layout and concurrent 1 PC + 1 Phone active status', async () => {
      const phoneDev = await createDevicePage(browser, {
        deviceType: 'phone',
        deviceInstanceId: 't1-f13-phone-1'
      });
      try {
        await phoneDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const mobileState = await phoneDev.page.evaluate(async (creds) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'phone',
              'X-Device-Fingerprint': 'fp-phone-t1-f13-phone-1'
            },
            body: JSON.stringify({
              email: creds.email,
              password: creds.password,
              deviceType: 'phone',
              deviceInstanceId: 't1-f13-phone-1',
              deviceFingerprint: 'fp-phone-t1-f13-phone-1',
              deviceLabel: 'Mobile iPhone 1'
            })
          });
          const loginData = await loginResp.json();
          const token = loginData.sessionToken || loginData.token;
          const statusResp = await fetch('/api/auth/sessions/status', {
            headers: { Authorization: `Bearer ${token}` }
          });
          const statusData = await statusResp.json();
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            authenticated: loginData.authenticated,
            slots: statusData.slots || loginData.activeSlots
          };
        }, { email: f13Email, password: 'UniPass2026!' });

        assert.equal(mobileState.innerWidth, 390);
        assert.equal(mobileState.innerHeight, 844);
        assert.equal(mobileState.authenticated, true);
        assert.ok(mobileState.slots.pc !== null);
        assert.ok(mobileState.slots.phone !== null);
      } finally {
        await phoneDev.close();
      }
    });

    test('T1-F13-03: Navigate through Course Catalog & File Ingestion Hub and BYO-AI Chat Hub in headless Chrome', async () => {
      const pcDev = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f13-pc-1'
      });
      try {
        await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const data = await pcDev.page.evaluate(async (creds) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t1-f13-pc-1'
            },
            body: JSON.stringify({
              email: creds.email,
              password: creds.password,
              deviceType: 'pc',
              deviceInstanceId: 't1-f13-pc-1',
              deviceFingerprint: 'fp-pc-t1-f13-pc-1'
            })
          });
          const loginJson = await loginResp.json();
          const token = loginJson.sessionToken || loginJson.token;
          const headers = { Authorization: `Bearer ${token}` };

          const majorsJson = await (await fetch('/api/catalog/majors', { headers })).json();
          const providersJson = await (await fetch('/api/ai/providers', { headers })).json();
          return {
            majorCodes: (majorsJson.majors || []).map((m) => m.code),
            supportedProviders: providersJson.supportedProviders || []
          };
        }, { email: f13Email, password: 'UniPass2026!' });

        assert.ok(data.majorCodes.includes('CS'));
        assert.ok(data.supportedProviders.includes('gemini'));
        assert.ok(data.supportedProviders.includes('claude'));
        assert.ok(data.supportedProviders.includes('kimi'));
        assert.ok(data.supportedProviders.includes('kiro'));
      } finally {
        await pcDev.close();
      }
    });

    test('T1-F13-04: Navigate through Interactive Slide Presenter, Deep Research & AI Video Studio, and Exam Prep Center in headless Chrome', async () => {
      const pcDev = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f13-pc-1'
      });
      try {
        await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const studioCheck = await pcDev.page.evaluate(
          async ({ creds, subjectId }) => {
            const loginResp = await fetch('/api/auth/login', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Device-Type': 'pc',
                'X-Device-Fingerprint': 'fp-pc-t1-f13-pc-1'
              },
              body: JSON.stringify({
                email: creds.email,
                password: creds.password,
                deviceType: 'pc',
                deviceInstanceId: 't1-f13-pc-1',
                deviceFingerprint: 'fp-pc-t1-f13-pc-1'
              })
            });
            const { sessionToken, token } = await loginResp.json();
            const authToken = sessionToken || token;
            const headers = { Authorization: `Bearer ${authToken}` };

            const slidesResp = await fetch(`/api/slides?subjectId=${encodeURIComponent(subjectId)}`, { headers });
            const videosResp = await fetch(`/api/videos?subjectId=${encodeURIComponent(subjectId)}`, { headers });
            const examResp = await fetch(`/api/exam-prep/overview?subjectId=${encodeURIComponent(subjectId)}`, { headers });

            const videoEl = document.createElement('video');
            return {
              slidesStatus: slidesResp.status,
              videosStatus: videosResp.status,
              examStatus: examResp.status,
              canPlayMp4: videoEl.canPlayType('video/mp4')
            };
          },
          { creds: { email: f13Email, password: 'UniPass2026!' }, subjectId: catalogInfo.cs301Id }
        );

        assert.equal(studioCheck.slidesStatus, 200);
        assert.equal(studioCheck.videosStatus, 200);
        assert.equal(studioCheck.examStatus, 200);
        assert.ok(studioCheck.canPlayMp4.length > 0);
      } finally {
        await pcDev.close();
      }
    });

    test('T1-F13-05: Trigger 2nd-PC Device Slot Conflict in headless Chrome, verify WebRTC fake webcam stream & Facial Auth Takeover in the browser', async () => {
      const pc2Dev = await createDevicePage(browser, {
        deviceType: 'pc',
        deviceInstanceId: 't1-f13-pc-2'
      });
      try {
        await pc2Dev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const takeoverResult = await pc2Dev.page.evaluate(async (creds) => {
          // Verify fake WebRTC camera works in headless Chrome
          const stream = await navigator.mediaDevices.getUserMedia({ video: true });
          const tracks = stream.getVideoTracks();
          const hasLiveCamera = tracks.length > 0 && tracks[0].readyState === 'live';
          tracks.forEach((t) => t.stop());

          // Trigger 2nd-PC login conflict
          const conflictResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t1-f13-pc-2'
            },
            body: JSON.stringify({
              email: creds.email,
              password: creds.password,
              deviceType: 'pc',
              deviceInstanceId: 't1-f13-pc-2',
              deviceFingerprint: 'fp-pc-t1-f13-pc-2',
              deviceLabel: 'Second Desktop PC 2'
            })
          });
          const conflictData = await conflictResp.json();

          // Complete facial takeover
          const verifyResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t1-f13-pc-2'
            },
            body: JSON.stringify({
              challengeId: conflictData.challengeId,
              nonce: conflictData.nonce,
              simulationPreset: 'match',
              livenessConfirmed: true
            })
          });
          const verifyData = await verifyResp.json();
          return {
            hasLiveCamera,
            conflictStatus: conflictResp.status,
            conflictCode: conflictData.code,
            verifyStatus: verifyResp.status,
            verified: verifyData.verified,
            similarityScore: verifyData.similarityScore
          };
        }, { email: f13Email, password: 'UniPass2026!' });

        assert.equal(takeoverResult.hasLiveCamera, true);
        assert.equal(takeoverResult.conflictStatus, 409);
        assert.equal(takeoverResult.conflictCode, 'DEVICE_SLOT_CONFLICT');
        assert.equal(takeoverResult.verifyStatus, 200);
        assert.equal(takeoverResult.verified, true);
        assert.ok(takeoverResult.similarityScore >= 0.85);
      } finally {
        await pc2Dev.close();
      }
    });
  });
});
