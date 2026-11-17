import {
  computeDeviceFingerprintHash,
  reportAnomaly
} from '../modules/auth-security/deviceSessionService.js';

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

export function executeDeviceGuard(req, res, db, next) {
  if (!req.auth || !req.auth.session || !req.auth.student) {
    sendJson(res, 401, {
      error: 'Authentication required before device guard check',
      code: 'AUTH_REQUIRED'
    });
    return false;
  }

  const { student, session } = req.auth;

  // 1. Check explicit X-Device-Type header if sent by client
  const rawDeviceTypeHeader = req?.headers?.['x-device-type'];
  if (rawDeviceTypeHeader) {
    const norm = String(rawDeviceTypeHeader).trim().toLowerCase();
    let explicitType = null;
    if (['phone', 'mobile', 'ios', 'android', 'smartphone'].includes(norm)) {
      explicitType = 'phone';
    } else if (['pc', 'desktop', 'laptop', 'computer', 'workstation'].includes(norm)) {
      explicitType = 'pc';
    }
    if (explicitType && explicitType !== session.device_type) {
      sendJson(res, 401, {
        error: `Session token is bound to device type '${session.device_type}', but request declared '${explicitType}'`,
        code: 'DEVICE_BINDING_MISMATCH',
        expectedDeviceType: session.device_type,
        receivedDeviceType: explicitType,
        requiresFacialAuth: true
      });
      return false;
    }
  }

  // 2. Check explicit X-Device-Fingerprint or X-Device-Instance-Id anti-replay binding
  const explicitFpHeader = req?.headers?.['x-device-fingerprint'];
  const explicitInstanceHeader = req?.headers?.['x-device-instance-id'];

  if (explicitFpHeader || explicitInstanceHeader) {
    const rawFp = String(explicitFpHeader || '').trim();
    const rawInst = String(explicitInstanceHeader || '').trim();

    const directHashMatch = rawFp && rawFp === session.device_fingerprint_hash;
    const directInstanceMatch =
      (rawInst && rawInst === session.device_instance_id) ||
      (rawFp && rawFp === session.device_instance_id);

    const computed = computeDeviceFingerprintHash({
      studentId: student.id,
      deviceType: session.device_type,
      deviceFingerprint: rawFp || undefined,
      deviceInstanceId: rawInst || undefined,
      req
    });

    const computedHashMatch = computed.deviceFingerprintHash === session.device_fingerprint_hash;

    if (!directHashMatch && !directInstanceMatch && !computedHashMatch) {
      sendJson(res, 401, {
        error: 'Device fingerprint mismatch detected (token cannot be replayed across devices)',
        code: 'DEVICE_BINDING_MISMATCH',
        requiresFacialAuth: true
      });
      return false;
    }
  }

  // 3. Mid-session anomaly trigger header
  const anomalyHeader = req?.headers?.['x-trigger-anomaly'];
  if (anomalyHeader && String(anomalyHeader).toLowerCase() !== 'false' && String(anomalyHeader) !== '0') {
    const reason =
      String(anomalyHeader) === 'true' || String(anomalyHeader) === '1'
        ? 'MID_SESSION_ANOMALY_HEADER'
        : String(anomalyHeader);
    const lockResult = reportAnomaly(db, req.realtimeHub, {
      studentId: student.id,
      session,
      reason
    });
    sendJson(res, 403, {
      error: 'Security anomaly detected. Facial re-authentication required.',
      ...lockResult
    });
    return false;
  }

  if (typeof next === 'function') {
    next();
  }
  return true;
}

export function deviceGuardMiddleware(arg1, arg2, arg3, arg4) {
  if (arg1 && typeof arg1.prepare === 'function' && !arg2) {
    const db = arg1;
    return (req, res, next) => executeDeviceGuard(req, res, db, next);
  }
  const req = arg1;
  const res = arg2;
  const db =
    (arg3 && typeof arg3.prepare === 'function' ? arg3 : null) ||
    req?.db ||
    req?.appDb;
  const next = typeof arg3 === 'function' ? arg3 : arg4;
  return executeDeviceGuard(req, res, db, next);
}

export const createDeviceGuardMiddleware = deviceGuardMiddleware;
export default deviceGuardMiddleware;
