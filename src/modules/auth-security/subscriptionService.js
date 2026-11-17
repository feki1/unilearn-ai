import crypto from 'node:crypto';
import CONFIG from '../../config.js';

export const PLANS = CONFIG.subscriptionPlans;
export const VALID_VOUCHERS = CONFIG.validVouchers;

export function formatSubscription(row) {
  if (!row) return null;
  const plan = PLANS[row.plan_id] || PLANS.semester_essential;
  return {
    id: row.id,
    studentId: row.student_id,
    planId: row.plan_id,
    planName: plan ? plan.name : row.plan_id,
    status: row.status,
    priceCents: Number(row.price_cents ?? plan?.priceCents ?? 1900),
    maxPcDevices: Number(row.max_pc_devices || 1),
    maxPhoneDevices: Number(row.max_phone_devices || 1),
    voucherCode: row.voucher_code || null,
    paymentMethod: row.payment_method || 'card',
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    gracePeriodEndsAt: row.grace_period_ends_at || null,
    updatedAt: row.updated_at
  };
}

export function getSubscriptionStatus(db, studentId) {
  let row = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(studentId);
  if (!row) {
    const nowIso = new Date().toISOString();
    const subId = `sub_${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO subscriptions (
        id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices,
        current_period_start, current_period_end, updated_at
      ) VALUES (?, ?, 'semester_essential', 'unsubscribed', 1900, 1, 1, ?, ?, ?)
    `).run(subId, studentId, nowIso, nowIso, nowIso);
    row = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(studentId);
  }

  const formatted = formatSubscription(row);
  return {
    status: formatted.status,
    subscription: formatted,
    availablePlans: Object.values(PLANS),
    devicePolicy: {
      maxPcDevices: 1,
      maxPhoneDevices: 1,
      requiresBiometricOnSlotConflict: true
    }
  };
}

export function activateSubscription(
  db,
  {
    studentId,
    planId,
    paymentMethod = 'university_card',
    voucherCode = null
  }
) {
  const normalizedVoucher = voucherCode ? String(voucherCode).trim().toUpperCase() : null;
  const resolvedPlanId =
    planId || (normalizedVoucher ? 'department_sponsored' : 'semester_essential');
  const plan = PLANS[resolvedPlanId];

  if (!plan) {
    return {
      status: 400,
      body: {
        error: `Unknown subscription plan: ${resolvedPlanId}`,
        code: 'INVALID_PLAN_ID',
        availablePlans: Object.keys(PLANS)
      }
    };
  }

  if (resolvedPlanId === 'department_sponsored' || normalizedVoucher) {
    if (!normalizedVoucher || !VALID_VOUCHERS.includes(normalizedVoucher)) {
      return {
        status: 400,
        body: {
          error: 'Invalid or missing university scholarship voucher code',
          code: 'INVALID_VOUCHER_CODE'
        }
      };
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const days = plan.billingCycle === 'annual' ? 365 : 180;
  const periodEndIso = new Date(now.getTime() + days * 86400 * 1000).toISOString();

  const existing = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(studentId);
  const subId = existing ? existing.id : `sub_${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO subscriptions (
      id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices,
      voucher_code, payment_method, current_period_start, current_period_end, grace_period_ends_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, 1, 1, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      plan_id = excluded.plan_id,
      status = 'active',
      price_cents = excluded.price_cents,
      voucher_code = excluded.voucher_code,
      payment_method = excluded.payment_method,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      grace_period_ends_at = NULL,
      updated_at = excluded.updated_at
  `).run(
    subId,
    studentId,
    plan.id,
    plan.priceCents,
    normalizedVoucher,
    normalizedVoucher ? 'scholarship_voucher' : paymentMethod,
    nowIso,
    periodEndIso,
    nowIso
  );

  db.prepare(`
    INSERT INTO security_audit_logs (log_id, student_id, event_type, details_json, created_at)
    VALUES (?, ?, 'SUBSCRIPTION_ACTIVATED', ?, ?)
  `).run(
    `log_${crypto.randomUUID()}`,
    studentId,
    JSON.stringify({ planId: plan.id, voucherCode: normalizedVoucher, paymentMethod }),
    nowIso
  );

  const updated = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(studentId);
  return {
    status: 200,
    body: {
      status: 'active',
      subscription: formatSubscription(updated)
    }
  };
}

export function simulateSubscriptionState(
  db,
  {
    requesterStudentId,
    targetStudentId,
    studentId,
    email,
    status = 'canceled'
  }
) {
  const allowedStatuses = ['active', 'grace_period', 'expired', 'past_due', 'canceled', 'unsubscribed'];
  const normalizedStatus = String(status || 'canceled').trim().toLowerCase();

  if (!allowedStatuses.includes(normalizedStatus)) {
    return {
      status: 400,
      body: {
        error: `Invalid subscription status '${status}'`,
        code: 'INVALID_SUBSCRIPTION_STATUS',
        allowedStatuses
      }
    };
  }

  let resolvedStudentId = targetStudentId || studentId || requesterStudentId;
  if (!resolvedStudentId && email) {
    const stu = db.prepare('SELECT id FROM students WHERE LOWER(email) = LOWER(?)').get(String(email).trim());
    resolvedStudentId = stu?.id;
  }

  if (!resolvedStudentId) {
    return {
      status: 400,
      body: { error: 'Target studentId or authenticated session required', code: 'STUDENT_REQUIRED' }
    };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const graceEnd =
    normalizedStatus === 'grace_period'
      ? new Date(now.getTime() + 7 * 86400 * 1000).toISOString()
      : null;

  const existing = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(resolvedStudentId);
  if (!existing) {
    db.prepare(`
      INSERT INTO subscriptions (
        id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices,
        current_period_start, current_period_end, grace_period_ends_at, updated_at
      ) VALUES (?, ?, 'semester_essential', ?, 1900, 1, 1, ?, ?, ?, ?)
    `).run(`sub_${crypto.randomUUID()}`, resolvedStudentId, normalizedStatus, nowIso, nowIso, graceEnd, nowIso);
  } else {
    db.prepare(`
      UPDATE subscriptions
      SET status = ?, grace_period_ends_at = ?, updated_at = ?
      WHERE student_id = ?
    `).run(normalizedStatus, graceEnd, nowIso, resolvedStudentId);
  }

  const updated = db.prepare('SELECT * FROM subscriptions WHERE student_id = ?').get(resolvedStudentId);
  return {
    status: 200,
    body: {
      status: updated.status,
      subscription: formatSubscription(updated)
    }
  };
}
