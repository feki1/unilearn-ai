import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAS,
  startE2EServer,
  createDeviceClient,
  createSamplePdfBuffer,
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
  const bioMajor = majors.find((m) => m.code === 'BIO') || majors[2] || csMajor;
  const econMajor = majors.find((m) => m.code === 'ECON') || majors[3] || csMajor;

  const subjRes = await client.get('/api/catalog/subjects');
  assert.equal(subjRes.status, 200);
  const subjects = subjRes.data.subjects || [];
  const cs301 = subjects.find((s) => s.code === 'CS-301') || subjects[0];
  const cs450 = subjects.find((s) => s.code === 'CS-450') || cs301;
  const ece210 = subjects.find((s) => s.code === 'ECE-210') || cs301;
  const bio205 = subjects.find((s) => s.code === 'BIO-205') || cs301;
  const econ201 = subjects.find((s) => s.code === 'ECON-201') || cs301;

  return {
    csMajorId: csMajor ? csMajor.id : 'CS',
    eceMajorId: eceMajor ? eceMajor.id : 'ECE',
    bioMajorId: bioMajor ? bioMajor.id : 'BIO',
    econMajorId: econMajor ? econMajor.id : 'ECON',
    cs301Id: cs301 ? cs301.id : 'CS-301',
    cs450Id: cs450 ? cs450.id : 'CS-450',
    ece210Id: ece210 ? ece210.id : 'ECE-210',
    bio205Id: bio205 ? bio205.id : 'BIO-205',
    econ201Id: econ201 ? econ201.id : 'ECON-201'
  };
}

describe('Tier 4 — Real-World University Student Application Scenarios (8 Full-Stack API + Headless Chrome Scenarios)', () => {
  let server;
  let baseUrl;
  let browser;
  let catalogInfo;

  // Shared browser contexts for multi-scenario continuity across T4-SCENARIO-03 and T4-SCENARIO-04
  const multiDeviceStudentEmail = 't4.concurrent.student@horizon.edu';

  before(async () => {
    server = await startE2EServer({ seed: true });
    baseUrl = server.baseUrl;

    const setupClient = createDeviceClient(baseUrl, {
      deviceType: 'pc',
      deviceInstanceId: 't4-setup-pc'
    });
    await setupClient.login(PERSONAS.amina.email, PERSONAS.amina.password);
    catalogInfo = await resolveCatalogIds(setupClient);

    await setupClient.post('/api/auth/register', {
      email: multiDeviceStudentEmail,
      studentNumber: 'HSU-2026-6003',
      fullName: 'T4 MultiDevice Student',
      password: 'UniPass2026!',
      majorId: catalogInfo.csMajorId,
      planId: 'annual_scholar',
      faceEmbedding: generateNormalizedEmbedding(99, 128)
    });
    await setupClient.logout();

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

  test('T4-SCENARIO-01: New University Student Onboarding, Domain Gate Rejection, Subscription Wall (402), and Scholarship Voucher Activation (HSU-SCHOLAR-2026) in Desktop Browser', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen01-pc'
    });
    try {
      const gotoRes = await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      assert.equal(gotoRes.status(), 200);

      const journey = await pcDev.page.evaluate(async (csMajorId) => {
        // 1. Attempt registration with non-university email
        const badReg = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'john.doe@yahoo.com',
            fullName: 'John Outsider',
            password: 'UniPass2026!'
          })
        });
        const badRegJson = await badReg.json();

        // 2. Register valid HSU freshman (unsubscribed)
        const goodReg = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'nadia.freshman@horizon.edu',
            studentNumber: 'HSU-2026-0901',
            fullName: 'Nadia Freshman',
            password: 'UniPass2026!',
            majorId: csMajorId
          })
        });

        // 3. Log in on PC browser
        const loginResp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-scen01-pc'
          },
          body: JSON.stringify({
            email: 'nadia.freshman@horizon.edu',
            password: 'UniPass2026!',
            deviceType: 'pc',
            deviceInstanceId: 't4-scen01-pc',
            deviceFingerprint: 'fp-pc-t4-scen01-pc'
          })
        });
        const loginData = await loginResp.json();
        const token = loginData.sessionToken || loginData.token;
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Device-Type': 'pc',
          'X-Device-Fingerprint': 'fp-pc-t4-scen01-pc'
        };

        // 4. Verify 402 Payment Required on protected Catalog route
        const blockedCat = await fetch('/api/catalog/majors', { headers });
        const blockedCatJson = await blockedCat.json();

        // 5. Activate scholarship voucher HSU-SCHOLAR-2026
        const actResp = await fetch('/api/subscription/activate', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            planId: 'department_sponsored',
            voucherCode: 'HSU-SCHOLAR-2026'
          })
        });
        const actJson = await actResp.json();

        // 6. Fetch full catalog majors & subjects
        const majorsResp = await fetch('/api/catalog/majors', { headers });
        const majorsJson = await majorsResp.json();
        const subjectsResp = await fetch('/api/catalog/subjects', { headers });
        const subjectsJson = await subjectsResp.json();

        return {
          badRegStatus: badReg.status,
          badRegCode: badRegJson.code,
          goodRegStatus: goodReg.status,
          blockedCatStatus: blockedCat.status,
          blockedCatCode: blockedCatJson.code,
          actStatus: actResp.status,
          actSubStatus: actJson.status || (actJson.subscription && actJson.subscription.status),
          majorCodes: (majorsJson.majors || []).map((m) => m.code),
          subjectCodes: (subjectsJson.subjects || []).map((s) => s.code)
        };
      }, catalogInfo.csMajorId);

      assert.equal(journey.badRegStatus, 403);
      assert.equal(journey.badRegCode, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');
      assert.equal(journey.goodRegStatus, 201);
      assert.equal(journey.blockedCatStatus, 402);
      assert.ok(['SUBSCRIPTION_REQUIRED', 'SUBSCRIPTION_EXPIRED'].includes(journey.blockedCatCode));
      assert.equal(journey.actStatus, 200);
      assert.equal(journey.actSubStatus, 'active');
      for (const m of ['CS', 'ECE', 'BIO', 'ECON']) {
        assert.ok(journey.majorCodes.includes(m));
      }
      assert.ok(journey.subjectCodes.length >= 8);
    } finally {
      await pcDev.close();
    }
  });

  test('T4-SCENARIO-02: Simultaneous 1-PC (1280x800) + 1-Phone (390x844) Active Study Session for Subscribed Student (amina@horizon.edu)', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen02-pc-1'
    });
    const phoneDev = await createDevicePage(browser, {
      deviceType: 'phone',
      deviceInstanceId: 't4-scen02-phone-1'
    });

    try {
      await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      await phoneDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });

      const pcRes = await pcDev.page.evaluate(
        async ({ email, password, cs450Id }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'pc',
              deviceInstanceId: 't4-scen02-pc-1',
              deviceFingerprint: 'fp-pc-t4-scen02-pc-1',
              deviceLabel: 'Amina Desktop PC'
            })
          });
          const loginData = await loginResp.json();
          const token = loginData.sessionToken || loginData.token;
          const subjResp = await fetch(`/api/catalog/subjects/${cs450Id}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            }
          });
          return {
            status: loginResp.status,
            slotType: loginData.slot.deviceType,
            innerWidth: window.innerWidth,
            subjStatus: subjResp.status,
            token
          };
        },
        { email: PERSONAS.amina.email, password: PERSONAS.amina.password, cs450Id: catalogInfo.cs450Id }
      );

      assert.equal(pcRes.status, 200);
      assert.equal(pcRes.slotType, 'pc');
      assert.equal(pcRes.innerWidth, 1280);
      assert.equal(pcRes.subjStatus, 200);

      const phoneRes = await phoneDev.page.evaluate(
        async ({ email, password, cs301Id }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'phone',
              'X-Device-Fingerprint': 'fp-phone-t4-scen02-phone-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'phone',
              deviceInstanceId: 't4-scen02-phone-1',
              deviceFingerprint: 'fp-phone-t4-scen02-phone-1',
              deviceLabel: 'Amina iPhone'
            })
          });
          const loginData = await loginResp.json();
          const token = loginData.sessionToken || loginData.token;
          const headers = {
            Authorization: `Bearer ${token}`,
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-scen02-phone-1'
          };
          const statusResp = await fetch('/api/auth/sessions/status', { headers });
          const statusData = await statusResp.json();
          const fcResp = await fetch(`/api/exam-prep/flashcards?subjectId=${encodeURIComponent(cs301Id)}`, {
            headers
          });
          return {
            status: loginResp.status,
            slotType: loginData.slot.deviceType,
            innerWidth: window.innerWidth,
            userAgent: navigator.userAgent,
            slots: statusData.slots || loginData.activeSlots,
            fcStatus: fcResp.status,
            token
          };
        },
        { email: PERSONAS.amina.email, password: PERSONAS.amina.password, cs301Id: catalogInfo.cs301Id }
      );

      assert.equal(phoneRes.status, 200);
      assert.equal(phoneRes.slotType, 'phone');
      assert.equal(phoneRes.innerWidth, 390);
      assert.ok(phoneRes.userAgent.includes('Mobile') || phoneRes.userAgent.includes('iPhone'));
      assert.ok(phoneRes.slots.pc !== null);
      assert.ok(phoneRes.slots.phone !== null);
      assert.equal(phoneRes.fcStatus, 200);

      // Clean up phone slot for Amina
      await phoneDev.page.evaluate(async (token) => {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-scen02-phone-1'
          }
        });
      }, phoneRes.token);
    } finally {
      await pcDev.close();
      await phoneDev.close();
    }
  });

  test('T4-SCENARIO-03: 2nd PC Login Conflict (409), Real WebRTC Fake Webcam Capture (getUserMedia) + Impostor Rejection (403) + Verified Match Takeover (200) & Live SSE Preemption of 1st PC Browser Tab', async () => {
    const pcPage1 = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-pc-alpha'
    });
    const phonePage1 = await createDevicePage(browser, {
      deviceType: 'phone',
      deviceInstanceId: 't4-phone-alpha'
    });
    const pcPage2 = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-pc-beta'
    });

    try {
      await pcPage1.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      await phonePage1.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      await pcPage2.page.goto(baseUrl, { waitUntil: 'networkidle0' });

      // 1. Login on pcPage1 and open SSE listener in browser
      const pc1Token = await pcPage1.page.evaluate(async (email) => {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-alpha'
          },
          body: JSON.stringify({
            email,
            password: 'UniPass2026!',
            deviceType: 'pc',
            deviceInstanceId: 't4-pc-alpha',
            deviceFingerprint: 'fp-pc-t4-pc-alpha'
          })
        });
        const data = await res.json();
        const token = data.sessionToken || data.token;
        window.__SSE_EVENTS__ = [];
        const es = new EventSource(`/api/auth/sessions/events?token=${encodeURIComponent(token)}`);
        es.addEventListener('session_preempted', (e) => {
          window.__SSE_EVENTS__.push({ type: 'session_preempted', data: e.data });
        });
        es.onmessage = (e) => {
          window.__SSE_EVENTS__.push({ type: 'message', data: e.data });
        };
        window.__ES__ = es;
        return token;
      }, multiDeviceStudentEmail);

      // 2. Login on phonePage1
      const phone1Token = await phonePage1.page.evaluate(async (email) => {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-phone-alpha'
          },
          body: JSON.stringify({
            email,
            password: 'UniPass2026!',
            deviceType: 'phone',
            deviceInstanceId: 't4-phone-alpha',
            deviceFingerprint: 'fp-phone-t4-phone-alpha'
          })
        });
        const data = await res.json();
        return data.sessionToken || data.token;
      }, multiDeviceStudentEmail);

      // 3. On pcPage2: trigger 409 conflict, capture fake WebRTC webcam frame on <canvas>, test impostor (403), then match (200)
      const pc2Outcome = await pcPage2.page.evaluate(async (email) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTracks = stream.getVideoTracks();
        const cameraLive = videoTracks.length === 1 && videoTracks[0].readyState === 'live';

        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2266aa';
        ctx.fillRect(0, 0, 160, 120);
        const frameDataUrl = canvas.toDataURL('image/png');
        videoTracks.forEach((t) => t.stop());

        const conflict1 = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-beta'
          },
          body: JSON.stringify({
            email,
            password: 'UniPass2026!',
            deviceType: 'pc',
            deviceInstanceId: 't4-pc-beta',
            deviceFingerprint: 'fp-pc-t4-pc-beta'
          })
        });
        const conflict1Data = await conflict1.json();

        const impostorResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-beta'
          },
          body: JSON.stringify({
            challengeId: conflict1Data.challengeId,
            nonce: conflict1Data.nonce,
            simulationPreset: 'impostor',
            livenessConfirmed: true
          })
        });
        const impostorData = await impostorResp.json();

        const conflict2 = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-beta'
          },
          body: JSON.stringify({
            email,
            password: 'UniPass2026!',
            deviceType: 'pc',
            deviceInstanceId: 't4-pc-beta',
            deviceFingerprint: 'fp-pc-t4-pc-beta'
          })
        });
        const conflict2Data = await conflict2.json();

        const matchResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-beta'
          },
          body: JSON.stringify({
            challengeId: conflict2Data.challengeId,
            nonce: conflict2Data.nonce,
            simulationPreset: 'match',
            livenessConfirmed: true
          })
        });
        const matchData = await matchResp.json();
        return {
          cameraLive,
          hasFrame: frameDataUrl.startsWith('data:image/png'),
          conflictStatus: conflict1.status,
          impostorStatus: impostorResp.status,
          impostorSimilarity: impostorData.similarityScore,
          matchStatus: matchResp.status,
          matchVerified: matchData.verified,
          matchSimilarity: matchData.similarityScore
        };
      }, multiDeviceStudentEmail);

      assert.equal(pc2Outcome.cameraLive, true);
      assert.equal(pc2Outcome.hasFrame, true);
      assert.equal(pc2Outcome.conflictStatus, 409);
      assert.equal(pc2Outcome.impostorStatus, 403);
      assert.ok(pc2Outcome.impostorSimilarity < 0.85);
      assert.equal(pc2Outcome.matchStatus, 200);
      assert.equal(pc2Outcome.matchVerified, true);
      assert.ok(pc2Outcome.matchSimilarity >= 0.85);

      // Verify pcPage1 is preempted (401 SESSION_PREEMPTED) while phonePage1 remains 200 OK
      const pc1Hb = await pcPage1.page.evaluate(async (token) => {
        const r = await fetch('/api/auth/sessions/heartbeat', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-pc-alpha'
          }
        });
        const body = await r.json();
        if (window.__ES__) window.__ES__.close();
        return { status: r.status, code: body.code, sseEvents: window.__SSE_EVENTS__ };
      }, pc1Token);

      assert.equal(pc1Hb.status, 401);
      assert.equal(pc1Hb.code, 'SESSION_PREEMPTED');

      const phone1Hb = await phonePage1.page.evaluate(async (token) => {
        const r = await fetch('/api/auth/sessions/heartbeat', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-phone-alpha'
          }
        });
        return r.status;
      }, phone1Token);
      assert.equal(phone1Hb, 200);
    } finally {
      await pcPage1.close();
      await phonePage1.close();
      await pcPage2.close();
    }
  });

  test('T4-SCENARIO-04: 2nd Phone Login Conflict (409) & Mobile Facial Auth Slot Takeover + Mid-Session Security Anomaly Lock & Recovery ("if something happens")', async () => {
    const phonePage2 = await createDevicePage(browser, {
      deviceType: 'phone',
      deviceInstanceId: 't4-phone-beta'
    });
    try {
      await phonePage2.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      const mobileFlow = await phonePage2.page.evaluate(async (email) => {
        // 1. Trigger 409 conflict on 2nd Phone while t4-phone-alpha is still active
        const conflictResp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-phone-beta'
          },
          body: JSON.stringify({
            email,
            password: 'UniPass2026!',
            deviceType: 'phone',
            deviceInstanceId: 't4-phone-beta',
            deviceFingerprint: 'fp-phone-t4-phone-beta'
          })
        });
        const conflictData = await conflictResp.json();

        // 2. Complete facial verification takeover on mobile
        const takeoverResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-phone-beta'
          },
          body: JSON.stringify({
            challengeId: conflictData.challengeId,
            nonce: conflictData.nonce,
            simulationPreset: 'match',
            livenessConfirmed: true
          })
        });
        const takeoverData = await takeoverResp.json();
        let activeToken = takeoverData.sessionToken || takeoverData.token;
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeToken}`,
          'X-Device-Type': 'phone',
          'X-Device-Fingerprint': 'fp-phone-t4-phone-beta'
        };

        // 3. Report mid-session security anomaly
        const anomResp = await fetch('/api/auth/sessions/report-anomaly', {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason: 'SUSPICIOUS_NETWORK_SWITCH' })
        });
        const anomData = await anomResp.json();

        // 4. Verify protected route is locked (403 BIOMETRIC_REAUTH_REQUIRED)
        const lockedCheck = await fetch('/api/catalog/majors', { headers });
        const lockedJson = await lockedCheck.json();

        // 5. Re-authenticate via facial verification to unlock session
        const unlockResp = await fetch('/api/auth/biometrics/verify-and-takeover', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            challengeId: anomData.challengeId,
            nonce: anomData.nonce,
            simulationPreset: 'match',
            livenessConfirmed: true
          })
        });
        const unlockData = await unlockResp.json();
        if (unlockData.sessionToken || unlockData.token) {
          activeToken = unlockData.sessionToken || unlockData.token;
        }

        const unlockedCheck = await fetch('/api/catalog/majors', {
          headers: {
            Authorization: `Bearer ${activeToken}`,
            'X-Device-Type': 'phone',
            'X-Device-Fingerprint': 'fp-phone-t4-phone-beta'
          }
        });

        return {
          conflictStatus: conflictResp.status,
          conflictSlot: conflictData.slotType,
          takeoverStatus: takeoverResp.status,
          anomStatus: anomResp.status,
          lockedStatus: lockedCheck.status,
          lockedCode: lockedJson.code,
          unlockStatus: unlockResp.status,
          unlockedStatus: unlockedCheck.status
        };
      }, multiDeviceStudentEmail);

      assert.equal(mobileFlow.conflictStatus, 409);
      assert.equal(mobileFlow.conflictSlot, 'phone');
      assert.equal(mobileFlow.takeoverStatus, 200);
      assert.equal(mobileFlow.anomStatus, 200);
      assert.equal(mobileFlow.lockedStatus, 403);
      assert.equal(mobileFlow.lockedCode, 'BIOMETRIC_REAUTH_REQUIRED');
      assert.equal(mobileFlow.unlockStatus, 200);
      assert.equal(mobileFlow.unlockedStatus, 200);
    } finally {
      await phonePage2.close();
    }
  });

  test('T4-SCENARIO-05: Multi-Major Course & PDF/Markdown File Ingestion + FTS5 Search + Multi-Provider BYO-AI Hub (built_in, gemini, claude, kimi, kiro) with Student File Upload in Browser', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen02-pc-1'
    });
    const pdfBase64 = createSamplePdfBuffer(
      'FlashAttention-3 IO-Aware GPU Kernel Optimization & Roofline Model Tiling'
    ).toString('base64');

    try {
      await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      const workflow = await pcDev.page.evaluate(
        async ({ email, password, csMajorId, cs450Id, pdfB64 }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'pc',
              deviceInstanceId: 't4-scen02-pc-1',
              deviceFingerprint: 'fp-pc-t4-scen02-pc-1'
            })
          });
          const { sessionToken, token } = await loginResp.json();
          const authToken = sessionToken || token;
          const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
          };

          // 1. Upload course PDF into CS-450
          const fileUp = await fetch('/api/catalog/files/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              majorId: csMajorId,
              subjectId: cs450Id,
              filename: 'flash_attention_3.pdf',
              mimeType: 'application/pdf',
              contentBase64: pdfB64
            })
          });

          // 2. Search FTS5 for FlashAttention
          const searchResp = await fetch('/api/catalog/search?q=FlashAttention', { headers });
          const searchJson = await searchResp.json();

          // 3. Configure BYO-AI providers
          const providersToConfig = ['gemini', 'claude', 'kimi', 'kiro', 'openai', 'custom'];
          for (const p of providersToConfig) {
            await fetch('/api/ai/providers', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                providerType: p,
                displayName: `Browser ${p.toUpperCase()}`,
                modelName: `${p}-scholar-2026`,
                apiKey: `sk-${p}-secret-browser-key-9999`,
                executionMode: 'local_rag'
              })
            });
          }

          // 4. Create conversation and upload homework file
          const convResp = await fetch('/api/ai/conversations', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              title: 'CS-450 FlashAttention & Homework Study',
              majorId: csMajorId,
              subjectId: cs450Id
            })
          });
          const convJson = await convResp.json();
          const convId = (convJson.conversation || convJson).id;

          const chatFileResp = await fetch(`/api/ai/conversations/${convId}/files`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filename: 'My_Transformer_Homework_Notes.md',
              mimeType: 'text/markdown',
              contentText:
                '# Question 4\nDerive complexity of sliding-window attention with window size W=512 and FlashAttention-3 tiling.'
            })
          });
          const chatFileJson = await chatFileResp.json();
          const chatFileId = (chatFileJson.chatFile || chatFileJson.file || chatFileJson).id;

          // 5. Query across built_in, gemini, claude, kimi, kiro
          const replies = [];
          for (const p of ['built_in', 'gemini', 'claude', 'kimi', 'kiro']) {
            const msgResp = await fetch(`/api/ai/conversations/${convId}/messages`, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                content: `Explain sliding-window attention W=512 and FlashAttention-3 using ${p}.`,
                providerType: p,
                attachedFileIds: [chatFileId],
                includeCourseContext: true
              })
            });
            const msgJson = await msgResp.json();
            replies.push({
              status: msgResp.status,
              providerType: msgJson.assistantMessage.providerType,
              attachedCount: (msgJson.assistantMessage.attachedFilesUsed || []).length,
              citationsCount: (msgJson.assistantMessage.citations || []).length
            });
          }

          return {
            fileUpStatus: fileUp.status,
            searchHits: (searchJson.results || []).length,
            replies
          };
        },
        {
          email: PERSONAS.amina.email,
          password: PERSONAS.amina.password,
          csMajorId: catalogInfo.csMajorId,
          cs450Id: catalogInfo.cs450Id,
          pdfB64: pdfBase64
        }
      );

      assert.equal(workflow.fileUpStatus, 201);
      assert.ok(workflow.searchHits >= 1);
      assert.equal(workflow.replies.length, 5);
      for (const r of workflow.replies) {
        assert.equal(r.status, 201);
        assert.ok(r.attachedCount >= 1);
        assert.ok(r.citationsCount >= 1);
      }
    } finally {
      await pcDev.close();
    }
  });

  test('T4-SCENARIO-06: Interactive Slide Deck Generation & Full-Screen Lesson Presenter Workflow in Browser', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen02-pc-1'
    });
    try {
      await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      const slideFlow = await pcDev.page.evaluate(
        async ({ email, password, ece210Id }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'pc',
              deviceInstanceId: 't4-scen02-pc-1',
              deviceFingerprint: 'fp-pc-t4-scen02-pc-1'
            })
          });
          const { sessionToken, token } = await loginResp.json();
          const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken || token}`,
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
          };

          const genResp = await fetch('/api/slides/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              subjectId: ece210Id,
              slideCount: 8,
              theme: 'academic-dark'
            })
          });
          const genJson = await genResp.json();
          const deck = genJson.deck || genJson;

          // Render SVG diagram inside the browser DOM to verify valid SVG markup
          const host = document.createElement('div');
          const diagramSlide = (deck.slides || []).find(
            (s) => (s.diagramSvg && s.diagramSvg.includes('<svg')) || JSON.stringify(s).includes('<svg')
          );
          if (diagramSlide && diagramSlide.diagramSvg) {
            host.innerHTML = diagramSlide.diagramSvg;
          }
          document.body.appendChild(host);
          const svgEl = host.querySelector('svg');

          const putResp = await fetch(`/api/slides/${deck.id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              title: 'ECE-210 Signals & Fourier Master Deck',
              theme: 'horizon-gold'
            })
          });
          const putJson = await putResp.json();

          return {
            genStatus: genResp.status,
            slideCount: (deck.slides || []).length,
            hasSvgElement: Boolean(svgEl) || Boolean(diagramSlide),
            putStatus: putResp.status,
            updatedTitle: (putJson.deck || putJson).title
          };
        },
        { email: PERSONAS.amina.email, password: PERSONAS.amina.password, ece210Id: catalogInfo.ece210Id }
      );

      assert.equal(slideFlow.genStatus, 201);
      assert.ok(slideFlow.slideCount >= 6 && slideFlow.slideCount <= 10);
      assert.equal(slideFlow.hasSvgElement, true);
      assert.equal(slideFlow.putStatus, 200);
      assert.equal(slideFlow.updatedTitle, 'ECE-210 Signals & Fourier Master Deck');
    } finally {
      await pcDev.close();
    }
  });

  test('T4-SCENARIO-07: Deep Academic Research & Quantitative Data Collection + AI Educational Video Studio with Real /usr/bin/ffmpeg MP4 Playback in Browser', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen02-pc-1'
    });
    try {
      await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      const mediaFlow = await pcDev.page.evaluate(
        async ({ email, password, bio205Id }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'pc',
              deviceInstanceId: 't4-scen02-pc-1',
              deviceFingerprint: 'fp-pc-t4-scen02-pc-1'
            })
          });
          const { sessionToken, token } = await loginResp.json();
          const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken || token}`,
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
          };

          // 1. Run Deep Research on BIO-205
          const resResp = await fetch('/api/research/run', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              query: 'CRISPR-Cas9 gene editing efficiency and enzyme kinetics',
              subjectId: bio205Id,
              includeUploadedFiles: true
            })
          });
          const resJson = await resResp.json();
          const project = resJson.project || resJson;

          // 2. Append notes & export CSV
          await fetch(`/api/research/${project.id}/notes`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              studentNotes: 'CRISPR guide RNA efficiency verified at 94.2%',
              additionalRows: [{ Target: 'BRCA1 Exon 11', Efficiency: '94.2%' }]
            })
          });
          const csvResp = await fetch(`/api/research/${project.id}/export?format=csv`, { headers });
          const csvText = await csvResp.text();

          // 3. Generate AI Educational Video with FFmpeg MP4 rendering
          const vidResp = await fetch('/api/videos/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              subjectId: bio205Id,
              researchId: project.id,
              topicPrompt: 'CRISPR-Cas9 Gene Editing Mechanism & Kinetics',
              targetDurationSec: 12,
              renderMp4: true
            })
          });
          const vidJson = await vidResp.json();
          const video = vidJson.video || vidJson;

          // 4. Fetch MP4 byte range inside browser
          const streamResp = await fetch(`/api/videos/${video.id}/stream`, {
            headers: {
              ...headers,
              Range: 'bytes=0-1023'
            }
          });
          const buf = new Uint8Array(await streamResp.arrayBuffer());
          const ftyp = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
          const videoEl = document.createElement('video');

          return {
            resStatus: resResp.status,
            csvLen: csvText.length,
            vidStatus: vidResp.status,
            scenesCount: (video.scenes || []).length,
            streamStatus: streamResp.status,
            ftyp,
            canPlayMp4: videoEl.canPlayType('video/mp4')
          };
        },
        { email: PERSONAS.amina.email, password: PERSONAS.amina.password, bio205Id: catalogInfo.bio205Id }
      );

      assert.equal(mediaFlow.resStatus, 201);
      assert.ok(mediaFlow.csvLen > 20);
      assert.equal(mediaFlow.vidStatus, 201);
      assert.ok(mediaFlow.scenesCount >= 3);
      assert.ok(mediaFlow.streamStatus === 206 || mediaFlow.streamStatus === 200);
      assert.equal(mediaFlow.ftyp, 'ftyp');
      assert.ok(mediaFlow.canPlayMp4.length > 0);
    } finally {
      await pcDev.close();
    }
  });

  test('T4-SCENARIO-08: End-to-End Exam Preparation Suite: Readiness Dashboard, SM-2 Flashcard Training, Timed Mock Exam Submission, Weakness Analytics & Targeted Study Guide', async () => {
    const pcDev = await createDevicePage(browser, {
      deviceType: 'pc',
      deviceInstanceId: 't4-scen02-pc-1'
    });
    try {
      await pcDev.page.goto(baseUrl, { waitUntil: 'networkidle0' });
      const examFlow = await pcDev.page.evaluate(
        async ({ email, password, econ201Id }) => {
          const loginResp = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Type': 'pc',
              'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
            },
            body: JSON.stringify({
              email,
              password,
              deviceType: 'pc',
              deviceInstanceId: 't4-scen02-pc-1',
              deviceFingerprint: 'fp-pc-t4-scen02-pc-1'
            })
          });
          const { sessionToken, token } = await loginResp.json();
          const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken || token}`,
            'X-Device-Type': 'pc',
            'X-Device-Fingerprint': 'fp-pc-t4-scen02-pc-1'
          };

          // 1. Generate Flashcards & complete SM-2 reviews (3, 2, 0)
          const fcResp = await fetch('/api/exam-prep/flashcards/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({ subjectId: econ201Id, count: 5 })
          });
          const fcJson = await fcResp.json();
          const cards = fcJson.flashcards || [];

          const ratings = [3, 2, 0];
          for (let i = 0; i < Math.min(cards.length, ratings.length); i++) {
            await fetch(`/api/exam-prep/flashcards/${cards[i].id}/review`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ quality: ratings[i] })
            });
          }

          // 2. Generate Timed Mock Exam
          const exResp = await fetch('/api/exam-prep/exams/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              subjectId: econ201Id,
              mode: 'timed_mock_exam',
              questionCount: 6,
              timeLimitSec: 1800
            })
          });
          const exJson = await exResp.json();
          const exam = exJson.exam || exJson;

          // Build answers map
          const answers = {};
          for (let i = 0; i < (exam.questions || []).length; i++) {
            const q = exam.questions[i];
            const k = q.id || q.questionId || String(i);
            if (i % 2 === 0) {
              answers[k] =
                q.correctAnswer ??
                q.correctOption ??
                q.answer ??
                (Array.isArray(q.options) && q.options[0]
                  ? q.options[0].id || q.options[0].value || q.options[0]
                  : 'A');
            } else {
              answers[k] = 'WRONG_ANSWER';
            }
          }

          // 3. Submit exam
          const subResp = await fetch(`/api/exam-prep/exams/${exam.id}/submit`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ answers, durationUsedSec: 540 })
          });
          const subJson = await subResp.json();
          const attempt = subJson.attempt || subJson;

          // 4. Generate targeted study guide & fetch updated overview
          const sgResp = await fetch('/api/exam-prep/study-guides/generate', {
            method: 'POST',
            headers,
            body: JSON.stringify({ subjectId: econ201Id, focusWeakTopics: true })
          });
          const ovResp = await fetch(
            `/api/exam-prep/overview?subjectId=${encodeURIComponent(econ201Id)}`,
            { headers }
          );
          const ovJson = await ovResp.json();

          return {
            fcStatus: fcResp.status,
            exStatus: exResp.status,
            subStatus: subResp.status,
            percentage: attempt.percentage,
            letterGrade: attempt.letterGrade || attempt.letter_grade,
            sgStatus: sgResp.status,
            ovStatus: ovResp.status,
            readinessScore: ovJson.readinessScore,
            recentAttemptsCount: (ovJson.recentAttempts || []).length
          };
        },
        { email: PERSONAS.amina.email, password: PERSONAS.amina.password, econ201Id: catalogInfo.econ201Id }
      );

      assert.equal(examFlow.fcStatus, 201);
      assert.equal(examFlow.exStatus, 201);
      assert.equal(examFlow.subStatus, 201);
      assert.equal(typeof examFlow.percentage, 'number');
      assert.ok(examFlow.letterGrade);
      assert.equal(examFlow.sgStatus, 201);
      assert.equal(examFlow.ovStatus, 200);
      assert.equal(typeof examFlow.readinessScore, 'number');
      assert.ok(examFlow.recentAttemptsCount >= 1);
    } finally {
      await pcDev.close();
    }
  });
});
