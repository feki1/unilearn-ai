import { authMiddleware, extractTokenFromRequest } from '../../middleware/auth.js';
import { deviceGuardMiddleware } from '../../middleware/deviceGuard.js';
import {
  registerStudent,
  loginStudent,
  logoutSession,
  getSessionStatus
} from './authService.js';
import {
  heartbeatSession,
  reportAnomaly,
  revokeDeviceSlot,
  verifySessionToken
} from './deviceSessionService.js';
import {
  enrollBiometrics,
  createChallenge,
  verifyAndTakeover
} from './facialAuthService.js';
import {
  getSubscriptionStatus,
  activateSubscription,
  simulateSubscriptionState
} from './subscriptionService.js';

export function createSecurityRouter({ db, realtimeHub }) {
  return async function handleSecurityRoute(req, res) {
    const method = req.method;
    const pathname = req.pathname;
    const body = req.body || {};

    // 1. POST /api/auth/register | /api/auth/signup
    if (method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/signup')) {
      const result = registerStudent(db, { ...body, req });
      res.json(result.status, result.body);
      return true;
    }

    // 2. POST /api/auth/login | /api/auth/signin
    if (method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/auth/signin')) {
      const result = loginStudent(db, { ...body, req });
      res.json(result.status, result.body);
      return true;
    }

    // 3. POST /api/auth/logout | /api/auth/signout
    if (method === 'POST' && (pathname === '/api/auth/logout' || pathname === '/api/auth/signout')) {
      if (!authMiddleware(req, res, db)) return true;
      const result = logoutSession(db, realtimeHub, { session: req.auth.session });
      res.json(result.status, result.body);
      return true;
    }

    // 4. GET /api/auth/sessions/status | /api/auth/me | /api/devices/active | /api/devices/status
    if (
      method === 'GET' &&
      (pathname === '/api/auth/sessions/status' ||
        pathname === '/api/auth/me' ||
        pathname === '/api/devices/active' ||
        pathname === '/api/devices/status')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      if (!deviceGuardMiddleware(req, res, db)) return true;
      const result = getSessionStatus(db, {
        student: req.auth.student,
        session: req.auth.session
      });
      res.json(result.status, result.body);
      return true;
    }

    // 5. POST /api/auth/sessions/heartbeat | /api/devices/heartbeat
    if (
      method === 'POST' &&
      (pathname === '/api/auth/sessions/heartbeat' || pathname === '/api/devices/heartbeat')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      if (!deviceGuardMiddleware(req, res, db)) return true;
      const result = heartbeatSession(db, {
        session: req.auth.session,
        student: req.auth.student
      });
      res.json(result.status, result.body);
      return true;
    }

    // 6. GET /api/auth/sessions/events | /api/devices/events (SSE stream)
    if (
      method === 'GET' &&
      (pathname === '/api/auth/sessions/events' || pathname === '/api/devices/events')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      realtimeHub.handleSseConnect(req, res, req.auth);
      return true;
    }

    // 7. POST /api/auth/sessions/report-anomaly | /api/security/report-anomaly
    if (
      method === 'POST' &&
      (pathname === '/api/auth/sessions/report-anomaly' || pathname === '/api/security/report-anomaly')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      const result = reportAnomaly(db, realtimeHub, {
        studentId: req.auth.student.id,
        session: req.auth.session,
        reason: body.reason || 'SESSION_ANOMALY_REVERIFY'
      });
      res.json(200, result);
      return true;
    }

    // 8. POST /api/auth/biometrics/enroll | /api/security/facial/enroll
    if (
      method === 'POST' &&
      (pathname === '/api/auth/biometrics/enroll' || pathname === '/api/security/facial/enroll')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      const result = enrollBiometrics(db, {
        studentId: req.auth.student.id,
        email: req.auth.student.email,
        faceEmbedding: body.faceEmbedding,
        descriptor: body.descriptor,
        captureMode: body.captureMode || 'webcam',
        referenceImage: body.referenceImage || null
      });
      res.json(200, result);
      return true;
    }

    // 9. POST /api/auth/biometrics/challenge | /api/security/facial/challenge
    if (
      method === 'POST' &&
      (pathname === '/api/auth/biometrics/challenge' || pathname === '/api/security/facial/challenge')
    ) {
      let studentId = body.studentId || null;
      let email = body.email || null;
      const token = extractTokenFromRequest(req);
      if (token && !studentId && !email) {
        const decoded = verifySessionToken(token);
        if (decoded?.sub) studentId = decoded.sub;
      }

      const result = createChallenge(db, {
        studentId,
        email,
        targetSlotType: body.targetSlotType || body.slotType || body.deviceType || 'pc',
        deviceInstanceId: body.deviceInstanceId,
        deviceFingerprint: body.deviceFingerprint,
        deviceLabel: body.deviceLabel,
        reason: body.reason || 'MANUAL_CHALLENGE',
        req
      });
      res.json(result.status, result.body);
      return true;
    }

    // 10. POST /api/auth/biometrics/verify-and-takeover | /api/security/facial/verify
    if (
      method === 'POST' &&
      (pathname === '/api/auth/biometrics/verify-and-takeover' ||
        pathname === '/api/security/facial/verify')
    ) {
      const result = verifyAndTakeover(db, realtimeHub, {
        challengeId: body.challengeId,
        nonce: body.nonce,
        liveEmbedding: body.liveEmbedding,
        descriptor: body.descriptor,
        simulationPreset: body.simulationPreset,
        captureMode: body.captureMode,
        livenessConfirmed: body.livenessConfirmed,
        req
      });
      res.json(result.status, result.body);
      return true;
    }

    // 11. POST /api/security/devices/:id/revoke | DELETE /api/devices/:id
    const revokeMatch =
      pathname.match(/^\/api\/(?:security\/)?devices\/([^/]+)\/revoke$/) ||
      (method === 'DELETE' && pathname.match(/^\/api\/(?:security\/)?devices\/([^/]+)$/));
    if (revokeMatch) {
      if (!authMiddleware(req, res, db)) return true;
      const targetId = decodeURIComponent(revokeMatch[1]);
      const result = revokeDeviceSlot(db, realtimeHub, {
        studentId: req.auth.student.id,
        targetId,
        reason: body.reason || 'USER_MANUAL_REVOKE'
      });
      res.json(result.status, result.body);
      return true;
    }

    // 12. GET /api/subscription/status | /api/subscriptions/status | /api/subscription/plans
    if (
      method === 'GET' &&
      (pathname === '/api/subscription/status' ||
        pathname === '/api/subscriptions/status' ||
        pathname === '/api/subscription/plans' ||
        pathname === '/api/subscriptions/plans')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      const statusPayload = getSubscriptionStatus(db, req.auth.student.id);
      res.json(200, statusPayload);
      return true;
    }

    // 13. POST /api/subscription/activate | /api/subscriptions/subscribe | /api/subscriptions/activate
    if (
      method === 'POST' &&
      (pathname === '/api/subscription/activate' ||
        pathname === '/api/subscriptions/subscribe' ||
        pathname === '/api/subscriptions/activate')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      const result = activateSubscription(db, {
        studentId: req.auth.student.id,
        planId: body.planId,
        paymentMethod: body.paymentMethod,
        voucherCode: body.voucherCode
      });
      res.json(result.status, result.body);
      return true;
    }

    // 14. POST /api/subscription/simulate-state | /api/subscriptions/cancel | /api/subscriptions/simulate-state
    if (
      method === 'POST' &&
      (pathname === '/api/subscription/simulate-state' ||
        pathname === '/api/subscriptions/simulate-state' ||
        pathname === '/api/subscriptions/cancel')
    ) {
      let requesterStudentId = null;
      const token = extractTokenFromRequest(req);
      if (token) {
        const decoded = verifySessionToken(token);
        if (decoded?.sub) requesterStudentId = decoded.sub;
      }
      const defaultStatus = pathname.endsWith('/cancel') ? 'canceled' : 'expired';
      const result = simulateSubscriptionState(db, {
        requesterStudentId,
        targetStudentId: body.studentId || body.targetStudentId,
        email: body.email,
        status: body.status || defaultStatus
      });
      res.json(result.status, result.body);
      return true;
    }

    // 15. GET /api/security/audit-logs | /api/auth/audit-logs
    if (
      method === 'GET' &&
      (pathname === '/api/security/audit-logs' || pathname === '/api/auth/audit-logs')
    ) {
      if (!authMiddleware(req, res, db)) return true;
      const rows = db
        .prepare(`
          SELECT * FROM security_audit_logs
          WHERE student_id = ?
          ORDER BY created_at DESC LIMIT 50
        `)
        .all(req.auth.student.id);
      const logs = rows.map((r) => ({
        logId: r.log_id,
        studentId: r.student_id,
        eventType: r.event_type,
        deviceType: r.device_type,
        sessionId: r.session_id,
        details: (() => {
          try {
            return JSON.parse(r.details_json || '{}');
          } catch {
            return {};
          }
        })(),
        createdAt: r.created_at
      }));
      res.json(200, { logs });
      return true;
    }

    return false;
  };
}

export default createSecurityRouter;
