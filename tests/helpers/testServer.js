import http from 'node:http';
import { createApp } from '../../src/app.js';

export function createApiClient(baseUrl, defaultHeaders = {}) {
  async function request(method, reqPath, body = undefined, opts = {}) {
    const url = reqPath.startsWith('http') ? reqPath : `${baseUrl}${reqPath}`;
    const headers = {
      ...defaultHeaders,
      ...(opts.headers || {})
    };

    if (opts.token) {
      headers.Authorization = `Bearer ${opts.token}`;
    }
    if (opts.deviceType) {
      headers['X-Device-Type'] = opts.deviceType;
    }
    if (opts.deviceInstanceId) {
      headers['X-Device-Instance-Id'] = opts.deviceInstanceId;
    }
    if (opts.deviceFingerprint) {
      headers['X-Device-Fingerprint'] = opts.deviceFingerprint;
    }

    let payload;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        payload = body;
      } else {
        payload = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload
    });

    const text = await res.text();
    let parsedBody = null;
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      parsedBody = text;
    }

    const headerMap = {};
    res.headers.forEach((v, k) => {
      headerMap[k.toLowerCase()] = v;
    });

    return {
      status: res.status,
      ok: res.ok,
      headers: headerMap,
      body: parsedBody,
      text
    };
  }

  return {
    request,
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body, opts),
    put: (path, body, opts) => request('PUT', path, body, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    delete: (path, opts) => request('DELETE', path, undefined, opts),
    withToken(token) {
      return createApiClient(baseUrl, {
        ...defaultHeaders,
        Authorization: `Bearer ${token}`
      });
    },
    withDevice({
      token,
      deviceType,
      deviceInstanceId,
      deviceFingerprint,
      userAgent
    } = {}) {
      const nextHeaders = { ...defaultHeaders };
      if (token) nextHeaders.Authorization = `Bearer ${token}`;
      if (deviceType) nextHeaders['X-Device-Type'] = deviceType;
      if (deviceInstanceId) nextHeaders['X-Device-Instance-Id'] = deviceInstanceId;
      if (deviceFingerprint) nextHeaders['X-Device-Fingerprint'] = deviceFingerprint;
      if (userAgent) nextHeaders['User-Agent'] = userAgent;
      return createApiClient(baseUrl, nextHeaders);
    }
  };
}

export function openSseStream(url, { token, headers = {} } = {}) {
  const events = [];
  const waiters = new Set();
  let req = null;
  let closed = false;

  const fullUrl = new URL(url);
  if (token && !fullUrl.searchParams.has('token')) {
    fullUrl.searchParams.set('token', token);
  }

  const reqHeaders = {
    Accept: 'text/event-stream',
    ...headers
  };
  if (token && !reqHeaders.Authorization) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }

  const connectedPromise = new Promise((resolve, reject) => {
    req = http.request(
      fullUrl,
      {
        method: 'GET',
        headers: reqHeaders
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connection failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        res.setEncoding('utf8');
        let buffer = '';
        let currentEvent = 'message';
        let currentDataLines = [];

        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (line === '') {
              if (currentDataLines.length > 0) {
                const rawData = currentDataLines.join('\n');
                let parsed = rawData;
                try {
                  parsed = JSON.parse(rawData);
                } catch {
                  // Keep string
                }
                const evtObj = { event: currentEvent, data: parsed };
                events.push(evtObj);
                if (currentEvent === 'connected') {
                  resolve(evtObj);
                }
                for (const w of Array.from(waiters)) {
                  if (w.predicate(evtObj)) {
                    waiters.delete(w);
                    clearTimeout(w.timer);
                    w.resolve(evtObj);
                  }
                }
              }
              currentEvent = 'message';
              currentDataLines = [];
            } else if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentDataLines.push(line.slice(5).trim());
            }
          }
        });

        res.on('error', (err) => {
          if (!closed) reject(err);
        });
      }
    );

    req.on('error', (err) => {
      if (!closed) reject(err);
    });
    req.end();
  });

  function waitForEvent(predicateOrType, timeoutMs = 4000) {
    const predicate =
      typeof predicateOrType === 'function'
        ? predicateOrType
        : (evt) =>
            evt.event === predicateOrType ||
            evt.data?.type === predicateOrType ||
            evt.data?.code === predicateOrType;

    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for SSE event: ${String(predicateOrType)}`));
        }, timeoutMs)
      };
      waiters.add(waiter);
    });
  }

  function close() {
    closed = true;
    for (const w of waiters) {
      clearTimeout(w.timer);
    }
    waiters.clear();
    if (req) {
      try {
        req.destroy();
      } catch {
        // Ignore
      }
    }
  }

  return {
    events,
    connectedPromise,
    waitForEvent,
    close
  };
}

export async function startTestServer({
  dbPath = ':memory:',
  dataDir,
  seed = true
} = {}) {
  const instance = createApp({ dbPath, dataDir, seed });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', () => {
      instance.server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = instance.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createApiClient(baseUrl);

  return {
    ...instance,
    port,
    baseUrl,
    client,
    request: client,
    openSse: (opts = {}) => openSseStream(`${baseUrl}/api/auth/sessions/events`, opts)
  };
}

export default startTestServer;
