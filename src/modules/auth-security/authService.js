import crypto from 'node:crypto';
import CONFIG from '../../config.js';
import { runImmediateTransaction } from '../../db/connection.js';
import { hashPassword, verifyPasswordHash } from '../../db/seed.js';
import {
  classifyDeviceType,
  computeDeviceFingerprintHash,
  signSessionToken,
  acquireOrCheckSlot,
  formatSlot,
  getActiveSlotsMap
} from './deviceSessionService.js';
import { enrollBiometrics } from './facialAuthService.js';
import { formatSubscription } from './subscriptionService.js';

export { hashPassword };
export const verifyPassword = verifyPasswordHash;

export function isAllowedUniversityEmail(email, db = null) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return false;
  }
  const domain = email.trim().split('@').pop().toLowerCase();
  const allowed = new Set(CONFIG.university.allowedDomains.map((d) => d.toLowerCase()));

  if (db) {
    try {
      const uniRow = db.prepare('SELECT allowed_domains_json FROM universities WHERE code = ?').get('HSU');
      if (uniRow?.allowed_domains_json) {
        const parsed = JSON.parse(uniRow.allowed_domains_json);
        if (Array.isArray(parsed)) {
          for (const d of parsed) allowed.add(String(d).toLowerCase());
        }
      }
    } catch {
      // Fallback to CONFIG domains
    }
  }

  return allowed.has(domain);
}

export function formatStudent(row) {
  if (!row) return null;
  return {
    id: row.id,
    universityId: row.university_id,
    studentNumber: row.student_number,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    majorId: row.major_id,
    yearLevel: Number(row.year_level || 3),
    createdAt: row.created_at
  };
}

export function registerStudent(
  db,
  {
    email,
    studentNumber,
    fullName,
    password,
    majorId = 'major_cs',
    planId = null,
    faceEmbedding = null
  }
) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !password) {
    return {
      status: 400,
      body: { error: 'University email and password are required', code: 'MISSING_FIELDS' }
    };
  }

  if (!isAllowedUniversityEmail(cleanEmail, db)) {
    return {
      status: 403,
      body: {
        error: 'Access restricted to Horizon State University (@horizon.edu) email domains',
        code: 'UNIVERSITY_DOMAIN_NOT_ALLOWED',
        allowedDomains: CONFIG.university.allowedDomains
      }
    };
  }

  const existing = db
    .prepare('SELECT id FROM students WHERE LOWER(email) = LOWER(?) OR student_number = ?')
    .get(cleanEmail, studentNumber || '');

  if (existing) {
    return {
      status: 409,
      body: {
        error: 'A student with this university email or student number is already registered',
        code: 'STUDENT_ALREADY_EXISTS'
      }
    };
  }

  let resolvedMajorId = 'major_cs';
  if (majorId) {
    const foundMajor = db
      .prepare('SELECT id FROM majors WHERE id = ? OR LOWER(code) = LOWER(?)')
      .get(String(majorId).trim(), String(majorId).trim());
    if (foundMajor) {
      resolvedMajorId = foundMajor.id;
    } else {
      resolvedMajorId = String(majorId).trim();
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const periodEndIso = new Date(now.getTime() + 180 * 86400 * 1000).toISOString();
  const studentId = `stu_${crypto.randomUUID()}`;
  const resolvedStudentNumber =
    String(studentNumber || '').trim() ||
    `HSU-2026-${Math.floor(1000 + Math.random() * 9000)}-${Date.now().toString().slice(-3)}`;
  const resolvedName = String(fullName || cleanEmail.split('@')[0]).trim();
  const passwordHash = hashPassword(password);

  const subStatus = planId ? 'active' : 'unsubscribed';
  const resolvedPlanId = planId && CONFIG.subscriptionPlans[planId] ? planId : 'semester_essential';
  const priceCents = CONFIG.subscriptionPlans[resolvedPlanId]?.priceCents ?? 1900;

  runImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO students (
        id, university_id, student_number, email, full_name, password_hash, role, major_id, year_level, created_at
      ) VALUES (?, 'uni_hsu', ?, ?, ?, ?, 'student', ?, 3, ?)
    `).run(studentId, resolvedStudentNumber, cleanEmail, resolvedName, passwordHash, resolvedMajorId, nowIso);

    db.prepare(`
      INSERT INTO subscriptions (
        id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices,
        current_period_start, current_period_end, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
    `).run(`sub_${crypto.randomUUID()}`, studentId, resolvedPlanId, subStatus, priceCents, nowIso, periodEndIso, nowIso);

    db.prepare(`
      INSERT INTO ai_provider_configs (
        id, user_id, provider_type, display_name, model_name, base_url, api_key_encrypted, api_key_masked,
        execution_mode, temperature, is_default, is_enabled, last_tested_at, last_test_status, created_at
      ) VALUES (?, ?, 'built_in', 'HSU Built-In Academic AI Tutor', 'hsu-grounded-rag-v1', '', '', 'BUILT-IN', 'local_rag', 0.2, 1, 1, ?, 'ok', ?)
    `).run(`prov_builtin_${studentId}`, studentId, nowIso, nowIso);
  });

  enrollBiometrics(db, {
    studentId,
    email: cleanEmail,
    faceEmbedding,
    captureMode: faceEmbedding ? 'webcam' : 'simulated'
  });

  const studentRow = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  const subRow = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(studentId);

  return {
    status: 201,
    body: {
      student: formatStudent(studentRow),
      subscription: formatSubscription(subRow),
      biometricEnrolled: true
    }
  };
}

export function loginStudent(
  db,
  {
    email,
    studentNumber,
    password,
    deviceType,
    deviceInstanceId,
    deviceFingerprint,
    deviceLabel,
    req = {}
  }
) {
  const cleanEmail = email ? String(email).trim().toLowerCase() : '';

  if (cleanEmail && !isAllowedUniversityEmail(cleanEmail, db)) {
    return {
      status: 403,
      body: {
        error: 'Login restricted to Horizon State University (@horizon.edu) email domains',
        code: 'UNIVERSITY_DOMAIN_NOT_ALLOWED',
        allowedDomains: CONFIG.university.allowedDomains
      }
    };
  }

  const student = cleanEmail
    ? db.prepare('SELECT * FROM students WHERE LOWER(email) = LOWER(?)').get(cleanEmail)
    : db.prepare('SELECT * FROM students WHERE student_number = ?').get(String(studentNumber || '').trim());

  if (!student || !verifyPassword(password, student.password_hash)) {
    return {
      status: 401,
      body: {
        error: 'Invalid university email or password',
        code: 'INVALID_CREDENTIALS'
      }
    };
  }

  const resolvedDeviceType = classifyDeviceType(req, { deviceType });
  const fp = computeDeviceFingerprintHash({
    studentId: student.id,
    deviceType: resolvedDeviceType,
    deviceInstanceId,
    deviceFingerprint,
    req
  });

  const slotResult = acquireOrCheckSlot(db, {
    student,
    deviceType: resolvedDeviceType,
    deviceFingerprintHash: fp.deviceFingerprintHash,
    deviceInstanceId: fp.deviceInstanceId,
    deviceLabel,
    ipAddress: req?.socket?.remoteAddress || '127.0.0.1',
    userAgent: String(req?.headers?.['user-agent'] || '')
  });

  if (slotResult.conflict) {
    return {
      status: 409,
      body: {
        authenticated: false,
        code: 'DEVICE_SLOT_CONFLICT',
        slotType: resolvedDeviceType,
        requiresFacialAuth: true,
        challengeId: slotResult.challengeId,
        nonce: slotResult.nonce,
        activeDevice: slotResult.activeDevice,
        activeSlots: slotResult.activeSlots,
        message: `Your account is already open on another ${resolvedDeviceType.toUpperCase()} (${slotResult.activeDevice.deviceLabel}). Complete Facial Authentication to transfer your ${resolvedDeviceType.toUpperCase()} slot to this device.`
      }
    };
  }

  const sessionToken = signSessionToken({
    sid: slotResult.session.session_id,
    sub: student.id,
    email: student.email,
    dt: resolvedDeviceType,
    dfp: fp.deviceFingerprintHash,
    diid: fp.deviceInstanceId,
    sv: Number(slotResult.slot.slot_version || 1)
  });

  const subRow = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(student.id);

  return {
    status: 200,
    body: {
      authenticated: true,
      requiresFacialAuth: false,
      sessionToken,
      token: sessionToken,
      student: formatStudent(student),
      subscription: formatSubscription(subRow),
      slot: formatSlot(slotResult.slot),
      activeSlots: slotResult.activeSlots
    }
  };
}

export function logoutSession(db, realtimeHub, { session }) {
  const nowIso = new Date().toISOString();

  runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE user_sessions
      SET status = 'logged_out', revoked_at = ?, revoked_reason = 'USER_LOGOUT'
      WHERE session_id = ?
    `).run(nowIso, session.session_id);

    db.prepare(`
      DELETE FROM active_device_slots
      WHERE session_id = ? OR (student_id = ? AND device_type = ? AND device_fingerprint_hash = ?)
    `).run(
      session.session_id,
      session.student_id,
      session.device_type,
      session.device_fingerprint_hash
    );

    db.prepare(`
      INSERT INTO security_audit_logs (log_id, student_id, event_type, device_type, session_id, details_json, created_at)
      VALUES (?, ?, 'USER_LOGOUT', ?, ?, ?, ?)
    `).run(
      `log_${crypto.randomUUID()}`,
      session.student_id,
      session.device_type,
      session.session_id,
      JSON.stringify({ slotReleased: true }),
      nowIso
    );
  });

  return {
    status: 200,
    body: {
      slotReleased: true,
      deviceType: session.device_type,
      sessionId: session.session_id,
      activeSlots: getActiveSlotsMap(db, session.student_id)
    }
  };
}

export function getSessionStatus(db, { student, session }) {
  const subRow = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(student.id);
  const bioRow = db.prepare('SELECT * FROM student_biometrics WHERE student_id = ?').get(student.id);
  const activeSlots = getActiveSlotsMap(db, student.id);

  return {
    status: 200,
    body: {
      student: formatStudent(student),
      subscription: formatSubscription(subRow),
      currentSession: {
        sessionId: session.session_id,
        deviceType: session.device_type,
        deviceFingerprintHash: session.device_fingerprint_hash,
        deviceInstanceId: session.device_instance_id,
        deviceLabel: session.device_label,
        status: session.status,
        lastHeartbeatAt: session.last_heartbeat_at,
        expiresAt: session.expires_at
      },
      slots: activeSlots,
      activeSlots,
      biometricEnrolled: Boolean(bioRow && bioRow.status === 'enrolled')
    }
  };
}
