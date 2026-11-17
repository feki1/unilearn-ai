import CONFIG from '../config.js';
import { verifySessionToken } from '../modules/auth-security/deviceSessionService.js';

function sendJson(res, statusCode, payload) {
  if (typeof res.json === 'function') {
    return res.json(statusCode, payload);
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

export function extractTokenFromRequest(req) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req?.headers?.['x-session-token']) {
    return String(req.headers['x-session-token']).trim();
  }
  if (req?.query?.token) {
    return String(req.query.token).trim();
  }
  if (req?.url && req.url.includes('token=')) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const t = u.searchParams.get('token');
      if (t) return t.trim();
    } catch {
      // Ignore URL parse error
    }
  }
  return null;
}

export function executeAuthMiddleware(req, res, db, next) {
  const token = extractTokenFromRequest(req);
  if (!token) {
    sendJson(res, 401, {
      error: 'Authentication token required',
      code: 'AUTH_REQUIRED'
    });
    return false;
  }

  const payload = verifySessionToken(token, CONFIG.jwtSecret);
  if (!payload || !payload.sid || !payload.sub) {
    sendJson(res, 401, {
      error: 'Invalid or expired session token',
      code: 'INVALID_TOKEN'
    });
    return false;
  }

  const session = db
    .prepare('SELECT * FROM user_sessions WHERE session_id = ?')
    .get(payload.sid);

  if (!session) {
    sendJson(res, 401, {
      error: 'Session not found',
      code: 'SESSION_EXPIRED'
    });
    return false;
  }

  if (session.status === 'revoked_by_biometric_takeover') {
    sendJson(res, 401, {
      error: 'Your session on this device was preempted by verified facial authentication on another device',
      code: 'SESSION_PREEMPTED',
      reason: 'FACIAL_AUTH_SLOT_TAKEOVER',
      slotType: session.device_type
    });
    return false;
  }

  if (session.status === 'logged_out' || session.status === 'expired') {
    sendJson(res, 401, {
      error: 'Session is no longer active',
      code: 'SESSION_EXPIRED',
      slotType: session.device_type
    });
    return false;
  }

  const student = db
    .prepare('SELECT * FROM students WHERE id = ?')
    .get(payload.sub);

  if (!student) {
    sendJson(res, 401, {
      error: 'Student account no longer exists',
      code: 'INVALID_TOKEN'
    });
    return false;
  }

  const slot = db
    .prepare('SELECT * FROM active_device_slots WHERE student_id = ? AND device_type = ?')
    .get(student.id, session.device_type);

  if (slot && slot.session_id !== session.session_id) {
    sendJson(res, 401, {
      error: 'Device slot was taken over by another verified device',
      code: 'SESSION_PREEMPTED',
      reason: 'FACIAL_AUTH_SLOT_TAKEOVER',
      slotType: session.device_type
    });
    return false;
  }

  const pathname = req.pathname || (req.url ? req.url.split('?')[0] : '');
  const isExemptFromAnomalyLock =
    pathname.startsWith('/api/auth/biometrics') ||
    pathname.startsWith('/api/security/facial') ||
    pathname === '/api/auth/logout' ||
    pathname === '/api/auth/signout' ||
    pathname === '/api/auth/sessions/report-anomaly' ||
    pathname === '/api/security/report-anomaly' ||
    pathname === '/api/auth/sessions/events' ||
    pathname === '/api/devices/events';

  if (
    !isExemptFromAnomalyLock &&
    (session.status === 'locked_pending_biometric' ||
      (slot && slot.status === 'locked_pending_biometric'))
  ) {
    const challenge = db
      .prepare(`
        SELECT * FROM biometric_challenges
        WHERE student_id = ? AND target_slot_type = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(student.id, session.device_type);

    sendJson(res, 403, {
      error: 'Security anomaly detected. Complete facial verification to unlock your session.',
      code: 'BIOMETRIC_REAUTH_REQUIRED',
      requiresFacialAuth: true,
      challengeId: challenge?.challenge_id || null,
      nonce: challenge?.nonce || null,
      slotType: session.device_type
    });
    return false;
  }

  const subscription = db
    .prepare('SELECT * FROM subscriptions WHERE student_id = ?')
    .get(student.id);

  req.auth = {
    student,
    session,
    slot,
    subscription,
    token,
    tokenPayload: payload
  };
  req.user = student;

  if (typeof next === 'function') {
    next();
  }
  return true;
}

export function authMiddleware(arg1, arg2, arg3, arg4) {
  // Factory mode: authMiddleware(db) -> (req, res, next) => ...
  if (arg1 && typeof arg1.prepare === 'function' && !arg2) {
    const db = arg1;
    return (req, res, next) => executeAuthMiddleware(req, res, db, next);
  }
  // Direct call mode: authMiddleware(req, res, dbOrNext, maybeNext)
  const req = arg1;
  const res = arg2;
  const db =
    (arg3 && typeof arg3.prepare === 'function' ? arg3 : null) ||
    req?.db ||
    req?.appDb;
  const next = typeof arg3 === 'function' ? arg3 : arg4;
  return executeAuthMiddleware(req, res, db, next);
}

export const createAuthMiddleware = authMiddleware;
export default authMiddleware;
