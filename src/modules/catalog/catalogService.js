import crypto from 'node:crypto';
import CONFIG from '../../config.js';
import { runImmediateTransaction } from '../../db/connection.js';
import { chunkText, formatCourseFile, indexChunksIntoDb } from './ingestionService.js';

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatMajor(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    faculty: r.faculty,
    description: r.description,
    icon: r.icon || 'graduation-cap',
    subjectCount: Number(r.subject_count || 0),
    lessonCount: Number(r.lesson_count || 0),
    fileCount: Number(r.file_count || 0),
    createdAt: r.created_at
  };
}

export function formatSubject(r) {
  if (!r) return null;
  return {
    id: r.id,
    majorId: r.major_id,
    majorCode: r.major_code || null,
    majorName: r.major_name || null,
    code: r.code,
    title: r.title,
    semester: r.semester,
    credits: Number(r.credits || 4),
    instructor: r.instructor,
    syllabusSummary: r.syllabus_summary,
    examWeight: safeJsonParse(r.exam_weight_json, {}),
    lessonCount: Number(r.lesson_count || 0),
    fileCount: Number(r.file_count || 0),
    createdAt: r.created_at
  };
}

export function formatLesson(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    moduleNumber: Number(r.module_number || 1),
    title: r.title,
    summary: r.summary,
    contentMarkdown: r.content_markdown,
    keyConcepts: safeJsonParse(r.key_concepts_json, []),
    formulas: safeJsonParse(r.formulas_json, []),
    estimatedMinutes: Number(r.estimated_minutes || 30),
    createdBy: r.created_by,
    createdAt: r.created_at
  };
}

export function listMajors(db) {
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
  return rows.map(formatMajor);
}

export function createMajor(db, payload) {
  const code = String(payload.code || '').trim().toUpperCase();
  const name = String(payload.name || '').trim();
  const faculty = String(payload.faculty || 'Faculty of Arts & Sciences').trim();
  const description = String(payload.description || '').trim();
  const icon = String(payload.icon || 'graduation-cap').trim();

  if (!code || !name) {
    const err = new Error('Major code and name are required.');
    err.statusCode = 400;
    err.code = 'INVALID_MAJOR_PAYLOAD';
    throw err;
  }

  const existing = db.prepare('SELECT id FROM majors WHERE UPPER(code) = ?').get(code);
  if (existing) {
    const err = new Error(`Major with code ${code} already exists.`);
    err.statusCode = 409;
    err.code = 'MAJOR_EXISTS';
    throw err;
  }

  const id = `major_${code.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${crypto.randomUUID().slice(0, 4)}`;
  db.prepare(`
    INSERT INTO majors (id, code, name, faculty, description, icon)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, code, name, faculty, description, icon);

  const created = db
    .prepare(`
      SELECT m.*, 0 AS subject_count, 0 AS lesson_count, 0 AS file_count
      FROM majors m WHERE m.id = ?
    `)
    .get(id);
  return formatMajor(created);
}

export function listSubjects(db, { majorId = '', q = '' } = {}) {
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

  if (majorId) {
    const filter = String(majorId).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.major_id.toLowerCase() === filter ||
        String(r.major_code || '').toLowerCase() === filter
    );
  }
  if (q) {
    const query = String(q).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.code.toLowerCase().includes(query) ||
        r.title.toLowerCase().includes(query) ||
        r.syllabus_summary.toLowerCase().includes(query)
    );
  }

  return rows.map(formatSubject);
}

export function createSubject(db, payload) {
  const majorId = String(payload.majorId || '').trim();
  const code = String(payload.code || '').trim().toUpperCase();
  const title = String(payload.title || '').trim();

  if (!majorId || !code || !title) {
    const err = new Error('majorId, code, and title are required.');
    err.statusCode = 400;
    err.code = 'INVALID_SUBJECT_PAYLOAD';
    throw err;
  }

  const major = db.prepare('SELECT id FROM majors WHERE id = ? OR UPPER(code) = ?').get(majorId, majorId.toUpperCase());
  if (!major) {
    const err = new Error(`Major not found: ${majorId}`);
    err.statusCode = 404;
    err.code = 'MAJOR_NOT_FOUND';
    throw err;
  }

  const dup = db.prepare('SELECT id FROM subjects WHERE UPPER(code) = ?').get(code);
  if (dup) {
    const err = new Error(`Subject code ${code} already exists.`);
    err.statusCode = 409;
    err.code = 'SUBJECT_EXISTS';
    throw err;
  }

  const id = `subj_${code.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${crypto.randomUUID().slice(0, 4)}`;
  db.prepare(`
    INSERT INTO subjects (id, major_id, code, title, semester, credits, instructor, syllabus_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    major.id,
    code,
    title,
    String(payload.semester || 'Fall / Year 3'),
    Number(payload.credits || 4),
    String(payload.instructor || 'Prof. HSU Faculty'),
    String(payload.syllabusSummary || '')
  );

  const row = db
    .prepare(`
      SELECT s.*, m.code AS major_code, m.name AS major_name, 0 AS lesson_count, 0 AS file_count
      FROM subjects s LEFT JOIN majors m ON m.id = s.major_id
      WHERE s.id = ?
    `)
    .get(id);
  return formatSubject(row);
}

export function getSubjectDetail(db, subjectId) {
  const subjectRow = db
    .prepare(`
      SELECT
        s.*,
        m.code AS major_code,
        m.name AS major_name,
        (SELECT COUNT(*) FROM lessons l WHERE l.subject_id = s.id) AS lesson_count,
        (SELECT COUNT(*) FROM course_files f WHERE f.subject_id = s.id) AS file_count
      FROM subjects s
      LEFT JOIN majors m ON m.id = s.major_id
      WHERE s.id = ?
    `)
    .get(subjectId);

  if (!subjectRow) {
    const err = new Error(`Subject not found: ${subjectId}`);
    err.statusCode = 404;
    err.code = 'SUBJECT_NOT_FOUND';
    throw err;
  }

  const lessons = db
    .prepare('SELECT * FROM lessons WHERE subject_id = ? ORDER BY module_number ASC, created_at ASC')
    .all(subjectId)
    .map(formatLesson);

  const files = db
    .prepare('SELECT * FROM course_files WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subjectId)
    .map(formatCourseFile);

  const slideDecks = db
    .prepare('SELECT id, subject_id, lesson_id, title, subtitle, theme, slide_count, created_at FROM slide_decks WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subjectId)
    .map((d) => ({
      id: d.id,
      subjectId: d.subject_id,
      lessonId: d.lesson_id,
      title: d.title,
      subtitle: d.subtitle,
      theme: d.theme,
      slideCount: Number(d.slide_count || 0),
      createdAt: d.created_at
    }));

  const videos = db
    .prepare('SELECT id, subject_id, lesson_id, title, topic_prompt, duration_sec, style_theme, status, created_at FROM ai_videos WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subjectId)
    .map((v) => ({
      id: v.id,
      subjectId: v.subject_id,
      lessonId: v.lesson_id,
      title: v.title,
      topicPrompt: v.topic_prompt,
      durationSec: Number(v.duration_sec || 45),
      styleTheme: v.style_theme,
      status: v.status,
      createdAt: v.created_at
    }));

  const exams = db
    .prepare('SELECT id, subject_id, lesson_id, mode, title, difficulty, time_limit_sec, total_points, created_at FROM exams_and_quizzes WHERE subject_id = ? ORDER BY created_at DESC')
    .all(subjectId)
    .map((e) => ({
      id: e.id,
      subjectId: e.subject_id,
      lessonId: e.lesson_id,
      mode: e.mode,
      title: e.title,
      difficulty: e.difficulty,
      timeLimitSec: Number(e.time_limit_sec || 900),
      totalPoints: Number(e.total_points || 100),
      createdAt: e.created_at
    }));

  return {
    subject: formatSubject(subjectRow),
    lessons,
    files,
    slideDecks,
    videos,
    exams
  };
}

export function createLesson(db, subjectId, payload, createdBy = 'student') {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) {
    const err = new Error(`Subject not found: ${subjectId}`);
    err.statusCode = 404;
    err.code = 'SUBJECT_NOT_FOUND';
    throw err;
  }

  const title = String(payload.title || '').trim();
  const contentMarkdown = String(payload.contentMarkdown || payload.content || '').trim();
  if (!title || !contentMarkdown) {
    const err = new Error('Lesson title and contentMarkdown are required.');
    err.statusCode = 400;
    err.code = 'INVALID_LESSON_PAYLOAD';
    throw err;
  }

  const lessonId = `les_${crypto.randomUUID().slice(0, 12)}`;
  const keyConcepts = Array.isArray(payload.keyConcepts) ? payload.keyConcepts : [];
  const formulas = Array.isArray(payload.formulas) ? payload.formulas : [];
  const extraKeywords = [
    ...keyConcepts.map((k) => (typeof k === 'object' ? (k.name || JSON.stringify(k)) : String(k))),
    String(payload.summary || '')
  ]
    .filter(Boolean)
    .join(', ');
  const chunks = chunkText(contentMarkdown, { sourceTitle: title }).map((c) => ({
    ...c,
    keywords: [c.keywords, extraKeywords].filter(Boolean).join(', ')
  }));

  let chunksCreated = 0;
  runImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO lessons (
        id, subject_id, module_number, title, summary, content_markdown,
        key_concepts_json, formulas_json, estimated_minutes, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lessonId,
      subjectId,
      Number(payload.moduleNumber || 1),
      title,
      String(payload.summary || contentMarkdown.slice(0, 180)),
      contentMarkdown,
      JSON.stringify(keyConcepts),
      JSON.stringify(formulas),
      Number(payload.estimatedMinutes || 30),
      createdBy
    );

    chunksCreated = indexChunksIntoDb(db, {
      subjectId,
      lessonId,
      sourceType: 'lesson',
      sourceTitle: title,
      chunks
    });
  });

  const saved = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  return {
    lesson: formatLesson(saved),
    chunksCreated
  };
}

export function getLessonDetail(db, lessonId) {
  const lessonRow = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  if (!lessonRow) {
    const err = new Error(`Lesson not found: ${lessonId}`);
    err.statusCode = 404;
    err.code = 'LESSON_NOT_FOUND';
    throw err;
  }

  const subjectRow = db
    .prepare(`
      SELECT s.*, m.code AS major_code, m.name AS major_name
      FROM subjects s LEFT JOIN majors m ON m.id = s.major_id
      WHERE s.id = ?
    `)
    .get(lessonRow.subject_id);

  const files = db
    .prepare('SELECT * FROM course_files WHERE subject_id = ? AND (lesson_id = ? OR lesson_id IS NULL) ORDER BY created_at DESC')
    .all(lessonRow.subject_id, lessonId)
    .map(formatCourseFile);

  const chunks = db
    .prepare('SELECT * FROM course_chunks WHERE lesson_id = ? ORDER BY chunk_index ASC')
    .all(lessonId)
    .map((c) => ({
      id: c.id,
      heading: c.heading,
      content: c.content,
      keywords: c.keywords
    }));

  return {
    lesson: formatLesson(lessonRow),
    subject: formatSubject(subjectRow),
    files,
    chunks
  };
}

export function listFiles(db, { subjectId = '', majorId = '' } = {}) {
  let sql = 'SELECT * FROM course_files WHERE 1=1';
  const params = [];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (majorId) {
    sql += ' AND major_id = ?';
    params.push(majorId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatCourseFile);
}

export function getFileDetail(db, fileId) {
  const row = db.prepare('SELECT * FROM course_files WHERE id = ?').get(fileId);
  if (!row) {
    const err = new Error(`Course file not found: ${fileId}`);
    err.statusCode = 404;
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  const chunks = db
    .prepare('SELECT * FROM course_chunks WHERE file_id = ? ORDER BY chunk_index ASC')
    .all(fileId)
    .map((c) => ({
      id: c.id,
      heading: c.heading,
      content: c.content,
      keywords: c.keywords
    }));
  return {
    file: formatCourseFile(row),
    chunks
  };
}

export function getOverview(db) {
  const majors = listMajors(db);
  const subjects = listSubjects(db);
  const lessonCount = db.prepare('SELECT COUNT(*) AS cnt FROM lessons').get().cnt;
  const fileCount = db.prepare('SELECT COUNT(*) AS cnt FROM course_files').get().cnt;
  const chunkCount = db.prepare('SELECT COUNT(*) AS cnt FROM course_chunks').get().cnt;

  return {
    university: CONFIG.university,
    stats: {
      majors: majors.length,
      subjects: subjects.length,
      lessons: Number(lessonCount || 0),
      files: Number(fileCount || 0),
      chunks: Number(chunkCount || 0)
    },
    majors,
    subjects
  };
}
