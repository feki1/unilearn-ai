import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/testServer.js';
import { getEnrolledEmbedding } from '../../src/db/seed.js';

describe('M1: University Identity, Subscription Gate, Strict 1-PC + 1-Phone Enforcer & Facial Auth', () => {
  let srv;

  before(async () => {
    srv = await startTestServer({ dbPath: ':memory:', seed: true });
  });

  after(async () => {
    if (srv) {
      await srv.close();
    }
  });

  describe('1. Health & Pre-Seeded University Catalog Baseline', () => {
    it('T1.1: GET /api/health returns 200 OK with Horizon State University (HSU) metadata', async () => {
      const res = await srv.client.get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.university, 'Horizon State University');
      assert.equal(res.body.code, 'HSU');
    });

    it('T1.2: SQLite database is pre-seeded with HSU, 4 majors, 8 subjects, FTS5 chunks, and 3 student personas', () => {
      const uni = srv.db.prepare("SELECT * FROM universities WHERE code = 'HSU'").get();
      assert.ok(uni);
      assert.equal(uni.name, 'Horizon State University');

      const majors = srv.db.prepare('SELECT code FROM majors ORDER BY code').all();
      assert.deepEqual(
        majors.map((m) => m.code),
        ['BIO', 'CS', 'ECE', 'ECON']
      );

      const subjects = srv.db.prepare('SELECT code FROM subjects ORDER BY code').all();
      assert.equal(subjects.length, 8);
      assert.ok(subjects.some((s) => s.code === 'CS-301'));
      assert.ok(subjects.some((s) => s.code === 'ECE-210'));
      assert.ok(subjects.some((s) => s.code === 'BIO-205'));
      assert.ok(subjects.some((s) => s.code === 'FIN-320'));

      const ftsCount = srv.db.prepare('SELECT COUNT(*) AS cnt FROM course_chunks_fts').get();
      assert.ok(Number(ftsCount.cnt) >= 8);

      const students = srv.db.prepare('SELECT email FROM students ORDER BY email').all();
      assert.deepEqual(
        students.map((s) => s.email),
        ['amina@horizon.edu', 'sara@horizon.edu', 'youssef@horizon.edu']
      );
    });
  });

  describe('2. University Domain Validation (403 UNIVERSITY_DOMAIN_NOT_ALLOWED)', () => {
    it('T2.1: Rejects registration with non-university email domain (403 UNIVERSITY_DOMAIN_NOT_ALLOWED)', async () => {
      const res = await srv.client.post('/api/auth/register', {
        email: 'outsider@gmail.com',
        fullName: 'External User',
        password: 'Password123!'
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');
    });

    it('T2.2: Rejects login with non-university email domain (403 UNIVERSITY_DOMAIN_NOT_ALLOWED)', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'outsider@gmail.com',
        password: 'Password123!'
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'UNIVERSITY_DOMAIN_NOT_ALLOWED');
    });

    it('T2.3: Permits registration with valid @horizon.edu email (201 Created)', async () => {
      const res = await srv.client.post('/api/auth/register', {
        email: 'karim.new@horizon.edu',
        fullName: 'Karim Benali',
        password: 'UniPass2026!',
        majorId: 'CS'
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.student.email, 'karim.new@horizon.edu');
      assert.equal(res.body.subscription.status, 'unsubscribed');
      assert.equal(res.body.biometricEnrolled, true);
    });
  });

  describe('3. Subscription Lifecycle & Access Control Gate (active, grace_period, expired, unsubscribed)', () => {
    it('T3.1: Active subscribed student (amina@horizon.edu) accesses protected catalog routes (200 OK)', async () => {
      const loginRes = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'amina-sub-test-pc',
        deviceLabel: 'Amina Sub Test PC'
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'active');

      const aminaClient = srv.client.withDevice({
        token: loginRes.body.sessionToken,
        deviceType: 'pc',
        deviceInstanceId: 'amina-sub-test-pc'
      });

      const catalogRes = await aminaClient.get('/api/catalog/majors');
      assert.equal(catalogRes.status, 200);
      assert.ok(Array.isArray(catalogRes.body.majors));
      assert.equal(catalogRes.body.majors.length, 4);

      // Logout to keep Amina's PC slot clean for Group 4
      const logoutRes = await aminaClient.post('/api/auth/logout');
      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.slotReleased, true);
    });

    it('T3.2: Grace period student (sara@horizon.edu) is permitted with X-Subscription-Warning: GRACE_PERIOD header', async () => {
      const loginRes = await srv.client.post('/api/auth/login', {
        email: 'sara@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'sara-pc-1'
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'grace_period');

      const saraClient = srv.client.withDevice({
        token: loginRes.body.sessionToken,
        deviceType: 'pc',
        deviceInstanceId: 'sara-pc-1'
      });

      const catalogRes = await saraClient.get('/api/catalog/majors');
      assert.equal(catalogRes.status, 200);
      assert.equal(catalogRes.headers['x-subscription-warning'], 'GRACE_PERIOD');
    });

    it('T3.3: Expired student (youssef@horizon.edu) is blocked from study routes with 402 SUBSCRIPTION_EXPIRED, but allowed on subscription portal', async () => {
      const loginRes = await srv.client.post('/api/auth/login', {
        email: 'youssef@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'youssef-pc-1'
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'expired');

      const youssefClient = srv.client.withDevice({
        token: loginRes.body.sessionToken,
        deviceType: 'pc',
        deviceInstanceId: 'youssef-pc-1'
      });

      const blockedRes = await youssefClient.get('/api/catalog/majors');
      assert.equal(blockedRes.status, 402);
      assert.equal(blockedRes.body.code, 'SUBSCRIPTION_EXPIRED');

      const subStatusRes = await youssefClient.get('/api/subscription/status');
      assert.equal(subStatusRes.status, 200);
      assert.equal(subStatusRes.body.subscription.status, 'expired');
      assert.ok(Array.isArray(subStatusRes.body.availablePlans));
    });

    it('T3.4: Unsubscribed student is blocked from protected study routes with 402 SUBSCRIPTION_REQUIRED', async () => {
      const loginRes = await srv.client.post('/api/auth/login', {
        email: 'karim.new@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'karim-pc-1'
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.subscription.status, 'unsubscribed');

      const karimClient = srv.client.withDevice({
        token: loginRes.body.sessionToken,
        deviceType: 'pc',
        deviceInstanceId: 'karim-pc-1'
      });

      const blockedRes = await karimClient.get('/api/catalog/subjects');
      assert.equal(blockedRes.status, 402);
      assert.equal(blockedRes.body.code, 'SUBSCRIPTION_REQUIRED');
    });

    it('T3.5: Activating subscription with scholarship voucher HSU-SCHOLAR-2026 unlocks protected study routes (200 OK)', async () => {
      const loginRes = await srv.client.post('/api/auth/login', {
        email: 'youssef@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'youssef-pc-1'
      });
      const youssefClient = srv.client.withDevice({
        token: loginRes.body.sessionToken,
        deviceType: 'pc',
        deviceInstanceId: 'youssef-pc-1'
      });

      // Invalid voucher rejected with 400
      const badVoucherRes = await youssefClient.post('/api/subscription/activate', {
        planId: 'department_sponsored',
        voucherCode: 'INVALID-CODE-999'
      });
      assert.equal(badVoucherRes.status, 400);
      assert.equal(badVoucherRes.body.code, 'INVALID_VOUCHER_CODE');

      // Valid voucher HSU-SCHOLAR-2026 activates subscription
      const activateRes = await youssefClient.post('/api/subscription/activate', {
        planId: 'department_sponsored',
        voucherCode: 'HSU-SCHOLAR-2026'
      });
      assert.equal(activateRes.status, 200);
      assert.equal(activateRes.body.status, 'active');
      assert.equal(activateRes.body.subscription.status, 'active');

      // Protected catalog route now succeeds
      const catalogRes = await youssefClient.get('/api/catalog/majors');
      assert.equal(catalogRes.status, 200);
      assert.equal(catalogRes.body.majors.length, 4);

      // Restore Youssef to expired via simulate-state for deterministic state
      const simRes = await youssefClient.post('/api/subscription/simulate-state', {
        status: 'expired'
      });
      assert.equal(simRes.status, 200);
      assert.equal(simRes.body.status, 'expired');
    });
  });

  describe('4–9. Strict 1-PC + 1-Phone Concurrent Access, 409 Conflict, Facial Auth Takeover, SSE Preemption & Anomaly Lock', () => {
    let pc1Token;
    let pc1SessionId;
    let pc1Client;

    let phone1Token;
    let phone1SessionId;
    let phone1Client;

    let pc2ChallengeId;
    let pc2Nonce;
    let pc2Token;
    let pc2Client;

    let phone2ChallengeId;
    let phone2Nonce;
    let phone2Token;
    let phone2Client;

    it('T4.1: 1st PC login (PC-1) succeeds and acquires the PC device slot', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'pc-alpha',
        deviceLabel: 'Amina ThinkPad Linux'
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.authenticated, true);
      assert.equal(res.body.requiresFacialAuth, false);
      assert.equal(res.body.slot.deviceType, 'pc');
      assert.equal(res.body.slot.deviceLabel, 'Amina ThinkPad Linux');
      assert.ok(res.body.activeSlots.pc);
      assert.equal(res.body.activeSlots.phone, null);

      pc1Token = res.body.sessionToken;
      pc1SessionId = res.body.slot.sessionId;
      pc1Client = srv.client.withDevice({
        token: pc1Token,
        deviceType: 'pc',
        deviceInstanceId: 'pc-alpha'
      });
    });

    it('T4.2: 1st Phone login (Phone-1) succeeds simultaneously while PC-1 is active', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'phone',
        deviceInstanceId: 'phone-alpha',
        deviceLabel: 'Amina iPhone 16'
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.authenticated, true);
      assert.equal(res.body.slot.deviceType, 'phone');
      assert.ok(res.body.activeSlots.pc);
      assert.ok(res.body.activeSlots.phone);

      phone1Token = res.body.sessionToken;
      phone1SessionId = res.body.slot.sessionId;
      phone1Client = srv.client.withDevice({
        token: phone1Token,
        deviceType: 'phone',
        deviceInstanceId: 'phone-alpha'
      });
    });

    it('T4.3: Both PC-1 and Phone-1 operate simultaneously with 200 OK on heartbeats and study routes', async () => {
      const [pcHb, phoneHb, pcMajors, phoneSubjects] = await Promise.all([
        pc1Client.post('/api/auth/sessions/heartbeat'),
        phone1Client.post('/api/auth/sessions/heartbeat'),
        pc1Client.get('/api/catalog/majors'),
        phone1Client.get('/api/catalog/subjects?majorId=CS')
      ]);

      assert.equal(pcHb.status, 200);
      assert.equal(pcHb.body.valid, true);
      assert.equal(phoneHb.status, 200);
      assert.equal(phoneHb.body.valid, true);
      assert.equal(pcMajors.status, 200);
      assert.equal(phoneSubjects.status, 200);
      assert.ok(phoneSubjects.body.subjects.length >= 3);
    });

    it('T4.4: Idempotent re-login from the SAME PC-1 device succeeds without conflict', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'pc-alpha',
        deviceLabel: 'Amina ThinkPad Linux'
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.requiresFacialAuth, false);
      pc1Token = res.body.sessionToken;
      pc1SessionId = res.body.slot.sessionId;
      pc1Client = srv.client.withDevice({
        token: pc1Token,
        deviceType: 'pc',
        deviceInstanceId: 'pc-alpha'
      });
    });

    it('T5.1: 2nd PC login (PC-2) is blocked with 409 DEVICE_SLOT_CONFLICT and issues a facial auth challenge without disturbing PC-1', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'pc-beta',
        deviceLabel: 'Library Lab Desktop PC'
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.authenticated, false);
      assert.equal(res.body.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(res.body.slotType, 'pc');
      assert.equal(res.body.requiresFacialAuth, true);
      assert.ok(res.body.challengeId);
      assert.ok(res.body.nonce);
      assert.equal(res.body.activeDevice.deviceLabel, 'Amina ThinkPad Linux');

      pc2ChallengeId = res.body.challengeId;
      pc2Nonce = res.body.nonce;

      // Verify PC-1 is still completely active
      const pc1Hb = await pc1Client.post('/api/auth/sessions/heartbeat');
      assert.equal(pc1Hb.status, 200);
      assert.equal(pc1Hb.body.valid, true);
    });

    it('T5.2: 2nd Phone login (Phone-2) is blocked with 409 DEVICE_SLOT_CONFLICT and issues a phone slot challenge', async () => {
      const res = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'phone',
        deviceInstanceId: 'phone-beta',
        deviceLabel: 'Secondary Android Phone'
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'DEVICE_SLOT_CONFLICT');
      assert.equal(res.body.slotType, 'phone');
      assert.equal(res.body.requiresFacialAuth, true);
      assert.ok(res.body.challengeId);
      assert.ok(res.body.nonce);

      phone2ChallengeId = res.body.challengeId;
      phone2Nonce = res.body.nonce;
    });

    it('T6.1 & T6.2: Facial biometric enrollment works, and Impostor facial verification on PC-2 is rejected with 403 BIOMETRIC_VERIFICATION_FAILED', async () => {
      // Verify enrollment endpoint on PC-1
      const enrolledVec = getEnrolledEmbedding('amina@horizon.edu');
      const enrollRes = await pc1Client.post('/api/auth/biometrics/enroll', {
        faceEmbedding: enrolledVec,
        captureMode: 'webcam'
      });
      assert.equal(enrollRes.status, 200);
      assert.equal(enrollRes.body.enrolled, true);
      assert.equal(enrollRes.body.dimensions, 128);

      // PC-2 attempts takeover with impostor preset
      const impostorRes = await srv.client.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: pc2ChallengeId,
        nonce: pc2Nonce,
        simulationPreset: 'impostor',
        livenessConfirmed: true
      });
      assert.equal(impostorRes.status, 403);
      assert.equal(impostorRes.body.verified, false);
      assert.equal(impostorRes.body.code, 'BIOMETRIC_VERIFICATION_FAILED');
      assert.ok(impostorRes.body.similarityScore < 0.85);

      // PC-1 must still be active and untouched
      const pc1Hb = await pc1Client.post('/api/auth/sessions/heartbeat');
      assert.equal(pc1Hb.status, 200);
      assert.equal(pc1Hb.body.valid, true);
    });

    it('T6.3: Failed liveness check is rejected with 403 BIOMETRIC_VERIFICATION_FAILED', async () => {
      const chalRes = await srv.client.post('/api/auth/biometrics/challenge', {
        email: 'amina@horizon.edu',
        targetSlotType: 'pc',
        deviceInstanceId: 'pc-beta',
        deviceLabel: 'Library Lab Desktop PC'
      });
      assert.equal(chalRes.status, 201);

      const failLiveness = await srv.client.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: chalRes.body.challengeId,
        nonce: chalRes.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: false
      });
      assert.equal(failLiveness.status, 403);
      assert.equal(failLiveness.body.code, 'BIOMETRIC_VERIFICATION_FAILED');
    });

    it('T7.1–T7.4: Verified facial match on PC-2 atomically preempts PC-1 (via SSE & 401 SESSION_PREEMPTED) while Phone-1 stays 100% active', async () => {
      // Open real-time SSE stream on PC-1 before takeover
      const sse = srv.openSse({ token: pc1Token });
      await sse.connectedPromise;

      try {
        // PC-2 completes verified facial takeover using pc2ChallengeId
        const takeoverRes = await srv.client.post('/api/auth/biometrics/verify-and-takeover', {
          challengeId: pc2ChallengeId,
          nonce: pc2Nonce,
          simulationPreset: 'match',
          livenessConfirmed: true
        });
        assert.equal(takeoverRes.status, 200);
        assert.equal(takeoverRes.body.verified, true);
        assert.ok(takeoverRes.body.similarityScore >= 0.85);
        assert.equal(takeoverRes.body.preemptedSessionId, pc1SessionId);
        assert.equal(takeoverRes.body.slot.deviceType, 'pc');
        assert.ok(takeoverRes.body.slot.slotVersion >= 2);

        pc2Token = takeoverRes.body.sessionToken;
        pc2Client = srv.client.withDevice({
          token: pc2Token,
          deviceType: 'pc',
          deviceInstanceId: 'pc-beta'
        });

        // Assert PC-1 receives real-time SSE session_preempted event
        const preemptEvt = await sse.waitForEvent('session_preempted', 3000);
        assert.equal(preemptEvt.data.code, 'SESSION_PREEMPTED');
        assert.equal(preemptEvt.data.reason, 'FACIAL_AUTH_SLOT_TAKEOVER');
        assert.equal(preemptEvt.data.slotType, 'pc');
      } finally {
        sse.close();
      }

      // Assert PC-1 now receives 401 SESSION_PREEMPTED on heartbeat and catalog routes
      const pc1HbAfter = await pc1Client.post('/api/auth/sessions/heartbeat');
      assert.equal(pc1HbAfter.status, 401);
      assert.equal(pc1HbAfter.body.code, 'SESSION_PREEMPTED');
      assert.equal(pc1HbAfter.body.reason, 'FACIAL_AUTH_SLOT_TAKEOVER');

      const pc1CatalogAfter = await pc1Client.get('/api/catalog/majors');
      assert.equal(pc1CatalogAfter.status, 401);
      assert.equal(pc1CatalogAfter.body.code, 'SESSION_PREEMPTED');

      // Assert Phone-1 ('phone' slot) was NOT affected at all and still returns 200 OK!
      const phone1HbAfter = await phone1Client.post('/api/auth/sessions/heartbeat');
      assert.equal(phone1HbAfter.status, 200);
      assert.equal(phone1HbAfter.body.valid, true);

      const phone1CatalogAfter = await phone1Client.get('/api/catalog/majors');
      assert.equal(phone1CatalogAfter.status, 200);

      // Assert PC-2 now has full access
      const pc2Catalog = await pc2Client.get('/api/catalog/majors');
      assert.equal(pc2Catalog.status, 200);
    });

    it('T7.5: Verified facial match on Phone-2 preempts Phone-1 while leaving PC-2 active', async () => {
      const takeoverPhoneRes = await srv.client.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: phone2ChallengeId,
        nonce: phone2Nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(takeoverPhoneRes.status, 200);
      assert.equal(takeoverPhoneRes.body.verified, true);
      assert.equal(takeoverPhoneRes.body.preemptedSessionId, phone1SessionId);
      assert.equal(takeoverPhoneRes.body.slot.deviceType, 'phone');

      phone2Token = takeoverPhoneRes.body.sessionToken;
      phone2Client = srv.client.withDevice({
        token: phone2Token,
        deviceType: 'phone',
        deviceInstanceId: 'phone-beta'
      });

      // Phone-1 is now preempted (401 SESSION_PREEMPTED)
      const phone1Hb = await phone1Client.post('/api/auth/sessions/heartbeat');
      assert.equal(phone1Hb.status, 401);
      assert.equal(phone1Hb.body.code, 'SESSION_PREEMPTED');

      // Phone-2 and PC-2 are both active (200 OK)
      const [phone2Hb, pc2Hb] = await Promise.all([
        phone2Client.post('/api/auth/sessions/heartbeat'),
        pc2Client.post('/api/auth/sessions/heartbeat')
      ]);
      assert.equal(phone2Hb.status, 200);
      assert.equal(pc2Hb.status, 200);
    });

    it('T8.1–T8.3: Mid-session security anomaly locks the slot with 403 BIOMETRIC_REAUTH_REQUIRED until facial verification unlocks it', async () => {
      const anomalyRes = await pc2Client.post('/api/auth/sessions/report-anomaly', {
        reason: 'SUSPICIOUS_IP_SHIFT'
      });
      assert.equal(anomalyRes.status, 200);
      assert.equal(anomalyRes.body.locked, true);
      assert.equal(anomalyRes.body.code, 'BIOMETRIC_REAUTH_REQUIRED');
      assert.equal(anomalyRes.body.requiresFacialAuth, true);
      assert.ok(anomalyRes.body.challengeId);

      // While locked, PC-2 is blocked from study routes and heartbeat with 403 BIOMETRIC_REAUTH_REQUIRED
      const blockedStudy = await pc2Client.get('/api/catalog/majors');
      assert.equal(blockedStudy.status, 403);
      assert.equal(blockedStudy.body.code, 'BIOMETRIC_REAUTH_REQUIRED');

      const blockedHb = await pc2Client.post('/api/auth/sessions/heartbeat');
      assert.equal(blockedHb.status, 403);
      assert.equal(blockedHb.body.code, 'BIOMETRIC_REAUTH_REQUIRED');

      // Unlock via facial verification
      const unlockRes = await pc2Client.post('/api/auth/biometrics/verify-and-takeover', {
        challengeId: anomalyRes.body.challengeId,
        nonce: anomalyRes.body.nonce,
        simulationPreset: 'match',
        livenessConfirmed: true
      });
      assert.equal(unlockRes.status, 200);
      assert.equal(unlockRes.body.verified, true);

      // Subsequent catalog request succeeds with 200 OK
      const unlockedStudy = await pc2Client.get('/api/catalog/majors');
      assert.equal(unlockedStudy.status, 200);
    });

    it('T9.1 & T9.2: Rejects cross-device token replay (401 DEVICE_BINDING_MISMATCH) and releases slot cleanly on logout', async () => {
      // Attempt to replay PC-2's token with a different deviceInstanceId header
      const replayFpRes = await srv.client.get('/api/catalog/majors', {
        token: pc2Token,
        deviceType: 'pc',
        deviceInstanceId: 'stolen-pc-gamma'
      });
      assert.equal(replayFpRes.status, 401);
      assert.equal(replayFpRes.body.code, 'DEVICE_BINDING_MISMATCH');

      // Attempt to replay PC-2's token claiming to be a phone
      const replayTypeRes = await srv.client.get('/api/catalog/majors', {
        token: pc2Token,
        deviceType: 'phone',
        deviceInstanceId: 'pc-beta'
      });
      assert.equal(replayTypeRes.status, 401);
      assert.equal(replayTypeRes.body.code, 'DEVICE_BINDING_MISMATCH');

      // Explicit logout on PC-2 releases the PC slot
      const logoutRes = await pc2Client.post('/api/auth/logout');
      assert.equal(logoutRes.status, 200);
      assert.equal(logoutRes.body.slotReleased, true);

      // PC-3 can now log in immediately without a 409 conflict
      const pc3Login = await srv.client.post('/api/auth/login', {
        email: 'amina@horizon.edu',
        password: 'UniPass2026!',
        deviceType: 'pc',
        deviceInstanceId: 'pc-delta',
        deviceLabel: 'Amina Home Workstation'
      });
      assert.equal(pc3Login.status, 200);
      assert.equal(pc3Login.body.authenticated, true);
      assert.equal(pc3Login.body.requiresFacialAuth, false);
    });
  });
});
