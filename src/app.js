import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import CONFIG, { ROOT_DIR } from './config.js';
import { createDatabase } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { generateDeterministicEmbedding, hashPassword, seedDatabase } from './db/seed.js';
import { seedXmumCurriculum } from './db/seedXmum.js';
import { authMiddleware } from './middleware/auth.js';
import { deviceGuardMiddleware } from './middleware/deviceGuard.js';
import { subscriptionGateMiddleware } from './middleware/subscriptionGate.js';
import { createRealtimeHub } from './modules/auth-security/realtimeHub.js';
import { createSecurityRouter } from './modules/auth-security/securityRoutes.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

function parseRequestBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.rawBody = Buffer.alloc(0);
      req.body = {};
      return resolve({});
    }

    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const rawBuffer = Buffer.concat(chunks);
      req.rawBody = rawBuffer;
      const contentType = String(req.headers['content-type'] || '').toLowerCase();

      if (rawBuffer.length === 0) {
        req.body = {};
        return resolve({});
      }

      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(rawBuffer.toString('utf8'));
          req.body = parsed && typeof parsed === 'object' ? parsed : {};
          return resolve(req.body);
        } catch {
          req.body = {};
          return resolve({});
        }
      }

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(rawBuffer.toString('utf8'));
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        req.body = obj;
        return resolve(obj);
      }

      // Try JSON fallback if body starts with { or [
      const trimmed = rawBuffer.toString('utf8').trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          req.body = JSON.parse(trimmed);
          return resolve(req.body);
        } catch {
          // Ignore
        }
      }

      req.body = {};
      return resolve({});
    });
    req.on('error', (err) => reject(err));
  });
}

async function tryDelegateToModule(relModulePath, req, res, context) {
  const fullPath = path.join(ROOT_DIR, 'src', relModulePath);
  if (!fs.existsSync(fullPath)) {
    return false;
  }

  const mod = await import(pathToFileURL(fullPath).href);
  const candidateFns = [
    mod.default,
    mod.handleCatalogRoute,
    mod.handleCatalogRoutes,
    mod.createCatalogRouter,
    mod.catalogRoutes,
    mod.handleAiHubRoute,
    mod.handleAiHubRoutes,
    mod.createAiHubRouter,
    mod.aiHubRoutes,
    mod.handleLearningRoute,
    mod.handleLearningRoutes,
    mod.createLearningRouter,
    mod.learningRoutes,
    mod.handleMediaRoute,
    mod.handleMediaRoutes,
    mod.createMediaRouter,
    mod.mediaRoutes,
    ...Object.values(mod).filter((v) => typeof v === 'function')
  ].filter((fn, idx, arr) => typeof fn === 'function' && arr.indexOf(fn) === idx);

  for (const fn of candidateFns) {
    let result;
    // Detect factory pattern `createXRouter({ db, dataDir, ... })` vs direct `(req, res, ctx)`
    if (fn.name.startsWith('create') || fn.length <= 1) {
      const handler = await fn(context);
      if (typeof handler === 'function') {
        result = await handler(req, res, context);
      }
    } else {
      result = await fn(req, res, context);
      if (typeof result === 'function') {
        result = await result(req, res, context);
      }
    }

    if (res.writableEnded || res.headersSent || result === true) {
      return true;
    }
  }

  return false;
}

function handleBuiltInCatalogFallbacks(req, res, db) {
  const { method, pathname, query } = req;

  if (method === 'GET' && pathname === '/api/protected/ping') {
    res.json(200, {
      ok: true,
      studentId: req.auth.student.id,
      email: req.auth.student.email,
      subscriptionStatus: req.auth.subscription?.status || 'active',
      deviceType: req.auth.session.device_type,
      slotVersion: req.auth.slot?.slot_version || 1
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/catalog/majors') {
    const rows = db
      .prepare(`
        SELECT
          m.*,
          (SELECT COUNT(*) FROM subjects s WHERE s.major_id = m.id) AS subject_count,
          (SELECT COUNT(*) FROM lessons l JOIN subjects s ON l.subject_id = s.id WHERE s.major_id = m.id) AS lesson_count,
          (SELECT COUNT(*) FROM course_files f WHERE f.major_id = m.id) AS file_count
        FROM majors m
        ORDER BY m.code ASC
      `)
      .all();

    const majors = rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      faculty: r.faculty,
      description: r.description,
      icon: r.icon,
      subjectCount: Number(r.subject_count || 0),
      lessonCount: Number(r.lesson_count || 0),
      fileCount: Number(r.file_count || 0),
      createdAt: r.created_at
    }));

    res.json(200, { majors });
    return true;
  }

  if (method === 'GET' && pathname === '/api/catalog/subjects') {
    const majorFilter = query.majorId ? String(query.majorId).trim() : '';
    const qFilter = query.q ? String(query.q).trim().toLowerCase() : '';

    let rows = db
      .prepare(`
        SELECT
          s.*,
          m.code AS major_code,
          m.name AS major_name,
          (SELECT COUNT(*) FROM lessons l WHERE l.subject_id = s.id) AS lesson_count,
          (SELECT COUNT(*) FROM course_files f WHERE f.subject_id = s.id) AS file_count
        FROM subjects s
        LEFT JOIN majors m ON m.id = s.major_id
        ORDER BY s.code ASC
      `)
      .all();

    if (majorFilter) {
      rows = rows.filter(
        (r) =>
          r.major_id === majorFilter ||
          String(r.major_code || '').toLowerCase() === majorFilter.toLowerCase()
      );
    }
    if (qFilter) {
      rows = rows.filter(
        (r) =>
          r.code.toLowerCase().includes(qFilter) ||
          r.title.toLowerCase().includes(qFilter) ||
          r.syllabus_summary.toLowerCase().includes(qFilter)
      );
    }

    const subjects = rows.map((r) => ({
      id: r.id,
      majorId: r.major_id,
      majorCode: r.major_code,
      majorName: r.major_name,
      code: r.code,
      title: r.title,
      semester: r.semester,
      credits: Number(r.credits || 4),
      instructor: r.instructor,
      syllabusSummary: r.syllabus_summary,
      lessonCount: Number(r.lesson_count || 0),
      fileCount: Number(r.file_count || 0),
      createdAt: r.created_at
    }));

    res.json(200, { subjects });
    return true;
  }

  if (method === 'GET' && pathname === '/api/catalog/search') {
    const rawQ = String(query.q || '').trim();
    const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);

    if (!rawQ) {
      const defaultRows = db
        .prepare('SELECT * FROM course_chunks LIMIT ?')
        .all(limit);
      res.json(200, {
        results: defaultRows.map((c) => ({
          chunkId: c.id,
          subjectId: c.subject_id,
          lessonId: c.lesson_id,
          fileId: c.file_id,
          sourceType: c.source_type,
          sourceTitle: c.source_title,
          heading: c.heading,
          snippet: c.content.slice(0, 220),
          content: c.content,
          score: 1.0
        }))
      });
      return true;
    }

    let rows = [];
    const safeTerms = rawQ
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (safeTerms.length > 0) {
      const ftsQuery = safeTerms.join(' OR ');
      try {
        rows = db
          .prepare(`
            SELECT
              c.*,
              snippet(course_chunks_fts, 4, '<mark>', '</mark>', '...', 32) AS fts_snippet
            FROM course_chunks_fts f
            JOIN course_chunks c ON c.id = f.chunk_id
            WHERE course_chunks_fts MATCH ?
            LIMIT ?
          `)
          .all(ftsQuery, limit);
      } catch {
        rows = [];
      }
    }

    if (rows.length === 0) {
      const likeParam = `%${rawQ}%`;
      rows = db
        .prepare(`
          SELECT * FROM course_chunks
          WHERE content LIKE ? OR source_title LIKE ? OR keywords LIKE ?
          LIMIT ?
        `)
        .all(likeParam, likeParam, likeParam, limit);
    }

    res.json(200, {
      results: rows.map((c, idx) => ({
        chunkId: c.id,
        subjectId: c.subject_id,
        lessonId: c.lesson_id,
        fileId: c.file_id,
        sourceType: c.source_type,
        sourceTitle: c.source_title,
        heading: c.heading,
        snippet: c.fts_snippet || c.content.slice(0, 220),
        content: c.content,
        score: Number((1 / (idx + 1)).toFixed(4))
      }))
    });
    return true;
  }

  return false;
}

export function createApp({
  dbPath = ':memory:',
  dataDir = CONFIG.dataDir,
  seed = true,
  seedXmum = dbPath !== ':memory:'
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = createDatabase(dbPath);
  initSchema(db);
  if (seed !== false) {
    seedDatabase(db);
  }
  if (seedXmum) {
    seedXmumCurriculum(db, { hashPassword, generateDeterministicEmbedding });
  }

  const realtimeHub = createRealtimeHub();
  const handleSecurityRoute = createSecurityRouter({ db, realtimeHub });
  const context = { db, dataDir, config: CONFIG, realtimeHub };

  const appHandler = async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      req.pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.db = db;
      req.appDb = db;
      req.dataDir = dataDir;
      req.realtimeHub = realtimeHub;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS'
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Session-Token, X-Device-Type, X-Device-Fingerprint, X-Device-Instance-Id, X-Viewport-Width, X-Trigger-Anomaly'
      );
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Subscription-Warning'
      );

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.json = (statusCode, payload, extraHeaders = {}) => {
        if (res.writableEnded) return;
        const bodyStr = JSON.stringify(payload);
        res.writeHead(statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          ...extraHeaders
        });
        res.end(bodyStr);
      };

      await parseRequestBody(req);

      const { pathname } = req;

      // 1. Public Health Endpoint
      if (req.method === 'GET' && pathname === '/api/health') {
        res.json(200, {
          status: 'ok',
          university: CONFIG.university.name,
          code: CONFIG.university.code,
          allowedDomains: CONFIG.university.allowedDomains
        });
        return;
      }

      // 2. M1 Auth, Security, Biometrics, Device Slots & Subscription Endpoints
      if (
        pathname.startsWith('/api/auth') ||
        pathname.startsWith('/api/subscription') ||
        pathname.startsWith('/api/subscriptions') ||
        pathname.startsWith('/api/devices') ||
        pathname.startsWith('/api/security')
      ) {
        const handled = await handleSecurityRoute(req, res);
        if (handled) return;
      }

      // 3. Protected University Study, Catalog, AI Hub, Slides, Research, Video & Exam Routes
      const isProtectedStudyRoute =
        pathname.startsWith('/api/catalog') ||
        pathname.startsWith('/api/ai') ||
        pathname.startsWith('/api/slides') ||
        pathname.startsWith('/api/learning') ||
        pathname.startsWith('/api/research') ||
        pathname.startsWith('/api/videos') ||
        pathname.startsWith('/api/media') ||
        pathname.startsWith('/api/exam-prep') ||
        pathname.startsWith('/api/protected');

      if (isProtectedStudyRoute) {
        if (!authMiddleware(req, res, db)) return;
        if (!deviceGuardMiddleware(req, res, db)) return;
        if (!subscriptionGateMiddleware(req, res, db)) return;

        if (pathname.startsWith('/api/catalog')) {
          const delegated = await tryDelegateToModule(
            'modules/catalog/catalogRoutes.js',
            req,
            res,
            context
          );
          if (delegated) return;
        } else if (pathname.startsWith('/api/ai')) {
          const delegated = await tryDelegateToModule(
            'modules/ai-hub/aiHubRoutes.js',
            req,
            res,
            context
          );
          if (delegated) return;
        } else if (
          pathname.startsWith('/api/slides') ||
          pathname.startsWith('/api/learning') ||
          pathname.startsWith('/api/exam-prep')
        ) {
          const delegated = await tryDelegateToModule(
            'modules/learning-studio/learningRoutes.js',
            req,
            res,
            context
          );
          if (delegated) return;
        } else if (
          pathname.startsWith('/api/research') ||
          pathname.startsWith('/api/videos') ||
          pathname.startsWith('/api/media')
        ) {
          const delegated = await tryDelegateToModule(
            'modules/research-media/mediaRoutes.js',
            req,
            res,
            context
          );
          if (delegated) return;
        }

        if (handleBuiltInCatalogFallbacks(req, res, db)) {
          return;
        }
      }

      if (pathname.startsWith('/api/')) {
        res.json(404, {
          error: `API route not found: ${req.method} ${pathname}`,
          code: 'ROUTE_NOT_FOUND'
        });
        return;
      }

      // 4. Static Frontend Serving from src/public
      const publicDir = CONFIG.publicDir;
      let targetFile = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
      if (!targetFile.startsWith(publicDir)) {
        res.json(403, { error: 'Forbidden path' });
        return;
      }

      if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
        targetFile = path.join(publicDir, 'index.html');
      }

      if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
        const ext = path.extname(targetFile).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(targetFile);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }

      // Minimal fallback HTML shell if src/public/index.html is not yet created
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>UniLearn AI — Horizon State University</title></head>
<body><h1>UniLearn AI — Horizon State University (HSU)</h1></body>
</html>`);
    } catch (err) {
      if (!res.writableEnded) {
        const status = err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
        res.json(status, {
          error: err.message || 'Internal Server Error',
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR'
        });
      }
    }
  };

  const server = http.createServer(appHandler);
  realtimeHub.attachWebSocketServer(server, db);

  const close = async () => {
    realtimeHub.closeAll();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    try {
      db.close();
    } catch {
      // Ignore already closed DB
    }
  };

  return {
    app: appHandler,
    server,
    db,
    realtimeHub,
    close
  };
}

export default createApp;
