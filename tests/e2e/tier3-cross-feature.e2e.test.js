import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAS,
  startE2EServer,
  createDeviceClient,
  createSamplePdfBuffer,
  generateNormalizedEmbedding
} from '../helpers/browserHarness.js';

async function resolveCatalogIds(client) {
  const majorsRes = await client.get('/api/catalog/majors');
  assert.equal(majorsRes.status, 200);
  const majors = majorsRes.data.majors || [];
  const csMajor = majors.find((m) => m.code === 'CS') || majors[0];

  const subjRes = await client.get('/api/catalog/subjects');
  assert.equal(subjRes.status, 200);
  const subjects = subjRes.data.subjects || [];
  const cs301 = subjects.find((s) => s.code === 'CS-301') || subjects[0];

  return {
    csMajorId: csMajor ? csMajor.id : 'CS',
    cs301Id: cs301 ? cs301.id : 'CS-301'
  };
}

function buildPartialExamAnswers(exam) {
  const answers = {};
  const questions = (exam && exam.questions) || [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const key = q.id || q.questionId || String(i);
    if (i % 2 === 0) {
      // Correct answer for even-indexed questions
      if (q.correctAnswer !== undefined) answers[key] = q.correctAnswer;
      else if (q.correctOption !== undefined) answers[key] = q.correctOption;
      else if (q.answer !== undefined) answers[key] = q.answer;
      else if (Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0) {
        answers[key] = q.acceptableAnswers[0];
      } else if (Array.isArray(q.options) && q.options.length > 0) {
        const opt = q.options[0];
        answers[key] = typeof opt === 'object' && opt !== null ? opt.id || opt.value || opt.text : opt;
      }
    } else {
      // Intentionally wrong answer for odd-indexed questions
      answers[key] = '__INTENTIONALLY_INCORRECT_OPTION_999__';
    }
  }
  return answers;
}

describe('Tier 3 — Cross-Feature Pairwise & Multi-Feature Integration Workflows (16 Tests)', () => {
  let server;
  let baseUrl;
  let catalogInfo;
  let sharedClient;

  before(async () => {
    server = await startE2EServer({ seed: true });
    baseUrl = server.baseUrl;
    sharedClient = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 't3-shared-pc'
    });
    await sharedClient.login(PERSONAS.amina.email, PERSONAS.amina.password);
    catalogInfo = await resolveCatalogIds(sharedClient);
  });

  after(async () => {
    if (server) {
      await server.close();
    }
  });

  test('T3-CF-01: [F1 + F3 + F2] University Onboarding -> Unsubscribed 402 Gate -> Scholarship Voucher Activation (HSU-SCHOLAR-2026) -> Full Catalog & Search Access', async () => {
    const client = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf01-pc-1'
    });

    // 1. Non-university domain rejected
    const rejectRes = await client.post('/api/auth/register', {
      email: 'outsider@gmail.com',
      fullName: 'Outsider',
      password: 'UniPass2026!'
    });
    assert.equal(rejectRes.status, 403);
    assert.equal(rejectRes.data.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');

    // 2. Register valid HSU email without planId (unsubscribed)
    const regRes = await client.post('/api/auth/register', {
      email: 'new.scholar.cf01@horizon.edu',
      studentNumber: 'HSU-2026-7001',
      fullName: 'CF01 Scholar',
      password: 'UniPass2026!'
    });
    assert.equal(regRes.status, 201);

    // 3. Login succeeds
    const loginRes = await client.login('new.scholar.cf01@horizon.edu', 'UniPass2026!');
    assert.equal(loginRes.status, 200);

    // 4. Protected Catalog & Search routes return 402 Payment Required
    const blockedMajors = await client.get('/api/catalog/majors');
    assert.equal(blockedMajors.status, 402);
    assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(blockedMajors.data.code));

    const blockedSearch = await client.get('/api/catalog/search?q=algorithm');
    assert.equal(blockedSearch.status, 402);

    // 5. Activate via scholarship voucher HSU-SCHOLAR-2026
    const actRes = await client.post('/api/subscription/activate', {
      planId: 'department_sponsored',
      voucherCode: 'HSU-SCHOLAR-2026'
    });
    assert.equal(actRes.status, 200);
    assert.equal(actRes.data.status || actRes.data.subscription?.status, 'active');

    // 6. Retry Catalog & Subjects -> 200 OK
    const majorsRes = await client.get('/api/catalog/majors');
    assert.equal(majorsRes.status, 200);
    assert.ok(majorsRes.data.majors.length >= 4);

    const subjRes = await client.get('/api/catalog/subjects');
    assert.equal(subjRes.status, 200);
    assert.ok(subjRes.data.subjects.length >= 8);
  });

  test('T3-CF-02: [F4 + F5 + F1] 1st PC + 1st Phone Concurrent Access -> 2nd PC Conflict (409) -> Facial Auth match Takeover -> 1st PC Preempted (401 SESSION_PREEMPTED) While 1st Phone Stays Active (200 OK)', async () => {
    const email = 'cf02.student@horizon.edu';
    const regClient = createDeviceClient(baseUrl);
    await regClient.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7002',
      fullName: 'CF02 MultiDevice',
      password: 'UniPass2026!',
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(2, 128)
    });

    const pc1 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf02-pc-1',
      deviceFingerprint: 'fp-cf02-pc-1'
    });
    const phone1 = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf02-phone-1',
      deviceFingerprint: 'fp-cf02-phone-1'
    });

    assert.equal((await pc1.login(email, 'UniPass2026!')).status, 200);
    assert.equal((await phone1.login(email, 'UniPass2026!')).status, 200);
    assert.equal((await pc1.get('/api/catalog/majors')).status, 200);
    assert.equal((await phone1.get('/api/catalog/majors')).status, 200);

    const pc2 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf02-pc-2',
      deviceFingerprint: 'fp-cf02-pc-2'
    });
    const conflict = await pc2.login(email, 'UniPass2026!');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'DEVICE_SLOT_CONFLICT');
    assert.equal(conflict.data.slotType, 'pc');

    const takeover = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
      challengeId: conflict.data.challengeId,
      nonce: conflict.data.nonce,
      simulationPreset: 'match',
      livenessConfirmed: true
    });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.data.verified, true);
    pc2.token = takeover.data.sessionToken || takeover.data.token;

    const pc1Check = await pc1.post('/api/auth/sessions/heartbeat', {});
    assert.equal(pc1Check.status, 401);
    assert.equal(pc1Check.data.code, 'SESSION_PREEMPTED');
    assert.equal(pc1Check.data.reason, 'FACIAL_AUTH_SLOT_TAKEOVER');

    assert.equal((await phone1.post('/api/auth/sessions/heartbeat', {})).status, 200);
    assert.equal((await phone1.get('/api/catalog/majors')).status, 200);
    assert.equal((await pc2.get('/api/catalog/majors')).status, 200);
  });

  test('T3-CF-03: [F4 + F5 + F6] 2nd Phone Conflict (409) -> Facial Auth impostor Rejected (403) -> Facial Auth match Takeover Preempts 1st Phone While Active PC Continues AI Tutoring (200 OK)', async () => {
    const email = 'cf03.student@horizon.edu';
    const regClient = createDeviceClient(baseUrl);
    await regClient.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7003',
      fullName: 'CF03 Phone Takeover',
      password: 'UniPass2026!',
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(3, 128)
    });

    const pc1 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf03-pc-1',
      deviceFingerprint: 'fp-cf03-pc-1'
    });
    const phone1 = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf03-phone-1',
      deviceFingerprint: 'fp-cf03-phone-1'
    });
    await pc1.login(email, 'UniPass2026!');
    await phone1.login(email, 'UniPass2026!');

    const phone2 = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf03-phone-2',
      deviceFingerprint: 'fp-cf03-phone-2'
    });
    const conflict1 = await phone2.login(email, 'UniPass2026!');
    assert.equal(conflict1.status, 409);
    assert.equal(conflict1.data.slotType, 'phone');

    const impostorRes = await phone2.post('/api/auth/biometrics/verify-and-takeover', {
      challengeId: conflict1.data.challengeId,
      nonce: conflict1.data.nonce,
      simulationPreset: 'impostor',
      livenessConfirmed: true
    });
    assert.equal(impostorRes.status, 403);
    assert.equal(impostorRes.data.code, 'BIOMETRIC_VERIFICATION_FAILED');

    // Phone 1 still active
    assert.equal((await phone1.get('/api/auth/sessions/status')).status, 200);

    // Re-trigger challenge and pass with match
    const conflict2 = await phone2.login(email, 'UniPass2026!');
    assert.equal(conflict2.status, 409);
    const matchRes = await phone2.post('/api/auth/biometrics/verify-and-takeover', {
      challengeId: conflict2.data.challengeId,
      nonce: conflict2.data.nonce,
      simulationPreset: 'match',
      livenessConfirmed: true
    });
    assert.equal(matchRes.status, 200);
    phone2.token = matchRes.data.sessionToken || matchRes.data.token;

    // Phone 1 preempted, Phone 2 and PC 1 active
    assert.equal((await phone1.post('/api/auth/sessions/heartbeat', {})).status, 401);
    assert.equal((await phone2.get('/api/ai/providers')).status, 200);
    assert.equal((await pc1.get('/api/ai/providers')).status, 200);
  });

  test('T3-CF-04: [F4 + F5 Real-Time SSE] Live SSE Stream (/api/auth/sessions/events) on 1st PC Receives Real-Time session_preempted Push Upon 2nd PC Facial Auth Takeover', async () => {
    const email = 'cf04.sse@horizon.edu';
    const regClient = createDeviceClient(baseUrl);
    await regClient.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7004',
      fullName: 'CF04 SSE Student',
      password: 'UniPass2026!',
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(4, 128)
    });

    const pc1 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf04-pc-1',
      deviceFingerprint: 'fp-cf04-pc-1'
    });
    await pc1.login(email, 'UniPass2026!');

    const sse = await pc1.openSSE('/api/auth/sessions/events');
    try {
      assert.equal(sse.status, 200);

      const pc2 = createDeviceClient(baseUrl, {
        deviceType: 'pc',
        deviceInstanceId: 'cf04-pc-2',
        deviceFingerprint: 'fp-cf04-pc-2'
      });
      const conflict = await pc2.login(email, 'UniPass2026!');
      assert.equal(conflict.status, 409);

      const verify = await pc2.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: conflict.data.challengeId,
        nonce: conflict.data.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(verify.status, 200);

      const preemptEvt = await sse.waitForEvent(
        (e) =>
          e.event === 'session_preempted' ||
          JSON.stringify(e).includes('SESSION_PREEMPTED') ||
          JSON.stringify(e).includes('session_preempted'),
        3000
      );
      assert.ok(preemptEvt);
    } finally {
      await sse.close();
    }
  });

  test('T3-CF-05: [F4 + F5 + F9] Mid-Session Security Anomaly Locks Protected Slide/Course Routes (403 BIOMETRIC_REAUTH_REQUIRED) Until Facial Re-Verification', async () => {
    const email = 'cf05.anomaly@horizon.edu';
    const client = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf05-pc-1',
      deviceFingerprint: 'fp-cf05-pc-1'
    });
    await client.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7005',
      fullName: 'CF05 Anomaly Student',
      password: 'UniPass2026!',
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(5, 128)
    });
    await client.login(email, 'UniPass2026!');

    const anomRes = await client.post('/api/auth/sessions/report-anomaly', {
      reason: 'SUSPICIOUS_LOCATION_CHANGE'
    });
    assert.equal(anomRes.status, 200);
    assert.equal(anomRes.data.locked, true);
    assert.equal(anomRes.data.code, 'BIOMETRIC_REAUTH_REQUIRED');

    const blockedSlides = await client.post('/api/slides/generate', {
      subjectId: catalogInfo.cs301Id,
      slideCount: 6
    });
    assert.equal(blockedSlides.status, 403);
    assert.equal(blockedSlides.data.code, 'BIOMETRIC_REAUTH_REQUIRED');

    const unlockRes = await client.post('/api/auth/biometrics/verify-and-takeover', {
      challengeId: anomRes.data.challengeId,
      nonce: anomRes.data.nonce,
      simulationPreset: 'match',
      livenessConfirmed: true
    });
    assert.equal(unlockRes.status, 200);
    if (unlockRes.data.sessionToken || unlockRes.data.token) {
      client.token = unlockRes.data.sessionToken || unlockRes.data.token;
    }

    const slidesAfter = await client.post('/api/slides/generate', {
      subjectId: catalogInfo.cs301Id,
      slideCount: 6
    });
    assert.equal(slidesAfter.status, 201);
  });

  test('T3-CF-06: [F2 + F6] Dynamic Major/Subject/File Ingestion -> FTS5 Indexing -> Built-In AI Tutor Grounded RAG Citation', async () => {
    const majorRes = await sharedClient.post('/api/catalog/majors', {
      code: 'QPHY',
      name: 'Quantum Physics & Photonics',
      faculty: 'Science',
      description: 'Quantum information and Bell inequalities.'
    });
    assert.equal(majorRes.status, 201);
    const majorId = (majorRes.data.major || majorRes.data).id;

    const subjRes = await sharedClient.post('/api/catalog/subjects', {
      majorId,
      code: 'QPHY-401',
      title: 'Quantum Entanglement & Bell Inequalities',
      semester: 'Spring 2026',
      credits: 4,
      instructor: 'Dr. Aspect',
      syllabusSummary: 'CHSH game and Tsirelson quantum correlation bounds.'
    });
    assert.equal(subjRes.status, 201);
    const subjectId = (subjRes.data.subject || subjRes.data).id;

    const uploadRes = await sharedClient.post('/api/catalog/files/upload', {
      majorId,
      subjectId,
      filename: 'tsirelson_bound.md',
      mimeType: 'text/markdown',
      contentText:
        '# Tsirelson Bound\nThe quantum mechanical upper limit on the CHSH Bell parameter is the Tsirelson Bound 2*sqrt(2) approx 2.828427.'
    });
    assert.equal(uploadRes.status, 201);

    const searchRes = await sharedClient.get(
      `/api/catalog/search?q=Tsirelson&subjectId=${encodeURIComponent(subjectId)}`
    );
    assert.equal(searchRes.status, 200);
    assert.ok(searchRes.data.results.length >= 1);

    const convRes = await sharedClient.post('/api/ai/conversations', {
      title: 'QPHY-401 Tsirelson Discussion',
      majorId,
      subjectId,
      providerType: 'built_in'
    });
    const convId = (convRes.data.conversation || convRes.data).id;

    const msgRes = await sharedClient.post(`/api/ai/conversations/${convId}/messages`, {
      content: 'Explain the Tsirelson Bound and CHSH Inequality from our course material.',
      providerType: 'built_in',
      includeCourseContext: true
    });
    assert.equal(msgRes.status, 201);
    assert.equal(msgRes.data.assistantMessage.providerType, 'built_in');
    assert.ok(msgRes.data.assistantMessage.citations.length >= 1);
  });

  test('T3-CF-07: [F2 + F7 + F8] Multi-Provider BYO-AI Hub (gemini, claude, kimi, kiro) + Student Chat File Upload + Course Context Synthesis', async () => {
    const providerTypes = ['gemini', 'claude', 'kimi', 'kiro'];
    for (const pType of providerTypes) {
      const pRes = await sharedClient.post('/api/ai/providers', {
        providerType: pType,
        displayName: `CF07 ${pType.toUpperCase()}`,
        modelName: `${pType}-pro-model`,
        apiKey: `sk-${pType}-secret-key-99887766`,
        executionMode: 'local_rag'
      });
      assert.equal(pRes.status, 201);
      const prov = pRes.data.provider || pRes.data;
      const testRes = await sharedClient.post(`/api/ai/providers/${prov.id}/test`, {});
      assert.equal(testRes.status, 200);
    }

    const convRes = await sharedClient.post('/api/ai/conversations', {
      title: 'CF07 Multi-Provider File Synthesis',
      majorId: catalogInfo.csMajorId,
      subjectId: catalogInfo.cs301Id
    });
    const convId = (convRes.data.conversation || convRes.data).id;

    const fileRes = await sharedClient.post(`/api/ai/conversations/${convId}/files`, {
      filename: 'heap_benchmark.md',
      mimeType: 'text/markdown',
      contentText: 'Student Lab Benchmark: Fibonacci Heap vs Binary Heap on 50,000 vertices shows 34% speedup.'
    });
    assert.equal(fileRes.status, 201);
    const chatFileId = (fileRes.data.chatFile || fileRes.data.file || fileRes.data).id;

    for (const pType of providerTypes) {
      const msgRes = await sharedClient.post(`/api/ai/conversations/${convId}/messages`, {
        content: `Analyze the Fibonacci Heap benchmark speedup using ${pType}.`,
        providerType: pType,
        attachedFileIds: [chatFileId],
        includeCourseContext: true
      });
      assert.equal(msgRes.status, 201);
      assert.equal(msgRes.data.assistantMessage.providerType, pType);
      assert.ok(msgRes.data.assistantMessage.attachedFilesUsed.length >= 1);
      assert.ok(Array.isArray(msgRes.data.assistantMessage.citations));
    }
  });

  test('T3-CF-08: [F2 + F8 + F6] Real PDF Course File & Chat File Upload -> /usr/bin/pdftotext Text Extraction -> Search & AI Q&A', async () => {
    const pdfBuf = createSamplePdfBuffer('Horizon Photonic Compiler Architecture v2026');
    const catalogUpload = await sharedClient.post('/api/catalog/files/upload', {
      majorId: catalogInfo.csMajorId,
      subjectId: catalogInfo.cs301Id,
      filename: 'photonic_compiler.pdf',
      mimeType: 'application/pdf',
      contentBase64: pdfBuf.toString('base64')
    });
    assert.equal(catalogUpload.status, 201);
    const fileId = (catalogUpload.data.file || catalogUpload.data).id;

    const fileDetail = await sharedClient.get(`/api/catalog/files/${fileId}`);
    assert.equal(fileDetail.status, 200);
    assert.ok(JSON.stringify(fileDetail.data).includes('Horizon Photonic Compiler'));

    const convRes = await sharedClient.post('/api/ai/conversations', {
      title: 'PDF Extraction Q&A',
      subjectId: catalogInfo.cs301Id
    });
    const convId = (convRes.data.conversation || convRes.data).id;

    const chatPdfRes = await sharedClient.post(`/api/ai/conversations/${convId}/files`, {
      filename: 'chat_photonic.pdf',
      mimeType: 'application/pdf',
      contentBase64: pdfBuf.toString('base64')
    });
    assert.equal(chatPdfRes.status, 201);
    const chatFileId = (chatPdfRes.data.chatFile || chatPdfRes.data.file || chatPdfRes.data).id;

    const msgRes = await sharedClient.post(`/api/ai/conversations/${convId}/messages`, {
      content: 'Summarize the Horizon Photonic Compiler Architecture from the uploaded PDF.',
      providerType: 'built_in',
      attachedFileIds: [chatFileId],
      includeCourseContext: true
    });
    assert.equal(msgRes.status, 201);
    assert.ok(msgRes.data.assistantMessage.content.length > 20);
  });

  test('T3-CF-09: [F2 + F9] Ingested Lesson & File -> Interactive Slide Deck Generation -> Deck Customization & Persistence', async () => {
    const lessonRes = await sharedClient.post(`/api/catalog/subjects/${catalogInfo.cs301Id}/lessons`, {
      moduleNumber: 9,
      title: 'Red-Black Trees & Amortized Rotation Bounds',
      summary: 'Color invariants, black-height balance, and O(1) amortized rotations.',
      contentMarkdown:
        '# Red-Black Trees\nEvery node is red or black. No red node has a red child. Insertion requires at most 2 rotations.',
      keyConcepts: ['Red-Black Tree', 'Black-Height', 'Amortized Rotations']
    });
    assert.equal(lessonRes.status, 201);
    const lessonId = (lessonRes.data.lesson || lessonRes.data).id;

    const genRes = await sharedClient.post('/api/slides/generate', {
      subjectId: catalogInfo.cs301Id,
      lessonId,
      slideCount: 7
    });
    assert.equal(genRes.status, 201);
    const deck = genRes.data.deck || genRes.data;
    assert.ok(deck.slides.length >= 6);
    assert.ok(JSON.stringify(deck.slides).includes('<svg'));

    const putRes = await sharedClient.put(`/api/slides/${deck.id}`, {
      title: 'Customized Red-Black Tree Slides',
      theme: 'horizon_dark'
    });
    assert.equal(putRes.status, 200);

    const getRes = await sharedClient.get(`/api/slides/${deck.id}`);
    assert.equal(getRes.status, 200);
    assert.equal((getRes.data.deck || getRes.data).title, 'Customized Red-Black Tree Slides');
  });

  test('T3-CF-10: [F2 + F10] Ingested Course Data -> Deep Academic Research & Quantitative Data Collection -> Student Row/Note Annotation -> Multi-Format Export (csv, json, md)', async () => {
    await sharedClient.post('/api/catalog/files/upload', {
      majorId: catalogInfo.csMajorId,
      subjectId: catalogInfo.cs301Id,
      filename: 'graph_benchmarks_cf10.csv',
      mimeType: 'text/csv',
      contentText: 'Algorithm,Vertices,RuntimeMs\nDijkstra_BinaryHeap,100000,42.5\nDijkstra_FibHeap,100000,28.1'
    });

    const runRes = await sharedClient.post('/api/research/run', {
      query: 'Algorithmic complexity and benchmark comparisons for Dijkstra heaps',
      subjectId: catalogInfo.cs301Id,
      includeUploadedFiles: true
    });
    assert.equal(runRes.status, 201);
    const project = runRes.data.project || runRes.data;
    const table = project.collectedDataTable || project.collected_data_table;
    assert.ok(Array.isArray(table.columns) && table.columns.length >= 2);
    assert.ok(Array.isArray(table.rows) && table.rows.length >= 1);

    const noteRes = await sharedClient.put(`/api/research/${project.id}/notes`, {
      studentNotes: 'Verified in CF10 lab session',
      additionalRows: [{ Algorithm: 'RadixHeap', Vertices: '100000', RuntimeMs: '19.4' }]
    });
    assert.equal(noteRes.status, 200);

    for (const fmt of ['csv', 'json', 'md']) {
      const exp = await sharedClient.get(`/api/research/${project.id}/export?format=${fmt}`);
      assert.equal(exp.status, 200);
      assert.ok(exp.text.length > 20);
    }
  });

  test('T3-CF-11: [F10 + F11] Deep Research Project -> AI Educational Video Generation (researchId) -> Real /usr/bin/ffmpeg MP4 Stream (200 OK & 206 Partial Content)', async () => {
    const resRun = await sharedClient.post('/api/research/run', {
      query: 'Shortest path priority queue trade-offs',
      subjectId: catalogInfo.cs301Id
    });
    const project = resRun.data.project || resRun.data;

    const vidRes = await sharedClient.post('/api/videos/generate', {
      subjectId: catalogInfo.cs301Id,
      researchId: project.id,
      topicPrompt: 'Visualizing Research Findings on Shortest Path Queues',
      targetDurationSec: 12,
      renderMp4: true
    });
    assert.equal(vidRes.status, 201);
    const video = vidRes.data.video || vidRes.data;
    assert.ok(video.scenes.length >= 3);
    assert.ok(video.transcript.length >= 1);

    const fullStream = await sharedClient.get(`/api/videos/${video.id}/stream`);
    assert.equal(fullStream.status, 200);
    assert.ok((fullStream.headers['content-type'] || '').includes('video/mp4'));
    assert.ok(fullStream.buffer.length > 500);
    assert.equal(fullStream.buffer.subarray(4, 8).toString('ascii'), 'ftyp');

    const rangeStream = await sharedClient.get(`/api/videos/${video.id}/stream`, {
      headers: { Range: 'bytes=0-511' }
    });
    assert.equal(rangeStream.status, 206);
    assert.ok((rangeStream.headers['content-range'] || '').startsWith('bytes 0-511/'));
    assert.equal(rangeStream.buffer.length, 512);
  });

  test('T3-CF-12: [F2 + F12] Course Lesson Ingestion -> Flashcard Generation -> SM-2 Spaced Repetition Progression (quality: 3 Mastery vs quality: 0 Reset)', async () => {
    const fcGen = await sharedClient.post('/api/exam-prep/flashcards/generate', {
      subjectId: catalogInfo.cs301Id,
      count: 5
    });
    assert.equal(fcGen.status, 201);
    const cardId = fcGen.data.flashcards[0].id;

    const r1 = await sharedClient.post(`/api/exam-prep/flashcards/${cardId}/review`, { quality: 3 });
    assert.equal(r1.status, 200);
    const c1 = r1.data.flashcard || r1.data;
    assert.ok(c1.repetitions >= 1);

    const r2 = await sharedClient.post(`/api/exam-prep/flashcards/${cardId}/review`, { quality: 3 });
    assert.equal(r2.status, 200);
    const c2 = r2.data.flashcard || r2.data;
    assert.ok(c2.repetitions >= 2);
    assert.ok((c2.intervalDays ?? c2.interval_days) >= (c1.intervalDays ?? c1.interval_days));

    const rReset = await sharedClient.post(`/api/exam-prep/flashcards/${cardId}/review`, { quality: 0 });
    assert.equal(rReset.status, 200);
    const cReset = rReset.data.flashcard || rReset.data;
    assert.equal(cReset.repetitions, 0);
  });

  test('T3-CF-13: [F12 + F9 + F11] Timed Mock Exam Submission with Intentional Wrong Answers -> Weakness Analytics -> Targeted Study Guide + Remedial Slide Deck & Video', async () => {
    const examRes = await sharedClient.post('/api/exam-prep/exams/generate', {
      subjectId: catalogInfo.cs301Id,
      mode: 'timed_mock_exam',
      difficulty: 'intermediate',
      questionCount: 6,
      timeLimitSec: 1800
    });
    assert.equal(examRes.status, 201);
    const exam = examRes.data.exam || examRes.data;

    const answers = buildPartialExamAnswers(exam);
    const subRes = await sharedClient.post(`/api/exam-prep/exams/${exam.id}/submit`, {
      answers,
      durationUsedSec: 420
    });
    assert.equal(subRes.status, 201);
    const attempt = subRes.data.attempt || subRes.data;
    assert.ok(attempt.percentage >= 0 && attempt.percentage <= 100);
    const weakRecs = attempt.weaknessRecommendations || attempt.weakness_recommendations || [];
    assert.ok(weakRecs.length >= 1);

    const sgRes = await sharedClient.post('/api/exam-prep/study-guides/generate', {
      subjectId: catalogInfo.cs301Id,
      focusWeakTopics: true
    });
    assert.equal(sgRes.status, 201);

    const weakTopic = weakRecs[0].topic || weakRecs[0].title || 'Shortest Path Relaxation';
    const remSlide = await sharedClient.post('/api/slides/generate', {
      subjectId: catalogInfo.cs301Id,
      customTopic: weakTopic,
      slideCount: 6
    });
    assert.equal(remSlide.status, 201);

    const remVideo = await sharedClient.post('/api/videos/generate', {
      subjectId: catalogInfo.cs301Id,
      topicPrompt: `Remedial Review: ${weakTopic}`,
      targetDurationSec: 10,
      renderMp4: false
    });
    assert.equal(remVideo.status, 201);
  });

  test('T3-CF-14: [F3 + F6 + F9 + F10 + F11 + F12] Active Student Creates Study Assets -> Subscription Expires -> All Study Routes Blocked (402) -> Renewal Restores Access & Preserves Prior Data', async () => {
    const email = 'cf14.lifecycle@horizon.edu';
    const client = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf14-pc-1'
    });
    await client.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7014',
      fullName: 'CF14 Lifecycle Student',
      password: 'UniPass2026!',
      planId: 'semester_essential'
    });
    await client.login(email, 'UniPass2026!');

    const convRes = await client.post('/api/ai/conversations', {
      title: 'CF14 Saved Conversation',
      subjectId: catalogInfo.cs301Id
    });
    const convId = (convRes.data.conversation || convRes.data).id;

    const deckRes = await client.post('/api/slides/generate', {
      subjectId: catalogInfo.cs301Id,
      slideCount: 6
    });
    const deckId = (deckRes.data.deck || deckRes.data).id;

    // Expire subscription
    await client.post('/api/subscription/simulate-state', { status: 'expired' });

    // Auth & Subscription status remain 200 OK
    assert.equal((await client.get('/api/auth/sessions/status')).status, 200);
    assert.equal((await client.get('/api/subscription/status')).status, 200);

    // Study endpoints blocked with 402
    assert.equal((await client.get('/api/catalog/majors')).status, 402);
    assert.equal((await client.get(`/api/ai/conversations/${convId}`)).status, 402);
    assert.equal((await client.get(`/api/slides/${deckId}`)).status, 402);

    // Renew subscription
    const actRes = await client.post('/api/subscription/activate', {
      planId: 'annual_scholar',
      paymentMethod: 'card_visa_4242'
    });
    assert.equal(actRes.status, 200);

    // Prior assets preserved and accessible
    assert.equal((await client.get(`/api/ai/conversations/${convId}`)).status, 200);
    assert.equal((await client.get(`/api/slides/${deckId}`)).status, 200);
  });

  test('T3-CF-15: [F3 + F4 + F7 + F12] Grace Period Student (sara@horizon.edu) Retains Concurrent 1-PC + 1-Phone Study Access Across BYO-AI & Exam Prep Before Seamless Renewal', async () => {
    const saraPc = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf15-sara-pc',
      deviceFingerprint: 'fp-cf15-sara-pc'
    });
    const saraPhone = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf15-sara-phone',
      deviceFingerprint: 'fp-cf15-sara-phone'
    });

    const loginPc = await saraPc.login(PERSONAS.sara.email, PERSONAS.sara.password);
    assert.equal(loginPc.status, 200);
    assert.equal(loginPc.data.subscription.status, 'grace_period');

    const loginPhone = await saraPhone.login(PERSONAS.sara.email, PERSONAS.sara.password);
    assert.equal(loginPhone.status, 200);

    const provRes = await saraPc.post('/api/ai/providers', {
      providerType: 'custom',
      displayName: 'HSU Lab LLM',
      modelName: 'llama-3.3-70b',
      apiKey: 'sk-custom-hsu-9999',
      executionMode: 'local_rag'
    });
    assert.equal(provRes.status, 201);

    const ovRes = await saraPhone.get(
      `/api/exam-prep/overview?subjectId=${encodeURIComponent(catalogInfo.cs301Id)}`
    );
    assert.equal(ovRes.status, 200);

    const upgradeRes = await saraPc.post('/api/subscription/activate', {
      planId: 'semester_essential',
      paymentMethod: 'card_visa_4242'
    });
    assert.equal(upgradeRes.status, 200);

    // Restore Sara to grace_period for clean state
    await saraPc.post('/api/subscription/simulate-state', { status: 'grace_period' });
    await saraPc.logout();
    await saraPhone.logout();
  });

  test('T3-CF-16: [F4 + F5 + F1 + F2] Explicit POST /api/auth/logout on PC-1 Immediately Releases pc Slot Allowing PC-2 Login Without Facial Auth (200 OK), While Unreleased Phone-1 Enforces Facial Auth on Phone-2 (409)', async () => {
    const email = 'cf16.slotrelease@horizon.edu';
    const customVec = generateNormalizedEmbedding(16, 128);
    const reg = createDeviceClient(baseUrl);
    await reg.post('/api/auth/register', {
      email,
      studentNumber: 'HSU-2026-7016',
      fullName: 'CF16 Slot Release',
      password: 'UniPass2026!',
      planId: 'annual_scholar',
      faceEmbedding: customVec
    });

    const pc1 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf16-pc-1',
      deviceFingerprint: 'fp-cf16-pc-1'
    });
    const phone1 = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf16-phone-1',
      deviceFingerprint: 'fp-cf16-phone-1'
    });
    await pc1.login(email, 'UniPass2026!');
    await phone1.login(email, 'UniPass2026!');

    // PC-1 logs out cleanly
    const logoutRes = await pc1.logout();
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.data.slotReleased, true);

    // PC-2 logs in without facial auth conflict
    const pc2 = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 'cf16-pc-2',
      deviceFingerprint: 'fp-cf16-pc-2'
    });
    const pc2Login = await pc2.login(email, 'UniPass2026!');
    assert.equal(pc2Login.status, 200);
    assert.equal(pc2Login.data.requiresFacialAuth, false);

    // Phone-2 attempts login while Phone-1 is still active -> 409 conflict
    const phone2 = createDeviceClient(baseUrl, {
      deviceType: 'phone',
      deviceInstanceId: 'cf16-phone-2',
      deviceFingerprint: 'fp-cf16-phone-2'
    });
    const phone2Conflict = await phone2.login(email, 'UniPass2026!');
    assert.equal(phone2Conflict.status, 409);
    assert.equal(phone2Conflict.data.slotType, 'phone');

    // Enroll explicit customVec from PC-2 and verify Phone-2 takeover with exact liveEmbedding
    await pc2.post('/api/auth/biometrics/enroll', { faceEmbedding: customVec });
    const takeoverRes = await phone2.post('/api/auth/biometrics/verify-and-takeover', {
      challengeId: phone2Conflict.data.challengeId,
      nonce: phone2Conflict.data.nonce,
      liveEmbedding: customVec,
      livenessConfirmed: true
    });
    assert.equal(takeoverRes.status, 200);
    assert.equal(takeoverRes.data.verified, true);
    assert.ok(takeoverRes.data.similarityScore >= 0.99);
  });
});
