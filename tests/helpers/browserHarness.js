import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PUPPETEER_MODULE_PATH = '/usr/local/lib/node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
const CHROME_EXECUTABLE_PATH = '/usr/bin/google-chrome';

export const PERSONAS = {
  amina: {
    email: 'amina@horizon.edu',
    studentNumber: 'HSU-2026-0101',
    password: 'UniPass2026!',
    status: 'active',
    planId: 'annual_scholar'
  },
  youssef: {
    email: 'youssef@horizon.edu',
    studentNumber: 'HSU-2026-0102',
    password: 'UniPass2026!',
    status: 'expired',
    planId: 'semester_essential'
  },
  sara: {
    email: 'sara@horizon.edu',
    studentNumber: 'HSU-2026-0103',
    password: 'UniPass2026!',
    status: 'grace_period',
    planId: 'semester_essential'
  }
};

/**
 * Generates a valid minimal PDF-1.4 binary Buffer containing the given text
 * so /usr/bin/pdftotext extracts the text accurately during E2E tests.
 */
export function createSamplePdfBuffer(text = 'Horizon State University E2E Sample PDF Content') {
  const safe = String(text).replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

/**
 * Generates a deterministic 128-d unit-normalized face embedding vector.
 */
export function generateNormalizedEmbedding(seed = 1, dimensions = 128) {
  const raw = [];
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    const val = Math.sin(seed * 97.13 + (i + 1) * 13.37) + 1.25;
    raw.push(val);
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return raw.map((v) => Number((v / norm).toFixed(6)));
}

/**
 * Slightly perturbs a normalized 128-d embedding while keeping high cosine similarity (>= 0.95).
 */
export function perturbEmbedding(baseVector, noiseAmplitude = 0.03) {
  const raw = baseVector.map((v, i) => v + noiseAmplitude * Math.cos((i + 1) * 7.1));
  const norm = Math.sqrt(raw.reduce((acc, v) => acc + v * v, 0)) || 1;
  return raw.map((v) => Number((v / norm).toFixed(6)));
}

/**
 * Starts an isolated E2E application server on 127.0.0.1:0 with :memory: SQLite DB and seeded personas.
 */
export async function startE2EServer(options = {}) {
  if (process.env.E2E_BASE_URL && !options.forceLocal) {
    const baseUrl = process.env.E2E_BASE_URL.replace(/\/$/, '');
    const parsed = new URL(baseUrl);
    return {
      baseUrl,
      wsUrl: `${baseUrl.replace(/^http/, 'ws')}/ws`,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      appInstance: null,
      dataDir: null,
      close: async () => {}
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unilearn-e2e-'));
  fs.mkdirSync(path.join(tmpDir, 'seed_files'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'videos'), { recursive: true });

  const repoSeedDir = '/home/antigravity/data/seed_files';
  if (fs.existsSync(repoSeedDir)) {
    for (const entry of fs.readdirSync(repoSeedDir)) {
      const srcPath = path.join(repoSeedDir, entry);
      if (fs.statSync(srcPath).isFile()) {
        fs.copyFileSync(srcPath, path.join(tmpDir, 'seed_files', entry));
      }
    }
  }

  const appModuleUrl = pathToFileURL('/home/antigravity/src/app.js').href;
  const { createApp } = await import(appModuleUrl);

  const appInstance = await createApp({
    dbPath: options.dbPath || ':memory:',
    dataDir: options.dataDir || tmpDir,
    seed: options.seed !== false
  });

  const server = appInstance.server || appInstance;
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    port,
    appInstance,
    dataDir: tmpDir,
    close: async () => {
      try {
        if (typeof appInstance.close === 'function') {
          await appInstance.close();
        } else if (server && server.listening) {
          await new Promise((resolve) => server.close(resolve));
        }
      } catch {
        // Ignore shutdown errors
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore temp dir cleanup errors
      }
    }
  };
}

/**
 * Creates a deterministic multi-device HTTP, Multipart, SSE, and WebSocket client.
 * Supports both `res.data` and `res.body` as aliases for parsed response payload.
 */
export function createDeviceClient(baseUrl, options = {}) {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  const deviceType = options.deviceType || 'pc';
  const deviceInstanceId = options.deviceInstanceId || `${deviceType}-default-1`;
  const deviceFingerprint = options.deviceFingerprint || `fp-${deviceType}-${deviceInstanceId}`;
  const deviceLabel =
    options.deviceLabel ||
    (deviceType === 'pc' ? `PC (${deviceInstanceId})` : `Phone (${deviceInstanceId})`);
  const userAgent =
    options.userAgent ||
    (deviceType === 'pc'
      ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

  const client = {
    baseUrl: cleanBaseUrl,
    deviceType,
    deviceInstanceId,
    deviceFingerprint,
    deviceLabel,
    userAgent,
    token: options.token || null,

    buildHeaders(extraHeaders = {}, tokenOverride = undefined) {
      const activeToken = tokenOverride !== undefined ? tokenOverride : client.token;
      const hdrs = {
        'X-Device-Type': client.deviceType,
        'X-Device-Fingerprint': client.deviceFingerprint,
        'X-Device-Instance-Id': client.deviceInstanceId,
        'X-Device-Label': client.deviceLabel,
        'User-Agent': client.userAgent,
        ...extraHeaders
      };
      if (activeToken && !('Authorization' in extraHeaders) && !('authorization' in extraHeaders)) {
        hdrs.Authorization = `Bearer ${activeToken}`;
      }
      return hdrs;
    },

    async request(urlPath, { method = 'GET', body = undefined, headers = {}, token = undefined } = {}) {
      const targetUrl = urlPath.startsWith('http')
        ? urlPath
        : `${cleanBaseUrl}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;

      const reqHeaders = client.buildHeaders(headers, token);
      let payload = body;
      if (
        body !== undefined &&
        body !== null &&
        !Buffer.isBuffer(body) &&
        !(body instanceof Uint8Array) &&
        typeof body !== 'string'
      ) {
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
        payload = JSON.stringify(body);
      }

      const res = await fetch(targetUrl, {
        method,
        headers: reqHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : payload
      });

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const text = buffer.toString('utf8');
      let data = null;
      if (contentType.includes('application/json') || (text.startsWith('{') || text.startsWith('['))) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      } else {
        data = text;
      }

      const headerObj = Object.fromEntries(res.headers.entries());
      return {
        status: res.status,
        ok: res.ok,
        headers: headerObj,
        data,
        body: data,
        text,
        buffer
      };
    },

    get(urlPath, opts = {}) {
      return client.request(urlPath, { ...opts, method: 'GET' });
    },

    post(urlPath, body = {}, opts = {}) {
      return client.request(urlPath, { ...opts, method: 'POST', body });
    },

    put(urlPath, body = {}, opts = {}) {
      return client.request(urlPath, { ...opts, method: 'PUT', body });
    },

    del(urlPath, opts = {}) {
      return client.request(urlPath, { ...opts, method: 'DELETE' });
    },

    async login(email, password = 'UniPass2026!', extraBody = {}) {
      const res = await client.post('/api/auth/login', {
        email,
        password,
        deviceType: client.deviceType,
        deviceInstanceId: client.deviceInstanceId,
        deviceFingerprint: client.deviceFingerprint,
        deviceLabel: client.deviceLabel,
        ...extraBody
      });
      if (res.status === 200 && res.data && (res.data.sessionToken || res.data.token)) {
        client.token = res.data.sessionToken || res.data.token;
      }
      return res;
    },

    async logout() {
      const res = await client.post('/api/auth/logout', {});
      if (res.status === 200) {
        client.token = null;
      }
      return res;
    },

    async uploadMultipart(
      urlPath,
      {
        fields = {},
        fileField = 'file',
        filename = 'upload.txt',
        mimeType = 'text/plain',
        content = 'Sample content'
      } = {}
    ) {
      const boundary = `----UniLearnBoundary${Date.now().toString(16)}`;
      const chunks = [];
      for (const [key, val] of Object.entries(fields)) {
        if (val === undefined || val === null) continue;
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(val)}\r\n`,
            'utf8'
          )
        );
      }
      const fileBuffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
          'utf8'
        )
      );
      chunks.push(fileBuffer);
      chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

      const bodyBuffer = Buffer.concat(chunks);
      return client.request(urlPath, {
        method: 'POST',
        body: bodyBuffer,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      });
    },

    async openSSE(urlPath = '/api/auth/sessions/events') {
      const controller = new AbortController();
      const events = [];
      const sep = urlPath.includes('?') ? '&' : '?';
      const targetUrl = `${cleanBaseUrl}${urlPath}${
        client.token ? `${sep}token=${encodeURIComponent(client.token)}` : ''
      }`;
      const res = await fetch(targetUrl, {
        headers: client.buildHeaders({ Accept: 'text/event-stream' }),
        signal: controller.signal
      });

      const reader = res.body ? res.body.getReader() : null;
      const decoder = new TextDecoder();
      let rawBuffer = '';

      const parseBlock = (block) => {
        const lines = block.split(/\r?\n/);
        let eventName = 'message';
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (dataLines.length === 0 && eventName === 'message') return null;
        const rawData = dataLines.join('\n');
        let parsedData = rawData;
        try {
          parsedData = JSON.parse(rawData);
        } catch {
          // keep string
        }
        return { event: eventName, data: parsedData, raw: block };
      };

      const pump = (async () => {
        if (!reader) return;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            rawBuffer += decoder.decode(value, { stream: true });
            const parts = rawBuffer.split(/\r?\n\r?\n/);
            rawBuffer = parts.pop() || '';
            for (const part of parts) {
              if (!part.trim()) continue;
              const evt = parseBlock(part);
              if (evt) events.push(evt);
            }
          }
        } catch (err) {
          if (err && err.name !== 'AbortError') {
            // stream closed
          }
        }
      })();

      return {
        status: res.status,
        events,
        async waitForEvent(matchFnOrName, timeoutMs = 5000) {
          const predicate =
            typeof matchFnOrName === 'function'
              ? matchFnOrName
              : (e) =>
                  e.event === matchFnOrName ||
                  (e.data && (e.data.code === matchFnOrName || e.data.type === matchFnOrName)) ||
                  e.raw.includes(String(matchFnOrName));
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const found = events.find(predicate);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 40));
          }
          throw new Error(
            `Timed out waiting for SSE event (${String(matchFnOrName)}). Received: ${JSON.stringify(events)}`
          );
        },
        async close() {
          controller.abort();
          await pump.catch(() => {});
        }
      };
    },

    async openWebSocket(urlPath = '/ws') {
      const wsBase = cleanBaseUrl.replace(/^http/, 'ws');
      const sep = urlPath.includes('?') ? '&' : '?';
      const wsUrl = `${wsBase}${urlPath}${
        client.token ? `${sep}token=${encodeURIComponent(client.token)}` : ''
      }`;
      const messages = [];
      const ws = new WebSocket(wsUrl);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      ws.addEventListener('message', (evt) => {
        const raw = typeof evt.data === 'string' ? evt.data : String(evt.data);
        let parsed = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep string
        }
        messages.push(parsed);
      });

      return {
        ws,
        messages,
        async waitForMessage(matchFnOrType, timeoutMs = 5000) {
          const predicate =
            typeof matchFnOrType === 'function'
              ? matchFnOrType
              : (m) =>
                  (m && (m.type === matchFnOrType || m.event === matchFnOrType || m.code === matchFnOrType)) ||
                  JSON.stringify(m).includes(String(matchFnOrType));
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const found = messages.find(predicate);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 40));
          }
          throw new Error(
            `Timed out waiting for WS message (${String(matchFnOrType)}). Received: ${JSON.stringify(messages)}`
          );
        },
        close() {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      };
    }
  };

  return client;
}

/**
 * Launches headless Google Chrome via bundled puppeteer-core with fake WebRTC media streams.
 */
export async function launchBrowser(options = {}) {
  const { puppeteer } = await import(pathToFileURL(PUPPETEER_MODULE_PATH).href);
  const browser = await puppeteer.launch({
    executablePath: options.executablePath || CHROME_EXECUTABLE_PATH,
    headless: options.headless !== false ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(options.args || [])
    ]
  });
  return browser;
}

/**
 * Creates an isolated BrowserContext and Page pre-configured for either Desktop PC (1280x800)
 * or Mobile Phone (390x844, touch & mobile UA) with deterministic device identity headers & localStorage.
 */
export async function createDevicePage(browser, options = {}) {
  const deviceType = options.deviceType || 'pc';
  const deviceInstanceId = options.deviceInstanceId || `browser-${deviceType}-1`;
  const deviceFingerprint = options.deviceFingerprint || `fp-${deviceType}-${deviceInstanceId}`;
  const deviceLabel =
    options.deviceLabel ||
    (deviceType === 'pc' ? `Browser PC (${deviceInstanceId})` : `Browser Phone (${deviceInstanceId})`);

  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  const defaultViewport =
    deviceType === 'phone'
      ? { width: 390, height: 844, isMobile: true, hasTouch: true }
      : { width: 1280, height: 800, isMobile: false, hasTouch: false };

  await page.setViewport(options.viewport || defaultViewport);

  const userAgent =
    options.userAgent ||
    (deviceType === 'phone'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({
    'X-Device-Type': deviceType,
    'X-Device-Fingerprint': deviceFingerprint,
    'X-Device-Instance-Id': deviceInstanceId,
    'X-Device-Label': deviceLabel
  });

  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });

  await page.evaluateOnNewDocument(
    (meta) => {
      try {
        window.__UNILEARN_DEVICE__ = meta;
        localStorage.setItem('unilearn_device_type', meta.deviceType);
        localStorage.setItem('unilearn_device_instance_id', meta.deviceInstanceId);
        localStorage.setItem('unilearn_device_fingerprint', meta.deviceFingerprint);
        localStorage.setItem('unilearn_device_label', meta.deviceLabel);
      } catch {
        // ignore storage errors on blank origins
      }
    },
    { deviceType, deviceInstanceId, deviceFingerprint, deviceLabel }
  );

  return {
    context,
    page,
    pageErrors,
    deviceType,
    deviceInstanceId,
    deviceFingerprint,
    deviceLabel,
    close: async () => {
      try {
        await context.close();
      } catch {
        // ignore close errors
      }
    }
  };
}
