import crypto from 'node:crypto';
import { searchCourseChunks } from '../catalog/ingestionService.js';

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatFlashcard(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    lessonId: r.lesson_id,
    topicTag: r.topic_tag,
    front: r.front,
    back: r.back,
    hint: r.hint,
    formula: r.formula,
    easeFactor: Number(r.ease_factor || 2.5),
    intervalDays: Number(r.interval_days || 0),
    repetitions: Number(r.repetitions || 0),
    masteryLevel: r.mastery_level,
    nextReviewAt: r.next_review_at,
    lastReviewedAt: r.last_reviewed_at,
    createdAt: r.created_at
  };
}

export function formatExam(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    lessonId: r.lesson_id,
    mode: r.mode,
    title: r.title,
    difficulty: r.difficulty,
    timeLimitSec: Number(r.time_limit_sec || 900),
    questions: safeJsonParse(r.questions_json, []),
    totalPoints: Number(r.total_points || 100),
    createdAt: r.created_at
  };
}

export function formatAttempt(r) {
  if (!r) return null;
  return {
    id: r.id,
    examId: r.exam_id,
    userId: r.user_id,
    subjectId: r.subject_id,
    mode: r.mode,
    startedAt: r.started_at,
    submittedAt: r.submitted_at,
    durationUsedSec: Number(r.duration_used_sec || 0),
    scorePoints: Number(r.score_points || 0),
    totalPoints: Number(r.total_points || 100),
    percentage: Number(r.percentage || 0),
    letterGrade: r.letter_grade,
    answers: safeJsonParse(r.answers_json, {}),
    gradedResults: safeJsonParse(r.graded_results_json, []),
    topicBreakdown: safeJsonParse(r.topic_breakdown_json, {}),
    weaknessRecommendations: safeJsonParse(r.weakness_recommendations_json, [])
  };
}

export function formatStudyGuide(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    userId: r.user_id,
    title: r.title,
    weakTopics: safeJsonParse(r.weak_topics_json, []),
    contentMarkdown: r.content_markdown,
    checklist: safeJsonParse(r.checklist_json, []),
    createdAt: r.created_at
  };
}

export function listFlashcards(db, { subjectId = '', dueOnly = false } = {}) {
  let sql = 'SELECT * FROM flashcards WHERE 1=1';
  const params = [];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (dueOnly === true || dueOnly === 'true') {
    sql += " AND next_review_at <= datetime('now')";
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatFlashcard);
}

export function generateFlashcards(db, payload) {
  const { subjectId, lessonId = null, count = 5 } = payload;
  if (!subjectId) {
    const err = new Error('subjectId is required.');
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

  const lessons = lessonId
    ? db.prepare('SELECT * FROM lessons WHERE id = ?').all(lessonId)
    : db.prepare('SELECT * FROM lessons WHERE subject_id = ?').all(subjectId);
  const chunks = searchCourseChunks(db, { q: '', subjectId, limit: 10 });

  const target = Math.min(Math.max(Number(count || 5), 1), 15);
  const created = [];
  const insertStmt = db.prepare(`
    INSERT INTO flashcards (
      id, subject_id, lesson_id, topic_tag, front, back, hint, formula,
      ease_factor, interval_days, repetitions, mastery_level
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, 'new')
  `);

  for (let i = 0; i < target; i++) {
    const les = lessons[i % Math.max(lessons.length, 1)];
    const chk = chunks[i % Math.max(chunks.length, 1)];
    const concepts = les ? safeJsonParse(les.key_concepts_json, []) : [];
    const formulas = les ? safeJsonParse(les.formulas_json, []) : [];
    const rawConcept = concepts[i % Math.max(concepts.length, 1)];
    const topicTag = String(
      typeof rawConcept === 'object' && rawConcept !== null
        ? rawConcept.name || rawConcept.title || JSON.stringify(rawConcept)
        : rawConcept || chk?.heading || subject.title
    );

    const id = `fc_${crypto.randomUUID().slice(0, 12)}`;
    const front = `In ${subject.code}, explain the core concept and invariant of "${topicTag}".`;
    const back = chk?.content?.slice(0, 260) || les?.summary || `${topicTag} is a foundational concept in ${subject.title}.`;
    const hint = `Focus on ${les?.title || subject.title} boundary conditions.`;
    const rawFormula = formulas[0];
    const formula = rawFormula
      ? typeof rawFormula === 'object'
        ? String(rawFormula.expression || rawFormula.formula || rawFormula.name || JSON.stringify(rawFormula))
        : String(rawFormula)
      : '';

    insertStmt.run(
      id,
      subjectId,
      les?.id || lessonId || null,
      topicTag,
      front,
      back,
      hint,
      formula
    );
    created.push(formatFlashcard(db.prepare('SELECT * FROM flashcards WHERE id = ?').get(id)));
  }

  return created;
}

export function reviewFlashcard(db, cardId, qualityRaw) {
  const card = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId);
  if (!card) {
    const err = new Error(`Flashcard not found: ${cardId}`);
    err.statusCode = 404;
    err.code = 'FLASHCARD_NOT_FOUND';
    throw err;
  }

  const quality = Math.min(Math.max(Number(qualityRaw ?? 2), 0), 3);
  // Map 0..3 -> SM-2 0..5 scale (0->1, 1->3, 2->4, 3->5)
  const sm2Quality = [1, 3, 4, 5][quality];

  let ease = Number(card.ease_factor || 2.5);
  let reps = Number(card.repetitions || 0);
  let interval = Number(card.interval_days || 0);

  if (sm2Quality < 3) {
    reps = 0;
    interval = 1;
  } else {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 6;
    else interval = Math.round(interval * ease);
    reps += 1;
  }

  ease = ease + (0.1 - (5 - sm2Quality) * (0.08 + (5 - sm2Quality) * 0.02));
  if (ease < 1.3) ease = 1.3;
  ease = Number(ease.toFixed(2));

  let masteryLevel = 'learning';
  if (reps === 0) masteryLevel = 'new';
  else if (reps >= 3 && interval >= 6) masteryLevel = 'mastered';
  else if (reps >= 1) masteryLevel = 'reviewing';

  db.prepare(`
    UPDATE flashcards
    SET ease_factor = ?, interval_days = ?, repetitions = ?, mastery_level = ?,
        last_reviewed_at = datetime('now'),
        next_review_at = datetime('now', '+' || ? || ' days')
    WHERE id = ?
  `).run(ease, interval, reps, masteryLevel, interval, cardId);

  return formatFlashcard(db.prepare('SELECT * FROM flashcards WHERE id = ?').get(cardId));
}

export function listExams(db, { subjectId = '', mode = '' } = {}) {
  let sql = 'SELECT * FROM exams_and_quizzes WHERE 1=1';
  const params = [];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (mode) {
    sql += ' AND mode = ?';
    params.push(mode);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatExam);
}

export function getExam(db, examId) {
  const row = db.prepare('SELECT * FROM exams_and_quizzes WHERE id = ?').get(examId);
  if (!row) {
    const err = new Error(`Exam not found: ${examId}`);
    err.statusCode = 404;
    err.code = 'EXAM_NOT_FOUND';
    throw err;
  }
  return formatExam(row);
}

export function generateExam(db, payload) {
  const {
    subjectId,
    lessonId = null,
    mode = 'practice_quiz',
    difficulty = 'intermediate',
    questionCount = 5,
    timeLimitSec = null
  } = payload;

  if (!subjectId) {
    const err = new Error('subjectId is required.');
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

  const lessons = lessonId
    ? db.prepare('SELECT * FROM lessons WHERE id = ?').all(lessonId)
    : db.prepare('SELECT * FROM lessons WHERE subject_id = ?').all(subjectId);
  const chunks = searchCourseChunks(db, { q: '', subjectId, limit: 12 });

  const count = Math.min(Math.max(Number(questionCount || 5), 3), 20);
  const pointsPerQ = Math.round(100 / count);
  const questions = [];

  for (let i = 0; i < count; i++) {
    const les = lessons[i % Math.max(lessons.length, 1)];
    const chk = chunks[i % Math.max(chunks.length, 1)];
    const concepts = les ? safeJsonParse(les.key_concepts_json, []) : [];
    const topic = concepts[i % Math.max(concepts.length, 1)] || chk?.heading || subject.title;
    const qId = `q_${i + 1}`;
    const excerpt = (chk?.content || les?.summary || subject.syllabus_summary).slice(0, 110).replace(/\s+/g, ' ').trim();

    questions.push({
      id: qId,
      topic,
      type: 'multiple_choice',
      points: pointsPerQ,
      prompt: `(${subject.code} · ${difficulty}) Regarding "${topic}", which statement is most accurate?`,
      options: [
        `${excerpt}...`,
        `It is independent of ${subject.title} boundary conditions`,
        'It always operates in O(1) constant space and time regardless of input',
        'None of the theoretical constraints apply in practice'
      ],
      correctIndex: 0,
      correctAnswer: `${excerpt}...`,
      explanation: `Per ${les?.title || subject.title}: ${excerpt}`
    });
  }

  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
  const resolvedTimeLimit = timeLimitSec || (mode === 'timed_mock_exam' ? 1800 : 900);
  const examId = `exam_${crypto.randomUUID().slice(0, 12)}`;
  const title =
    payload.title ||
    `${subject.code} ${mode === 'timed_mock_exam' ? 'Timed Mock Exam' : 'Practice Quiz'} (${difficulty})`;

  db.prepare(`
    INSERT INTO exams_and_quizzes (
      id, subject_id, lesson_id, mode, title, difficulty, time_limit_sec, questions_json, total_points
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    examId,
    subjectId,
    lessonId || null,
    mode,
    title,
    difficulty,
    resolvedTimeLimit,
    JSON.stringify(questions),
    totalPoints
  );

  return getExam(db, examId);
}

function computeLetterGrade(pct) {
  if (pct >= 93) return 'A';
  if (pct >= 90) return 'A-';
  if (pct >= 87) return 'B+';
  if (pct >= 83) return 'B';
  if (pct >= 80) return 'B-';
  if (pct >= 75) return 'C+';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

export function submitExam(db, userId, examId, payload) {
  const exam = getExam(db, examId);
  const answers = payload.answers || {};
  const durationUsedSec = Number(payload.durationUsedSec || 120);

  let scorePoints = 0;
  const gradedResults = [];
  const topicStats = {};

  for (const q of exam.questions) {
    const userAnswer = answers[q.id];
    const isCorrect =
      userAnswer === q.correctIndex ||
      String(userAnswer) === String(q.correctIndex) ||
      (typeof userAnswer === 'string' && userAnswer.trim() === String(q.correctAnswer).trim());

    if (isCorrect) scorePoints += q.points;

    if (!topicStats[q.topic]) {
      topicStats[q.topic] = { total: 0, correct: 0, accuracy: 0 };
    }
    topicStats[q.topic].total += 1;
    if (isCorrect) topicStats[q.topic].correct += 1;

    gradedResults.push({
      questionId: q.id,
      topic: q.topic,
      userAnswer: userAnswer ?? null,
      correctIndex: q.correctIndex,
      isCorrect,
      pointsEarned: isCorrect ? q.points : 0,
      maxPoints: q.points,
      explanation: q.explanation
    });
  }

  const weakTopics = [];
  for (const [topic, stat] of Object.entries(topicStats)) {
    stat.accuracy = Math.round((stat.correct / Math.max(stat.total, 1)) * 100);
    if (stat.accuracy < 75) {
      weakTopics.push(topic);
    }
  }

  const percentage = exam.totalPoints > 0 ? Math.round((scorePoints / exam.totalPoints) * 100) : 0;
  const letterGrade = computeLetterGrade(percentage);

  const lessons = db.prepare('SELECT id, title FROM lessons WHERE subject_id = ?').all(exam.subjectId);
  const decks = db.prepare('SELECT id, title FROM slide_decks WHERE subject_id = ?').all(exam.subjectId);
  const videos = db.prepare('SELECT id, title FROM ai_videos WHERE subject_id = ?').all(exam.subjectId);

  const weaknessRecommendations = weakTopics.map((topic, idx) => ({
    topic,
    accuracy: topicStats[topic].accuracy,
    recommendedAction: `Review "${topic}" concepts and complete 5 SM-2 flashcards.`,
    lessonId: lessons[idx % Math.max(lessons.length, 1)]?.id || null,
    lessonTitle: lessons[idx % Math.max(lessons.length, 1)]?.title || null,
    slideDeckId: decks[0]?.id || null,
    videoId: videos[0]?.id || null
  }));

  const attemptId = `att_${crypto.randomUUID().slice(0, 12)}`;
  const topicBreakdownArray = Object.entries(topicStats).map(([topic, stat]) => ({
    topic,
    total: stat.total,
    correct: stat.correct,
    accuracy: stat.accuracy
  }));

  db.prepare(`
    INSERT INTO exam_attempts (
      id, exam_id, user_id, subject_id, mode, duration_used_sec,
      score_points, total_points, percentage, letter_grade,
      answers_json, topic_breakdown_json, weakness_recommendations_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId,
    examId,
    userId,
    exam.subjectId,
    exam.mode,
    durationUsedSec,
    scorePoints,
    exam.totalPoints,
    percentage,
    letterGrade,
    JSON.stringify(answers),
    JSON.stringify(topicBreakdownArray),
    JSON.stringify(weaknessRecommendations)
  );

  const savedAttempt = formatAttempt(db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(attemptId));
  return { ...savedAttempt, gradedResults };
}

export function listAttempts(db, userId, { subjectId = '' } = {}) {
  let sql = 'SELECT * FROM exam_attempts WHERE user_id = ?';
  const params = [userId];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  sql += ' ORDER BY submitted_at DESC';
  return db.prepare(sql).all(...params).map(formatAttempt);
}

export function generateStudyGuide(db, userId, payload) {
  const { subjectId, focusWeakTopics = true } = payload;
  if (!subjectId) {
    const err = new Error('subjectId is required.');
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

  const attempts = listAttempts(db, userId, { subjectId });
  const weakTopicsSet = new Set();
  if (focusWeakTopics) {
    for (const att of attempts) {
      for (const rec of att.weaknessRecommendations || []) {
        weakTopicsSet.add(rec.topic);
      }
    }
  }

  const lessons = db.prepare('SELECT * FROM lessons WHERE subject_id = ? ORDER BY module_number ASC').all(subjectId);
  const formulasSheet = [];
  if (weakTopicsSet.size === 0) {
    for (const l of lessons) {
      for (const c of safeJsonParse(l.key_concepts_json, [])) {
        weakTopicsSet.add(typeof c === 'object' ? (c.name || JSON.stringify(c)) : String(c));
      }
      for (const f of safeJsonParse(l.formulas_json, [])) {
        formulasSheet.push(f);
      }
    }
  }

  const weakTopics = [...weakTopicsSet].slice(0, 6);
  const guideId = `sg_${crypto.randomUUID().slice(0, 12)}`;
  const title = `${subject.code} High-Yield Exam Study Guide`;
  const overview = `High-yield exam preparation guide for ${subject.code}: ${subject.title} (${subject.instructor}).`;
  const commonExamTraps = [
    'Skipping boundary case verification in proofs and derivations.',
    'Confusing average-case vs worst-case asymptotic bounds.'
  ];
  const workedProblems = lessons.slice(0, 2).map((l) => ({
    title: l.title,
    summary: l.summary
  }));

  db.prepare(`
    INSERT INTO study_guides (
      id, subject_id, title, overview, high_yield_concepts_json,
      formulas_sheet_json, common_exam_traps_json, worked_problems_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guideId,
    subjectId,
    title,
    overview,
    JSON.stringify(weakTopics),
    JSON.stringify(formulasSheet),
    JSON.stringify(commonExamTraps),
    JSON.stringify(workedProblems)
  );

  return formatStudyGuide(db.prepare('SELECT * FROM study_guides WHERE id = ?').get(guideId));
}

export function listStudyGuides(db, userId, { subjectId = '' } = {}) {
  let sql = 'SELECT * FROM study_guides WHERE 1=1';
  const params = [];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatStudyGuide);
}

export function getExamPrepOverview(db, userId, { subjectId = '' } = {}) {
  const flashcards = listFlashcards(db, { subjectId });
  const dueCount = flashcards.filter((f) => f.nextReviewAt <= new Date().toISOString().slice(0, 19).replace('T', ' ')).length;
  const masteredCount = flashcards.filter((f) => f.masteryLevel === 'mastered').length;
  const recentAttempts = listAttempts(db, userId, { subjectId }).slice(0, 5);
  const studyGuides = listStudyGuides(db, userId, { subjectId });

  const weakTopics = [];
  for (const att of recentAttempts) {
    for (const rec of att.weaknessRecommendations || []) {
      if (!weakTopics.includes(rec.topic)) weakTopics.push(rec.topic);
    }
  }

  const avgScore =
    recentAttempts.length > 0
      ? recentAttempts.reduce((acc, a) => acc + a.percentage, 0) / recentAttempts.length
      : 65;
  const flashcardRatio = flashcards.length > 0 ? (masteredCount / flashcards.length) * 100 : 50;
  const readinessScore = Math.round(avgScore * 0.7 + flashcardRatio * 0.3);

  return {
    readinessScore,
    flashcardStats: {
      total: flashcards.length,
      due: dueCount,
      mastered: masteredCount
    },
    recentAttempts,
    weakTopics,
    studyGuides
  };
}
