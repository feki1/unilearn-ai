import crypto from 'node:crypto';
import { searchCourseChunks } from '../catalog/ingestionService.js';

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatResearchProject(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    majorId: r.major_id,
    subjectId: r.subject_id,
    title: r.title,
    query: r.query,
    status: r.status,
    executiveSummary: r.executive_summary,
    sections: safeJsonParse(r.sections_json, []),
    collectedDataTable: safeJsonParse(r.collected_data_table_json, {
      title: 'Collected Academic Data',
      columns: [],
      rows: [],
      unitNotes: ''
    }),
    citations: safeJsonParse(r.citations_json, []),
    studentNotes: r.student_notes || '',
    providerType: r.provider_type,
    createdAt: r.created_at
  };
}

export function listResearchProjects(db, userId, { subjectId = '', majorId = '' } = {}) {
  let sql = 'SELECT * FROM research_projects WHERE user_id = ?';
  const params = [userId];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  if (majorId) {
    sql += ' AND major_id = ?';
    params.push(majorId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map(formatResearchProject);
}

export function getResearchProject(db, researchId) {
  const row = db.prepare('SELECT * FROM research_projects WHERE id = ?').get(researchId);
  if (!row) {
    const err = new Error(`Research project not found: ${researchId}`);
    err.statusCode = 404;
    err.code = 'RESEARCH_NOT_FOUND';
    throw err;
  }
  return formatResearchProject(row);
}

export function runResearch(db, userId, payload) {
  const query = String(payload.query || payload.topic || '').trim();
  if (!query) {
    const err = new Error('Research query is required.');
    err.statusCode = 400;
    err.code = 'RESEARCH_QUERY_REQUIRED';
    throw err;
  }

  const subjectId = payload.subjectId || null;
  const majorId = payload.majorId || null;
  const providerType = String(payload.providerType || 'built_in').toLowerCase();
  const title = String(payload.title || `Deep Research: ${query}`).trim();

  let chunks = searchCourseChunks(db, {
    q: query,
    subjectId: subjectId || '',
    majorId: majorId || '',
    limit: 8
  });

  if (chunks.length === 0) {
    chunks = searchCourseChunks(db, { q: '', subjectId: subjectId || '', majorId: majorId || '', limit: 5 });
  }

  let uploadedFiles = [];
  if (payload.includeUploadedFiles !== false) {
    uploadedFiles = db
      .prepare('SELECT id, filename, summary, extracted_text FROM ai_chat_files WHERE user_id = ? ORDER BY created_at DESC LIMIT 4')
      .all(userId);
  }

  const citations = [
    ...chunks.map((c, idx) => ({
      ref: `[${idx + 1}]`,
      type: c.sourceType,
      sourceTitle: c.sourceTitle,
      heading: c.heading,
      relevanceScore: c.score,
      snippet: c.snippet
    })),
    ...uploadedFiles.map((f, idx) => ({
      ref: `[U${idx + 1}]`,
      type: 'student_upload',
      sourceTitle: f.filename,
      heading: 'Student Uploaded Material',
      relevanceScore: 0.9,
      snippet: f.summary
    }))
  ];

  const executiveSummary =
    chunks.length > 0
      ? `Academic synthesis for "${query}" across ${chunks.length} indexed university sources${uploadedFiles.length ? ` and ${uploadedFiles.length} uploaded file(s)` : ''}. Primary findings highlight ${chunks[0].heading} (${chunks[0].sourceTitle}) and comparative quantitative metrics.`
      : `Academic synthesis for "${query}" compiled from Horizon State University knowledge base.`;

  const sections = [
    {
      heading: '1. Conceptual Foundation & Scope',
      summary: chunks[0]?.content?.slice(0, 320) || `Foundational overview of ${query} within university coursework.`,
      citations: citations.slice(0, 2).map((c) => c.ref)
    },
    {
      heading: '2. Analytical Mechanisms & Quantitative Comparison',
      summary: chunks[1]?.content?.slice(0, 320) || `Comparative breakdown of key models, complexity bounds, and empirical parameters for ${query}.`,
      citations: citations.slice(1, 4).map((c) => c.ref)
    },
    {
      heading: '3. Exam & Practical Engineering Takeaways',
      summary: chunks[2]?.content?.slice(0, 320) || `Critical edge cases, invariants, and problem-solving patterns for ${query}.`,
      citations: citations.slice(2, 5).map((c) => c.ref)
    }
  ];

  const tableRows = chunks.slice(0, 5).map((c, idx) => ({
    Metric_or_Topic: c.heading || `Module ${idx + 1}`,
    Source: c.sourceTitle,
    Category: c.sourceType,
    Relevance_Score: Number((c.score || 0.85).toFixed(2)),
    Key_Finding: c.content.slice(0, 120).replace(/\s+/g, ' ').trim()
  }));

  if (tableRows.length === 0) {
    tableRows.push({
      Metric_or_Topic: query,
      Source: 'HSU Knowledge Base',
      Category: 'synthesis',
      Relevance_Score: 0.95,
      Key_Finding: `Baseline academic profile for ${query}`
    });
  }

  const collectedDataTable = {
    title: `Collected Data Table: ${query}`,
    columns: ['Metric_or_Topic', 'Source', 'Category', 'Relevance_Score', 'Key_Finding'],
    rows: tableRows,
    unitNotes: 'Relevance_Score is normalized [0.00 - 1.00] from FTS5 BM25 ranking.'
  };

  const id = `res_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO research_projects (
      id, user_id, major_id, subject_id, title, query, status,
      executive_summary, sections_json, collected_data_table_json,
      citations_json, student_notes, provider_type
    )
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, '', ?)
  `).run(
    id,
    userId,
    majorId,
    subjectId,
    title,
    query,
    executiveSummary,
    JSON.stringify(sections),
    JSON.stringify(collectedDataTable),
    JSON.stringify(citations),
    providerType
  );

  return getResearchProject(db, id);
}

export function updateResearchNotes(db, researchId, payload) {
  const existing = getResearchProject(db, researchId);
  const nextNotes = payload.studentNotes !== undefined ? String(payload.studentNotes) : existing.studentNotes;
  const table = existing.collectedDataTable || { title: 'Collected Data', columns: [], rows: [], unitNotes: '' };

  if (Array.isArray(payload.additionalRows) && payload.additionalRows.length > 0) {
    table.rows = [...(table.rows || []), ...payload.additionalRows];
  }

  db.prepare(`
    UPDATE research_projects
    SET student_notes = ?, collected_data_table_json = ?
    WHERE id = ?
  `).run(nextNotes, JSON.stringify(table), researchId);

  return getResearchProject(db, researchId);
}

export function exportResearch(db, researchId, format = 'json') {
  const project = getResearchProject(db, researchId);
  const fmt = String(format || 'json').toLowerCase();
  const baseCols = project.collectedDataTable.columns || [];
  const rows = project.collectedDataTable.rows || [];
  const colSet = new Set(baseCols);
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) colSet.add(k);
    }
  }
  const cols = [...colSet];

  if (fmt === 'csv') {
    const esc = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const lines = [
      cols.map(esc).join(','),
      ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))
    ];
    return {
      contentType: 'text/csv; charset=utf-8',
      filename: `${researchId}.csv`,
      body: lines.join('\n')
    };
  }

  if (fmt === 'md' || fmt === 'markdown') {
    const header = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const bodyRows = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '').replace(/\|/g, '/')).join(' | ')} |`);
    const md = [
      `# ${project.title}`,
      '',
      `> ${project.executiveSummary}`,
      '',
      ...project.sections.map((s) => `## ${s.heading}\n${s.summary}\n`),
      '## Collected Data Table',
      header,
      sep,
      ...bodyRows,
      '',
      project.studentNotes ? `## Student Notes\n${project.studentNotes}` : ''
    ].join('\n');

    return {
      contentType: 'text/markdown; charset=utf-8',
      filename: `${researchId}.md`,
      body: md
    };
  }

  return {
    contentType: 'application/json; charset=utf-8',
    filename: `${researchId}.json`,
    body: JSON.stringify(project, null, 2)
  };
}
