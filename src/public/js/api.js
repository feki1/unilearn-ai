const STORAGE_KEY = 'unilearn_session_v1';

export function getDeviceIdentity() {
  let instanceId = localStorage.getItem('unilearn_device_instance_id');
  if (!instanceId) {
    instanceId = `web_${crypto.randomUUID().slice(0, 12)}`;
    localStorage.setItem('unilearn_device_instance_id', instanceId);
  }
  const isMobile =
    window.innerWidth <= 768 ||
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const deviceType = isMobile ? 'phone' : 'pc';
  const fingerprint = `${deviceType}:${instanceId}:${navigator.platform || 'web'}`;
  return {
    deviceType,
    deviceInstanceId: instanceId,
    deviceFingerprint: fingerprint,
    deviceLabel: isMobile ? 'Student Mobile Phone' : 'Student Desktop PC'
  };
}

export function loadSavedSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

export async function apiRequest(path, { method = 'GET', body = null, token = null } = {}) {
  const dev = getDeviceIdentity();
  const headers = {
    'X-Device-Type': dev.deviceType,
    'X-Device-Fingerprint': dev.deviceFingerprint,
    'X-Device-Instance-Id': dev.deviceInstanceId,
    'X-Viewport-Width': String(window.innerWidth || 1280)
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const opts = { method, headers };
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}
