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

export function executeSubscriptionGate(req, res, db, next) {
  if (!req.auth || !req.auth.student) {
    sendJson(res, 401, {
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
    return false;
  }

  const subRow =
    (db &&
      db
        .prepare('SELECT * FROM subscriptions WHERE student_id = ?')
        .get(req.auth.student.id)) ||
    req.auth.subscription;

  const status = subRow ? subRow.status : 'unsubscribed';
  req.auth.subscription = subRow;

  if (status === 'active') {
    if (typeof next === 'function') next();
    return true;
  }

  if (status === 'grace_period') {
    res.setHeader('X-Subscription-Warning', 'GRACE_PERIOD');
    if (typeof next === 'function') next();
    return true;
  }

  if (status === 'expired' || status === 'past_due') {
    sendJson(res, 402, {
      error: 'Your university subscription has expired. Please renew your subscription to access courses, AI tutors, slides, and exams.',
      code: 'SUBSCRIPTION_EXPIRED',
      subscriptionStatus: status,
      requiresSubscription: true
    });
    return false;
  }

  sendJson(res, 402, {
    error: 'An active Horizon State University subscription is required to access study resources.',
    code: 'SUBSCRIPTION_REQUIRED',
    subscriptionStatus: status,
    requiresSubscription: true
  });
  return false;
}

export function subscriptionGateMiddleware(arg1, arg2, arg3, arg4) {
  if (arg1 && typeof arg1.prepare === 'function' && !arg2) {
    const db = arg1;
    return (req, res, next) => executeSubscriptionGate(req, res, db, next);
  }
  const req = arg1;
  const res = arg2;
  const db =
    (arg3 && typeof arg3.prepare === 'function' ? arg3 : null) ||
    req?.db ||
    req?.appDb;
  const next = typeof arg3 === 'function' ? arg3 : arg4;
  return executeSubscriptionGate(req, res, db, next);
}

export const createSubscriptionGateMiddleware = subscriptionGateMiddleware;
export default subscriptionGateMiddleware;
