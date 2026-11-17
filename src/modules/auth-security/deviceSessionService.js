import crypto from 'node:crypto';
import CONFIG from '../../config.js';
import { runImmediateTransaction } from '../../db/connection.js';

export function classifyDeviceType(req = {}, body = {}) {
  const explicitRaw =
    body?.deviceType ||
    req?.headers?.['x-device-type'] ||
    req?.query?.deviceType ||
    '';
  const explicit = String(explicitRaw).trim().toLowerCase();

  if (['phone', 'mobile', 'ios', 'android', 'smartphone'].includes(explicit)) {
    return 'phone';
  }
  if (['pc', 'desktop', 'laptop', 'computer', 'workstation', 'mac', 'windows', 'linux'].includes(explicit)) {
    return 'pc';
  }

  const chMobile = String(req?.headers?.['sec-ch-ua-mobile'] || '').trim();
  if (chMobile === '?1') {
    return 'phone';
  }

  const ua = String(req?.headers?.['user-agent'] || body?.userAgent || '');
  if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) {
    return 'phone';
  }

  const viewportWidth = Number(body?.viewportWidth || req?.headers?.['x-viewport-width'] || 0);
  if (viewportWidth > 0 && viewportWidth < 768) {
    return 'phone';
  }

  return 'pc';
}

export function computeDeviceFingerprintHash({
  studentId,
  deviceType,
  deviceInstanceId,
  deviceFingerprint,
  req = {}
}) {
  const rawCandidate =
    deviceFingerprint ||
    req?.headers?.['x-device-fingerprint'] ||
    deviceInstanceId ||
    req?.headers?.['x-device-instance-id'] ||
    '';

  const normalizedInstanceId = String(rawCandidate).trim() ||
    `default-${deviceType}-${String(req?.headers?.['user-agent'] || 'unilearn-client').slice(0, 64)}`;

  const hash = crypto
    .createHmac('sha256', CONFIG.deviceSecret)
    .update(`${studentId}|${deviceType}|${normalizedInstanceId}`)
    .digest('hex');

  return {
    deviceFingerprintHash: hash,
    deviceInstanceId: normalizedInstanceId
  };
}

export function signSessionToken(payload, secret = CONFIG.jwtSecret) {
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    iat: nowSec,
    exp: nowSec + CONFIG.security.sessionTtlSeconds,
    uni: CONFIG.university.code,
    ...payload
  };
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret = CONFIG.jwtSecret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp <= nowSec) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function formatSlot(row) {
  if (!row) return null;
  return {
    slotId: row.slot_id,
    studentId: row.student_id,
    deviceType: row.device_type,
    sessionId: row.session_id,
    deviceFingerprintHash: row.device_fingerprint_hash,
    deviceInstanceId: row.device_instance_id,
    deviceLabel: row.device_label,
    slotVersion: Number(row.slot_version || 1),
    status: row.status,
    acquiredAt: row.acquired_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at
  };
}

export function getActiveSlotsMap(db, studentId) {
  const rows = db
    .prepare('SELECT * FROM active_device_slots WHERE student_id = ?')
    .all(studentId);
  const map = { pc: null, phone: null };
  for (const r of rows) {
    if (r.device_type === 'pc' || r.device_type === 'phone') {
      map[r.device_type] = formatSlot(r);
    }
  }
  return map;
}

export function expireStaleSlots(db, studentId, nowIso = new Date().toISOString()) {
  const staleRows = db
    .prepare(`
      SELECT * FROM active_device_slots
      WHERE student_id = ? AND status = 'active' AND lease_expires_at <= ?
    `)
    .all(studentId, nowIso);

  for (const stale of staleRows) {
    db.prepare(`
      UPDATE user_sessions
      SET status = 'expired', revoked_at = ?, revoked_reason = 'LEASE_EXPIRED'
      WHERE session_id = ? AND status = 'active'
    `).run(nowIso, stale.session_id);

    db.prepare('DELETE FROM active_device_slots WHERE slot_id = ?').run(stale.slot_id);
  }
}

export function acquireOrCheckSlot(
  db,
  {
    student,
    deviceType,
    deviceFingerprintHash,
    deviceInstanceId,
    deviceLabel,
    ipAddress = '127.0.0.1',
    userAgent = ''
  }
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + CONFIG.security.slotLeaseSeconds * 1000).toISOString();
  const sessionExpiresAt = new Date(now.getTime() + CONFIG.security.sessionTtlSeconds * 1000).toISOString();
  const challengeExpiresAt = new Date(now.getTime() + CONFIG.security.challengeTtlSeconds * 1000).toISOString();
  const resolvedLabel =
    String(deviceLabel || '').trim() ||
    (deviceType === 'phone' ? 'University Mobile Phone' : 'University Desktop PC');

  return runImmediateTransaction(db, () => {
    expireStaleSlots(db, student.id, nowIso);

    const existingSlot = db
      .prepare('SELECT * FROM active_device_slots WHERE student_id = ? AND device_type = ?')
      .get(student.id, deviceType);

    const isSameDevice =
      existingSlot &&
      (existingSlot.device_fingerprint_hash === deviceFingerprintHash ||
        existingSlot.device_instance_id === deviceInstanceId);

    if (!existingSlot || isSameDevice) {
      const newSessionId = `sess_${crypto.randomUUID()}`;
      const slotVersion = existingSlot ? Number(existingSlot.slot_version || 1) : 1;
      const slotId = existingSlot ? existingSlot.slot_id : `slot_${crypto.randomUUID()}`;
      const tokenHashPlaceholder = crypto.randomBytes(16).toString('hex');

      if (existingSlot) {
        // Cleanly close previous session for the same device before rebinding the slot
        db.prepare(`
          UPDATE user_sessions
          SET status = 'logged_out', revoked_at = ?, revoked_reason = 'SAME_DEVICE_RELOGIN'
          WHERE session_id = ? AND status = 'active'
        `).run(nowIso, existingSlot.session_id);
      }

      db.prepare(`
        INSERT INTO user_sessions (
          session_id, student_id, device_type, device_fingerprint_hash,
          device_instance_id, device_label, token_hash, status,
          created_at, last_heartbeat_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        newSessionId,
        student.id,
        deviceType,
        deviceFingerprintHash,
        deviceInstanceId,
        resolvedLabel,
        tokenHashPlaceholder,
        nowIso,
        nowIso,
        sessionExpiresAt
      );

      db.prepare(`
        INSERT INTO active_device_slots (
          slot_id, student_id, device_type, session_id,
          device_fingerprint_hash, device_instance_id, device_label,
          ip_address, user_agent, slot_version,
          acquired_at, last_heartbeat_at, lease_expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(student_id, device_type) DO UPDATE SET
          session_id = excluded.session_id,
          device_fingerprint_hash = excluded.device_fingerprint_hash,
          device_instance_id = excluded.device_instance_id,
          device_label = excluded.device_label,
          ip_address = excluded.ip_address,
          user_agent = excluded.user_agent,
          last_heartbeat_at = excluded.last_heartbeat_at,
          lease_expires_at = excluded.lease_expires_at,
          status = 'active'
      `).run(
        slotId,
        student.id,
        deviceType,
        newSessionId,
        deviceFingerprintHash,
        deviceInstanceId,
        resolvedLabel,
        ipAddress,
        userAgent,
        slotVersion,
        nowIso,
        nowIso,
        leaseExpiresAt
      );

      db.prepare(`
        INSERT INTO security_audit_logs (log_id, student_id, event_type, device_type, session_id, details_json, created_at)
        VALUES (?, ?, 'SLOT_ACQUIRED', ?, ?, ?, ?)
      `).run(
        `log_${crypto.randomUUID()}`,
        student.id,
        deviceType,
        newSessionId,
        JSON.stringify({ deviceInstanceId, deviceLabel: resolvedLabel, slotVersion }),
        nowIso
      );

      const sessionRow = db.prepare('SELECT * FROM user_sessions WHERE session_id = ?').get(newSessionId);
      const slotRow = db
        .prepare('SELECT * FROM active_device_slots WHERE student_id = ? AND device_type = ?')
        .get(student.id, deviceType);
      const activeSlots = getActiveSlotsMap(db, student.id);

      return {
        conflict: false,
        session: sessionRow,
        slot: slotRow,
        activeSlots
      };
    }

    // Conflict: Slot for this deviceType ('pc' or 'phone') is already occupied by a DIFFERENT device!
    const challengeId = `chal_${crypto.randomUUID()}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const reason = deviceType === 'pc' ? 'SECOND_PC_CONFLICT' : 'SECOND_PHONE_CONFLICT';

    db.prepare(`
      INSERT INTO biometric_challenges (
        challenge_id, student_id, target_slot_type, conflicting_session_id,
        requesting_device_fingerprint, requesting_device_instance_id, requesting_device_label,
        nonce, reason, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      challengeId,
      student.id,
      deviceType,
      existingSlot.session_id,
      deviceFingerprintHash,
      deviceInstanceId,
      resolvedLabel,
      nonce,
      reason,
      challengeExpiresAt,
      nowIso
    );

    db.prepare(`
      INSERT INTO security_audit_logs (log_id, student_id, event_type, device_type, session_id, details_json, created_at)
      VALUES (?, ?, 'DEVICE_SLOT_CONFLICT_CHALLENGED', ?, ?, ?, ?)
    `).run(
      `log_${crypto.randomUUID()}`,
      student.id,
      deviceType,
      existingSlot.session_id,
      JSON.stringify({
        challengeId,
        reason,
        activeDeviceLabel: existingSlot.device_label,
        requestingDeviceLabel: resolvedLabel,
        requestingDeviceInstanceId: deviceInstanceId
      }),
      nowIso
    );

    return {
      conflict: true,
      code: 'DEVICE_SLOT_CONFLICT',
      slotType: deviceType,
      requiresFacialAuth: true,
      challengeId,
      nonce,
      activeDevice: formatSlot(existingSlot),
      activeSlots: getActiveSlotsMap(db, student.id)
    };
  });
}

export function heartbeatSession(db, { session, student }) {
  const now = new Date();
  const nowIso = now.toISOString();
  const newLeaseExpiresAt = new Date(now.getTime() + CONFIG.security.slotLeaseSeconds * 1000).toISOString();

  const freshSession = db
    .prepare('SELECT * FROM user_sessions WHERE session_id = ?')
    .get(session.session_id);

  if (!freshSession || freshSession.status === 'revoked_by_biometric_takeover') {
    return {
      status: 401,
      body: {
        valid: false,
        error: 'Session was preempted by verified facial authentication on another device',
        code: 'SESSION_PREEMPTED',
        reason: 'FACIAL_AUTH_SLOT_TAKEOVER',
        slotType: session.device_type
      }
    };
  }

  if (freshSession.status === 'logged_out' || freshSession.status === 'expired') {
    return {
      status: 401,
      body: {
        valid: false,
        error: 'Session is no longer active',
        code: 'SESSION_EXPIRED',
        slotType: session.device_type
      }
    };
  }

  const slot = db
    .prepare('SELECT * FROM active_device_slots WHERE student_id = ? AND device_type = ?')
    .get(student.id, session.device_type);

  if (slot && slot.session_id !== freshSession.session_id) {
    return {
      status: 401,
      body: {
        valid: false,
        error: 'Device slot was taken over by another verified session',
        code: 'SESSION_PREEMPTED',
        reason: 'FACIAL_AUTH_SLOT_TAKEOVER',
        slotType: session.device_type
      }
    };
  }

  if (
    freshSession.status === 'locked_pending_biometric' ||
    (slot && slot.status === 'locked_pending_biometric')
  ) {
    const pendingChallenge = db
      .prepare(`
        SELECT * FROM biometric_challenges
        WHERE student_id = ? AND target_slot_type = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(student.id, session.device_type);

    return {
      status: 403,
      body: {
        valid: false,
        error: 'Security anomaly detected. Facial re-authentication required.',
        code: 'BIOMETRIC_REAUTH_REQUIRED',
        requiresFacialAuth: true,
        challengeId: pendingChallenge?.challenge_id || null,
        nonce: pendingChallenge?.nonce || null,
        slotType: session.device_type
      }
    };
  }

  db.prepare(`
    UPDATE user_sessions
    SET last_heartbeat_at = ?
    WHERE session_id = ?
  `).run(nowIso, freshSession.session_id);

  if (slot) {
    db.prepare(`
      UPDATE active_device_slots
      SET last_heartbeat_at = ?, lease_expires_at = ?
      WHERE slot_id = ?
    `).run(nowIso, newLeaseExpiresAt, slot.slot_id);
  }

  const updatedSlot = db
    .prepare('SELECT * FROM active_device_slots WHERE student_id = ? AND device_type = ?')
    .get(student.id, session.device_type);

  return {
    status: 200,
    body: {
      valid: true,
      status: 'active',
      sessionId: freshSession.session_id,
      deviceType: freshSession.device_type,
      slotVersion: updatedSlot ? Number(updatedSlot.slot_version) : 1,
      leaseExpiresAt: newLeaseExpiresAt,
      slot: formatSlot(updatedSlot),
      activeSlots: getActiveSlotsMap(db, student.id)
    }
  };
}

export function reportAnomaly(
  db,
  realtimeHub,
  { studentId, session, reason = 'SESSION_ANOMALY_REVERIFY' }
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const challengeExpiresAt = new Date(now.getTime() + CONFIG.security.challengeTtlSeconds * 1000).toISOString();
  const challengeId = `chal_${crypto.randomUUID()}`;
  const nonce = crypto.randomBytes(16).toString('hex');

  runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE user_sessions
      SET status = 'locked_pending_biometric'
      WHERE session_id = ?
    `).run(session.session_id);

    db.prepare(`
      UPDATE active_device_slots
      SET status = 'locked_pending_biometric'
      WHERE student_id = ? AND device_type = ?
    `).run(studentId, session.device_type);

    db.prepare(`
      INSERT INTO biometric_challenges (
        challenge_id, student_id, target_slot_type, conflicting_session_id,
        requesting_device_fingerprint, requesting_device_instance_id, requesting_device_label,
        nonce, reason, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      challengeId,
      studentId,
      session.device_type,
      session.session_id,
      session.device_fingerprint_hash,
      session.device_instance_id,
      session.device_label,
      nonce,
      reason,
      challengeExpiresAt,
      nowIso
    );

    db.prepare(`
      INSERT INTO security_audit_logs (log_id, student_id, event_type, device_type, session_id, details_json, created_at)
      VALUES (?, ?, 'SESSION_ANOMALY_LOCKED', ?, ?, ?, ?)
    `).run(
      `log_${crypto.randomUUID()}`,
      studentId,
      session.device_type,
      session.session_id,
      JSON.stringify({ reason, challengeId }),
      nowIso
    );
  });

  if (realtimeHub) {
    realtimeHub.notifyAnomalyLocked({
      studentId,
      sessionId: session.session_id,
      slotType: session.device_type,
      challengeId,
      nonce,
      reason
    });
  }

  return {
    locked: true,
    code: 'BIOMETRIC_REAUTH_REQUIRED',
    requiresFacialAuth: true,
    challengeId,
    nonce,
    slotType: session.device_type,
    reason
  };
}

export function revokeDeviceSlot(db, realtimeHub, { studentId, targetId, reason = 'MANUAL_REVOKE' }) {
  const nowIso = new Date().toISOString();
  const slot = db
    .prepare(`
      SELECT * FROM active_device_slots
      WHERE student_id = ? AND (slot_id = ? OR session_id = ? OR device_type = ? OR device_instance_id = ?)
    `)
    .get(studentId, targetId, targetId, targetId, targetId);

  if (!slot) {
    return {
      status: 404,
      body: { error: 'Active device slot not found', code: 'SLOT_NOT_FOUND' }
    };
  }

  runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE user_sessions
      SET status = 'revoked_by_biometric_takeover', revoked_at = ?, revoked_reason = ?
      WHERE session_id = ?
    `).run(nowIso, reason, slot.session_id);

    db.prepare('DELETE FROM active_device_slots WHERE slot_id = ?').run(slot.slot_id);

    db.prepare(`
      INSERT INTO security_audit_logs (log_id, student_id, event_type, device_type, session_id, details_json, created_at)
      VALUES (?, ?, 'DEVICE_SLOT_REVOKED', ?, ?, ?, ?)
    `).run(
      `log_${crypto.randomUUID()}`,
      studentId,
      slot.device_type,
      slot.session_id,
      JSON.stringify({ reason, slotId: slot.slot_id }),
      nowIso
    );
  });

  if (realtimeHub) {
    realtimeHub.notifyPreempted({
      studentId,
      revokedSessionId: slot.session_id,
      slotType: slot.device_type,
      newDeviceLabel: 'Security Portal Revocation',
      reason
    });
  }

  return {
    status: 200,
    body: {
      revoked: true,
      slotType: slot.device_type,
      revokedSessionId: slot.session_id,
      activeSlots: getActiveSlotsMap(db, studentId)
    }
  };
}
