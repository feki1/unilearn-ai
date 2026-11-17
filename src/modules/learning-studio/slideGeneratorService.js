import crypto from 'node:crypto';
import { searchCourseChunks } from '../catalog/ingestionService.js';

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatSlideDeck(r) {
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    lessonId: r.lesson_id,
    fileId: r.file_id,
    createdBy: r.created_by,
    title: r.title,
    subtitle: r.subtitle,
    theme: r.theme,
    providerType: r.provider_type,
    slideCount: Number(r.slide_count || 0),
    slides: safeJsonParse(r.slides_json, []),
    sourceSummary: r.source_summary,
    createdAt: r.created_at
  };
}

function buildDiagramSvg(title, nodes = []) {
  const safeTitle = String(title || 'Concept Architecture').replace(/[<>&"]/g, '');
  const labels = nodes.length >= 3 ? nodes.slice(0, 4) : ['Input / Problem', 'Core Mechanism', 'Analysis & Proof', 'Exam Application'];
  const boxColors = ['#4f46e5', '#0284c7', '#059669', '#7c3aed'];
  const boxes = labels
    .map((lbl, idx) => {
      const x = 30 + idx * 185;
      const safeLbl = String(lbl).slice(0, 22).replace(/[<>&"]/g, '');
      const arrow =
        idx < labels.length - 1
          ? `<line x1="${x + 150}" y1="110" x2="${x + 185}" y2="110" stroke="#94a3b8" stroke-width="3" marker-end="url(#arrow)" />`
          : '';
      return `
        <rect x="${x}" y="70" width="150" height="80" rx="12" fill="${boxColors[idx % boxColors.length]}" opacity="0.92" />
        <text x="${x + 75}" y="114" fill="#ffffff" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle">${safeLbl}</text>
        ${arrow}
      `;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 780 220" width="100%" height="220">
    <defs>
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
        <path d="M0,0 L0,6 L9,3 z" fill="#94a3b8" />
      </marker>
    </defs>
    <rect width="780" height="220" rx="16" fill="#0f172a" />
    <text x="390" y="36" fill="#e2e8f0" font-family="sans-serif" font-size="15" font-weight="700" text-anchor="middle">${safeTitle}</text>
    ${boxes}
  </svg>`;
}

export function listSlideDecks(db, { subjectId = '', lessonId = '' } = {}) {
  let sql = 'SELECT * FROM slide_decks WHERE 1=1';
  const params = [];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (lessonId) {
    sql += ' AND lesson_id = ?';
    params.push(lessonId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatSlideDeck);
}

export function getSlideDeck(db, deckId) {
  const row = db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(deckId);
  if (!row) {
    const err = new Error(`Slide deck not found: ${deckId}`);
    err.statusCode = 404;
    err.code = 'DECK_NOT_FOUND';
    throw err;
  }
  return formatSlideDeck(row);
}

export function generateSlideDeck(db, userId, payload) {
  const {
    subjectId,
    lessonId = null,
    fileId = null,
    customTopic = '',
    slideCount = 7,
    theme = 'university-indigo',
    providerType = 'built_in'
  } = payload;

  if (!subjectId) {
    const err = new Error('subjectId is required to generate a slide deck.');
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

  const lesson = lessonId ? db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId) : null;
  const file = fileId ? db.prepare('SELECT * FROM course_files WHERE id = ?').get(fileId) : null;

  const topicTitle = customTopic || lesson?.title || file?.filename || subject.title;
  const keyConcepts = lesson ? safeJsonParse(lesson.key_concepts_json, []) : [];
  const formulas = lesson ? safeJsonParse(lesson.formulas_json, []) : [];

  const chunks = searchCourseChunks(db, {
    q: customTopic || lesson?.title || subject.title,
    subjectId,
    limit: 6
  });

  const targetCount = Math.min(Math.max(Number(slideCount || 7), 6), 10);
  const conceptList = keyConcepts.length > 0
    ? keyConcepts
    : chunks.map((c) => c.heading).filter(Boolean);
  const primaryFormula = formulas[0] || `${subject.code} Core Relation: f(x) -> Optimal State`;

  const slides = [
    {
      index: 1,
      layout: 'title_overview',
      title: topicTitle,
      subtitle: `${subject.code} · ${subject.title} (${subject.instructor})`,
      bullets: [
        `Course Scope: ${subject.syllabus_summary.slice(0, 140)}`,
        `Estimated Study Time: ${lesson?.estimated_minutes || 30} minutes`,
        `Key Focus Areas: ${(conceptList.slice(0, 3).join(', ') || 'Core Foundations & Exam Mastery')}`
      ],
      speakerNotes: `Welcome to ${topicTitle} in ${subject.code}. In this deck we break down the core theory, visual architecture, derivations, and exam checkpoints.`
    },
    {
      index: 2,
      layout: 'core_concept',
      title: `Core Concepts: ${conceptList[0] || topicTitle}`,
      subtitle: 'Foundational Principles & Definitions',
      bullets: [
        chunks[0]?.content?.slice(0, 160) || `${topicTitle} establishes the foundational model for ${subject.title}.`,
        chunks[1]?.content?.slice(0, 160) || 'Understand assumptions, invariants, and boundary conditions.',
        `Connects directly to ${conceptList[1] || 'downstream module problem solving'}.`
      ],
      speakerNotes: 'Focus on why each definition holds and what happens when boundary conditions change.'
    },
    {
      index: 3,
      layout: 'visual_diagram',
      title: `Visual Architecture: ${topicTitle}`,
      subtitle: 'Step-by-Step Conceptual Flow',
      bullets: [
        'Trace data and state transformations across each stage.',
        'Identify bottlenecks and invariants at each transition.'
      ],
      diagramSpec: {
        type: 'flowchart',
        nodes: conceptList.length >= 3 ? conceptList.slice(0, 4) : ['Problem Input', 'Core Model', 'Verification', 'Exam Output']
      },
      diagramSvg: buildDiagramSvg(topicTitle, conceptList),
      speakerNotes: 'Walk through the diagram left to right, explaining how each stage transforms the representation.'
    },
    {
      index: 4,
      layout: 'formula_derivation',
      title: 'Key Equations & Analytical Derivation',
      subtitle: 'Mathematical & Formal Structure',
      bullets: [
        `Primary Formula: ${primaryFormula}`,
        formulas[1] ? `Secondary Relation: ${formulas[1]}` : 'Verify units, dimensionality, and asymptotic behavior.',
        'Common Exam Pitfall: Double-check sign conventions and base cases.'
      ],
      formula: primaryFormula,
      speakerNotes: 'Students frequently lose points on sign errors or missing boundary terms; highlight those explicitly.'
    },
    {
      index: 5,
      layout: 'real_world_application',
      title: `Applied Case Study in ${subject.code}`,
      subtitle: 'Connecting Theory to University & Industry Problems',
      bullets: [
        file ? `Grounded in uploaded resource: ${file.filename}` : `Practical application in ${subject.title}`,
        chunks[2]?.content?.slice(0, 160) || 'Compare theoretical predictions against empirical measurements.',
        'Evaluate trade-offs in performance, accuracy, and resource cost.'
      ],
      speakerNotes: 'Connect the abstract model to concrete scenarios likely to appear in free-response exam questions.'
    },
    {
      index: 6,
      layout: 'checkpoint_quiz',
      title: 'Interactive Checkpoint Quiz',
      subtitle: 'Verify Your Understanding Before Moving On',
      bullets: [
        'Test your grasp of the core mechanism.',
        'Select the best answer to reveal the explanation.'
      ],
      quizQuestion: {
        prompt: `Which principle is most critical when analyzing ${topicTitle} in ${subject.code}?`,
        options: [
          `Verifying invariants and boundary conditions for ${conceptList[0] || topicTitle}`,
          'Ignoring asymptotic or conservation constraints',
          'Assuming linear behavior for all non-linear regimes',
          'Skipping formal verification steps'
        ],
        correctIndex: 0,
        explanation: `In ${subject.code}, ${conceptList[0] || topicTitle} relies on verifying invariants and boundary conditions before applying shortcuts.`
      },
      speakerNotes: 'Pause here and have the student answer the checkpoint question.'
    }
  ];

  while (slides.length < targetCount - 1) {
    const idx = slides.length + 1;
    const chunk = chunks[idx % Math.max(chunks.length, 1)];
    slides.push({
      index: idx,
      layout: 'core_concept',
      title: chunk?.heading || `Deep Dive Module ${idx}: ${topicTitle}`,
      subtitle: `${subject.code} Extended Analysis`,
      bullets: [
        chunk?.content?.slice(0, 170) || `Detailed breakdown of ${topicTitle} sub-topic ${idx}.`,
        'Compare edge cases and contrast with alternative approaches.',
        'Review worked example steps for exam speed.'
      ],
      speakerNotes: `Extended analysis slide ${idx} synthesized from ${subject.code} materials.`
    });
  }

  slides.push({
    index: slides.length + 1,
    layout: 'exam_takeaways',
    title: 'High-Yield Exam Takeaways',
    subtitle: `${subject.code} Revision Checklist`,
    bullets: [
      `Master the core definition & formula: ${primaryFormula}`,
      `Be ready to sketch and explain the ${topicTitle} pipeline.`,
      'Practice timed problems and review SM-2 flashcards for weak areas.'
    ],
    speakerNotes: 'Summarize the top 3 exam takeaways and encourage the student to launch a practice quiz.'
  });

  const deckId = `deck_${crypto.randomUUID().slice(0, 12)}`;
  const sourceSummary = lesson?.summary || file?.summary || subject.syllabus_summary;

  db.prepare(`
    INSERT INTO slide_decks (
      id, subject_id, lesson_id, file_id, created_by, title, subtitle,
      theme, provider_type, slide_count, slides_json, source_summary
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deckId,
    subjectId,
    lessonId || null,
    fileId || null,
    userId || 'student',
    `${topicTitle} — Interactive Deck`,
    `${subject.code} · ${subject.title}`,
    theme,
    providerType,
    slides.length,
    JSON.stringify(slides),
    sourceSummary
  );

  return getSlideDeck(db, deckId);
}

export function updateSlideDeck(db, deckId, payload) {
  const existing = db.prepare('SELECT * FROM slide_decks WHERE id = ?').get(deckId);
  if (!existing) {
    const err = new Error(`Slide deck not found: ${deckId}`);
    err.statusCode = 404;
    err.code = 'DECK_NOT_FOUND';
    throw err;
  }

  const nextSlides = Array.isArray(payload.slides) ? payload.slides : safeJsonParse(existing.slides_json, []);
  db.prepare(`
    UPDATE slide_decks
    SET title = ?, subtitle = ?, theme = ?, slides_json = ?, slide_count = ?
    WHERE id = ?
  `).run(
    payload.title !== undefined ? String(payload.title) : existing.title,
    payload.subtitle !== undefined ? String(payload.subtitle) : existing.subtitle,
    payload.theme !== undefined ? String(payload.theme) : existing.theme,
    JSON.stringify(nextSlides),
    nextSlides.length,
    deckId
  );

  return getSlideDeck(db, deckId);
}

export function deleteSlideDeck(db, deckId) {
  const existing = db.prepare('SELECT id FROM slide_decks WHERE id = ?').get(deckId);
  if (!existing) {
    const err = new Error(`Slide deck not found: ${deckId}`);
    err.statusCode = 404;
    err.code = 'DECK_NOT_FOUND';
    throw err;
  }
  db.prepare('DELETE FROM slide_decks WHERE id = ?').run(deckId);
  return { deleted: true, deckId };
}
