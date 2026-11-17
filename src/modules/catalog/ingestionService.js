import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runImmediateTransaction } from '../../db/connection.js';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'can', 'will', 'all', 'any', 'one',
  'two', 'use', 'using', 'used', 'into', 'than', 'then', 'when', 'where',
  'which', 'while', 'about', 'each', 'more', 'most', 'such', 'only', 'also'
]);

export function parseMultipartFormData(rawBuffer, contentTypeHeader = '') {
  const match = String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match || !rawBuffer || rawBuffer.length === 0) {
    return { fields: {}, files: [] };
  }
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let start = rawBuffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = rawBuffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;

    let part = rawBuffer.subarray(start + boundaryBuf.length, next);
    if (part.subarray(0, 2).toString('utf8') === '--') break;
    if (part.subarray(0, 2).toString('utf8') === '\r\n') part = part.subarray(2);
    else if (part.subarray(0, 1).toString('utf8') === '\n') part = part.subarray(1);

    let headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = part.indexOf(Buffer.from('\n\n'));
      sepLen = 2;
    }
    if (headerEnd === -1) {
      start = next;
      continue;
    }

    const headerStr = part.subarray(0, headerEnd).toString('utf8');
    let bodyBuf = part.subarray(headerEnd + sepLen);
    if (bodyBuf.subarray(bodyBuf.length - 2).toString('utf8') === '\r\n') {
      bodyBuf = bodyBuf.subarray(0, bodyBuf.length - 2);
    } else if (bodyBuf.subarray(bodyBuf.length - 1).toString('utf8') === '\n') {
      bodyBuf = bodyBuf.subarray(0, bodyBuf.length - 1);
    }

    const nameMatch = headerStr.match(/name="([^"]+)"/i);
    const filenameMatch = headerStr.match(/filename="([^"]*)"/i);
    const ctMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);
    const fieldName = nameMatch ? nameMatch[1] : 'file';

    if (filenameMatch && filenameMatch[1]) {
      files.push({
        fieldName,
        filename: path.basename(filenameMatch[1]),
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        buffer: bodyBuf
      });
    } else {
      fields[fieldName] = bodyBuf.toString('utf8');
    }

    start = next;
  }

  return { fields, files };
}

function fallbackPdfTextExtract(buffer) {
  const raw = buffer.toString('latin1');
  const matches = [];
  const regex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    matches.push(m[1].replace(/\\([()\\])/g, '$1'));
  }
  const tjArrayRegex = /\[(.*?)\]\s*TJ/gs;
  while ((m = tjArrayRegex.exec(raw)) !== null) {
    const inner = m[1];
    const strRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let s;
    const parts = [];
    while ((s = strRegex.exec(inner)) !== null) {
      parts.push(s[1].replace(/\\([()\\])/g, '$1'));
    }
    if (parts.length > 0) matches.push(parts.join(''));
  }
  return matches.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractTextFromInput({
  buffer = null,
  contentText = '',
  contentBase64 = '',
  filename = 'document.txt',
  mimeType = ''
} = {}) {
  if (contentText && typeof contentText === 'string' && contentText.trim().length > 0) {
    return {
      text: contentText.trim(),
      buffer: Buffer.from(contentText, 'utf8'),
      mimeType: mimeType || inferMimeType(filename)
    };
  }

  let fileBuf = buffer;
  if (!fileBuf && contentBase64) {
    const cleaned = String(contentBase64).replace(/^data:[^;]+;base64,/, '');
    fileBuf = Buffer.from(cleaned, 'base64');
  }
  if (!fileBuf) {
    fileBuf = Buffer.alloc(0);
  }

  const ext = path.extname(String(filename || '')).toLowerCase();
  const resolvedMime = mimeType || inferMimeType(filename);
  const isPdf = ext === '.pdf' || resolvedMime.includes('pdf') || fileBuf.subarray(0, 4).toString('utf8') === '%PDF';

  if (isPdf && fileBuf.length > 0) {
    const tmpPath = path.join(os.tmpdir(), `unilearn_pdf_${crypto.randomUUID()}.pdf`);
    try {
      fs.writeFileSync(tmpPath, fileBuf);
      const out = execFileSync('/usr/bin/pdftotext', ['-layout', tmpPath, '-'], {
        encoding: 'utf8',
        maxBuffer: 15 * 1024 * 1024
      });
      const trimmed = String(out || '').trim();
      if (trimmed.length > 0) {
        return { text: trimmed, buffer: fileBuf, mimeType: 'application/pdf' };
      }
    } catch {
      // Fallback to pure-JS PDF text extraction
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    const fallback = fallbackPdfTextExtract(fileBuf);
    return {
      text: fallback || `PDF document: ${filename}`,
      buffer: fileBuf,
      mimeType: 'application/pdf'
    };
  }

  const utf8 = fileBuf.toString('utf8').trim();
  if (ext === '.json' || resolvedMime.includes('json')) {
    try {
      const parsed = JSON.parse(utf8);
      return {
        text: JSON.stringify(parsed, null, 2),
        buffer: fileBuf,
        mimeType: 'application/json'
      };
    } catch {
      return { text: utf8, buffer: fileBuf, mimeType: 'application/json' };
    }
  }

  return {
    text: utf8,
    buffer: fileBuf,
    mimeType: resolvedMime
  };
}

export function inferMimeType(filename = '') {
  const ext = path.extname(String(filename)).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json'
  };
  return map[ext] || 'text/plain';
}

export function extractTopics(text, filename = '') {
  const topics = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading && heading[1]) {
      topics.push(heading[1].trim());
    }
    if (topics.length >= 8) break;
  }

  if (topics.length < 4) {
    const freq = new Map();
    const words = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    const topWords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6 - topics.length)
      .map(([w]) => w);
    topics.push(...topWords);
  }

  if (topics.length === 0 && filename) {
    topics.push(path.basename(filename, path.extname(filename)));
  }
  return [...new Set(topics)].slice(0, 8);
}

export function chunkText(text, { sourceTitle = 'Document', maxChunkChars = 900 } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const lines = clean.split('\n');
  const sections = [];
  let currentHeading = sourceTitle;
  let buffer = [];

  for (const line of lines) {
    const hMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (hMatch) {
      if (buffer.join('\n').trim()) {
        sections.push({ heading: currentHeading, content: buffer.join('\n').trim() });
      }
      currentHeading = hMatch[1].trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.join('\n').trim()) {
    sections.push({ heading: currentHeading, content: buffer.join('\n').trim() });
  }

  const chunks = [];
  for (const sec of sections) {
    if (sec.content.length <= maxChunkChars) {
      chunks.push({
        heading: sec.heading,
        content: sec.content,
        keywords: extractTopics(sec.content, sec.heading).join(', ')
      });
    } else {
      const paragraphs = sec.content.split(/\n{2,}/);
      let acc = '';
      for (const p of paragraphs) {
        if ((acc + '\n\n' + p).trim().length > maxChunkChars && acc.trim()) {
          chunks.push({
            heading: sec.heading,
            content: acc.trim(),
            keywords: extractTopics(acc, sec.heading).join(', ')
          });
          acc = p;
        } else {
          acc = acc ? `${acc}\n\n${p}` : p;
        }
      }
      if (acc.trim()) {
        chunks.push({
          heading: sec.heading,
          content: acc.trim(),
          keywords: extractTopics(acc, sec.heading).join(', ')
        });
      }
    }
  }

  return chunks;
}

export function indexChunksIntoDb(db, { subjectId, lessonId = null, fileId = null, sourceType, sourceTitle, chunks }) {
  const insertChunk = db.prepare(`
    INSERT INTO course_chunks (id, subject_id, lesson_id, file_id, source_type, source_title, chunk_index, heading, content, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO course_chunks_fts (chunk_id, subject_id, source_title, heading, content, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let created = 0;
  chunks.forEach((chunk, idx) => {
    const chunkId = `chk_${crypto.randomUUID().slice(0, 12)}`;
    insertChunk.run(
      chunkId,
      subjectId,
      lessonId,
      fileId,
      sourceType,
      sourceTitle,
      idx,
      chunk.heading || sourceTitle,
      chunk.content,
      chunk.keywords || ''
    );
    insertFts.run(
      chunkId,
      subjectId,
      sourceTitle,
      chunk.heading || sourceTitle,
      chunk.content,
      chunk.keywords || ''
    );
    created += 1;
  });
  return created;
}

export function ingestCourseFile(db, dataDir, payload) {
  const {
    majorId: rawMajorId,
    subjectId,
    lessonId = null,
    filename = 'uploaded-notes.txt',
    mimeType = '',
    contentText = '',
    contentBase64 = '',
    buffer = null,
    uploadedBy = 'system',
    scope = 'student'
  } = payload;

  if (!subjectId) {
    const err = new Error('subjectId is required to ingest a course file.');
    err.statusCode = 400;
    err.code = 'SUBJECT_ID_REQUIRED';
    throw err;
  }

  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) {
    const err = new Error(`Subject not found: ${subjectId}`);
    err.statusCode = 404;
    err.code = 'SUBJECT_NOT_FOUND';
    throw err;
  }

  const majorId = rawMajorId || subject.major_id;
  const extracted = extractTextFromInput({
    buffer,
    contentText,
    contentBase64,
    filename,
    mimeType
  });

  if (!extracted.text || extracted.text.trim().length === 0) {
    const err = new Error('Uploaded file has no extractable text content.');
    err.statusCode = 400;
    err.code = 'EMPTY_FILE_CONTENT';
    throw err;
  }

  const fileId = `file_${crypto.randomUUID().slice(0, 12)}`;
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const storagePath = path.join(uploadsDir, `${fileId}_${safeName}`);
  fs.writeFileSync(storagePath, extracted.buffer.length > 0 ? extracted.buffer : Buffer.from(extracted.text, 'utf8'));

  const extractedTopics = extractTopics(extracted.text, filename);
  const summary = extracted.text.slice(0, 260).replace(/\s+/g, ' ').trim();
  const chunks = chunkText(extracted.text, { sourceTitle: filename });
  const sizeBytes = extracted.buffer.length || Buffer.byteLength(extracted.text, 'utf8');

  let chunksCreated = 0;
  runImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO course_files (
        id, major_id, subject_id, lesson_id, uploaded_by, scope,
        filename, mime_type, size_bytes, storage_path, extracted_text,
        summary, key_topics_json, chunk_count, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed')
    `).run(
      fileId,
      majorId,
      subjectId,
      lessonId || null,
      uploadedBy,
      scope,
      filename,
      extracted.mimeType,
      sizeBytes,
      storagePath,
      extracted.text,
      summary,
      JSON.stringify(extractedTopics),
      chunks.length
    );

    chunksCreated = indexChunksIntoDb(db, {
      subjectId,
      lessonId: lessonId || null,
      fileId,
      sourceType: 'file',
      sourceTitle: filename,
      chunks
    });
  });

  const saved = db.prepare('SELECT * FROM course_files WHERE id = ?').get(fileId);
  return {
    file: formatCourseFile(saved),
    chunksCreated,
    extractedTopics
  };
}

export function formatCourseFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    majorId: row.major_id,
    subjectId: row.subject_id,
    lessonId: row.lesson_id,
    uploadedBy: row.uploaded_by,
    scope: row.scope,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    extractedText: row.extracted_text,
    summary: row.summary,
    keyTopics: safeJsonParse(row.key_topics_json, []),
    chunkCount: Number(row.chunk_count || 0),
    status: row.status,
    createdAt: row.created_at
  };
}

export function searchCourseChunks(db, { q = '', majorId = '', subjectId = '', limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 50);
  const rawQ = String(q || '').trim();

  const filterClauses = [];
  const filterParams = [];
  if (subjectId) {
    filterClauses.push('c.subject_id = ?');
    filterParams.push(subjectId);
  }
  if (majorId) {
    filterClauses.push('s.major_id = ?');
    filterParams.push(majorId);
  }
  const whereExtra = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : '';

  if (!rawQ) {
    const rows = db
      .prepare(`
        SELECT c.*, s.major_id
        FROM course_chunks c
        JOIN subjects s ON s.id = c.subject_id
        WHERE 1=1 ${whereExtra}
        LIMIT ?
      `)
      .all(...filterParams, safeLimit);

    return rows.map((c) => ({
      chunkId: c.id,
      subjectId: c.subject_id,
      majorId: c.major_id,
      lessonId: c.lesson_id,
      fileId: c.file_id,
      sourceType: c.source_type,
      sourceTitle: c.source_title,
      heading: c.heading,
      snippet: c.content.slice(0, 220),
      content: c.content,
      score: 1.0
    }));
  }

  let rows = [];
  const safeTerms = rawQ
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (safeTerms.length > 0) {
    const ftsQuery = safeTerms.map((t) => `${t}*`).join(' OR ');
    try {
      rows = db
        .prepare(`
          SELECT
            c.*,
            s.major_id,
            snippet(course_chunks_fts, 4, '<mark>', '</mark>', '...', 32) AS fts_snippet,
            bm25(course_chunks_fts) AS rank_score
          FROM course_chunks_fts f
          JOIN course_chunks c ON c.id = f.chunk_id
          JOIN subjects s ON s.id = c.subject_id
          WHERE course_chunks_fts MATCH ? ${whereExtra}
          ORDER BY rank_score ASC
          LIMIT ?
        `)
        .all(ftsQuery, ...filterParams, safeLimit);
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    const likeParam = `%${rawQ}%`;
    rows = db
      .prepare(`
        SELECT c.*, s.major_id
        FROM course_chunks c
        JOIN subjects s ON s.id = c.subject_id
        WHERE (c.content LIKE ? OR c.source_title LIKE ? OR c.heading LIKE ? OR c.keywords LIKE ?)
        ${whereExtra}
        LIMIT ?
      `)
      .all(likeParam, likeParam, likeParam, likeParam, ...filterParams, safeLimit);
  }

  return rows.map((c, idx) => ({
    chunkId: c.id,
    subjectId: c.subject_id,
    majorId: c.major_id,
    lessonId: c.lesson_id,
    fileId: c.file_id,
    sourceType: c.source_type,
    sourceTitle: c.source_title,
    heading: c.heading,
    snippet: c.fts_snippet || c.content.slice(0, 220),
    content: c.content,
    score: Number((1 / (idx + 1)).toFixed(4))
  }));
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
