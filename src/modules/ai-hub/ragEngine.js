import { searchCourseChunks } from '../catalog/ingestionService.js';
import { decryptApiKey } from './providerRegistry.js';

export function retrieveContext(db, {
  query = '',
  subjectId = '',
  lessonId = '',
  attachedFileIds = [],
  userId = '',
  includeCourseContext = true
} = {}) {
  let courseChunks = [];
  if (includeCourseContext) {
    courseChunks = searchCourseChunks(db, {
      q: query,
      subjectId: subjectId || '',
      limit: 6
    });
    if (courseChunks.length === 0 && subjectId) {
      courseChunks = searchCourseChunks(db, {
        q: '',
        subjectId,
        limit: 4
      });
    }
  }

  const attachedFiles = [];
  if (Array.isArray(attachedFileIds) && attachedFileIds.length > 0) {
    const stmt = db.prepare('SELECT * FROM ai_chat_files WHERE id = ? AND user_id = ?');
    for (const fid of attachedFileIds) {
      const row = stmt.get(fid, userId);
      if (row) {
        attachedFiles.push({
          id: row.id,
          filename: row.filename,
          mimeType: row.mime_type,
          extractedText: row.extracted_text,
          summary: row.summary
        });
      }
    }
  }

  let lesson = null;
  if (lessonId) {
    lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
  }
  let subject = null;
  if (subjectId) {
    subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  }

  const citations = [
    ...courseChunks.map((c) => ({
      type: 'course_chunk',
      id: c.chunkId,
      title: c.sourceTitle,
      heading: c.heading,
      snippet: c.snippet
    })),
    ...attachedFiles.map((f) => ({
      type: 'chat_file',
      id: f.id,
      title: f.filename,
      heading: 'Student Uploaded File',
      snippet: f.extractedText.slice(0, 180)
    }))
  ];

  return {
    courseChunks,
    attachedFiles,
    lesson,
    subject,
    citations
  };
}

export async function generateAssistantReply({
  prompt,
  provider,
  context
}) {
  const providerType = provider?.provider_type || provider?.providerType || 'built_in';
  const modelName = provider?.model_name || provider?.modelName || 'hsu-tutor-v1';
  const executionMode = provider?.execution_mode || provider?.executionMode || 'local_rag';
  const baseUrl = provider?.base_url || provider?.baseUrl || '';

  // Attempt live HTTP call if explicitly configured to a reachable HTTP endpoint
  if (
    providerType !== 'built_in' &&
    executionMode === 'live' &&
    baseUrl &&
    baseUrl.startsWith('http://127.0.0.1')
  ) {
    try {
      const apiKey = decryptApiKey(provider.api_key_encrypted || '');
      const contextSummary = [
        ...context.courseChunks.map((c) => `[${c.sourceTitle} - ${c.heading}]: ${c.content}`),
        ...context.attachedFiles.map((f) => `[Uploaded File ${f.filename}]: ${f.extractedText}`)
      ].join('\n\n');

      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: 'system',
              content: `You are UniLearn AI (${providerType}) for Horizon State University.\nContext:\n${contextSummary}`
            },
            { role: 'user', content: prompt }
          ]
        }),
        signal: AbortSignal.timeout(4000)
      });

      if (resp.ok) {
        const data = await resp.json();
        const liveContent =
          data?.choices?.[0]?.message?.content ||
          data?.content?.[0]?.text ||
          data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (liveContent) {
          return {
            content: liveContent,
            executionMode: 'live',
            providerType,
            modelName
          };
        }
      }
    } catch {
      // Fallback to grounded RAG synthesis
    }
  }

  // Course-grounded RAG synthesis
  const parts = [];
  const headerSubject = context.subject ? `${context.subject.code}: ${context.subject.title}` : 'Horizon State University Study Hub';
  parts.push(`### ${headerSubject} (${providerType.toUpperCase()} · ${modelName})`);
  parts.push('');

  if (context.attachedFiles.length > 0) {
    parts.push('**Grounded in Your Uploaded File(s):**');
    for (const f of context.attachedFiles) {
      const excerpt = f.extractedText.slice(0, 420).replace(/\s+/g, ' ').trim();
      parts.push(`- **${f.filename}**: ${excerpt}`);
    }
    parts.push('');
  }

  if (context.courseChunks.length > 0) {
    parts.push('**Key University Lesson & Course References:**');
    for (const c of context.courseChunks.slice(0, 4)) {
      const excerpt = c.content.slice(0, 320).replace(/\s+/g, ' ').trim();
      parts.push(`- **${c.sourceTitle}** (*${c.heading}*): ${excerpt}`);
    }
    parts.push('');
  }

  if (context.lesson) {
    parts.push(`**Lesson Focus — ${context.lesson.title}:**`);
    parts.push(context.lesson.summary || context.lesson.content_markdown.slice(0, 300));
    parts.push('');
  }

  parts.push(`**Direct Answer to Your Question ("${prompt.slice(0, 120)}"):**`);
  if (context.attachedFiles.length === 0 && context.courseChunks.length === 0) {
    parts.push(
      'I am ready to help you master this topic! Upload your lecture notes or select a subject from the Horizon State University catalog so I can ground every explanation, formula derivation, and exam tip in your exact syllabus.'
    );
  } else {
    parts.push(
      `Based on the retrieved HSU course materials${context.attachedFiles.length > 0 ? ' and your attached file(s)' : ''}, focus on the core definitions, step-by-step derivations, and boundary conditions highlighted above. You can also generate an interactive slide deck or practice quiz directly from this topic to test your exam readiness.`
    );
  }

  return {
    content: parts.join('\n'),
    executionMode: 'course_grounded_rag',
    providerType,
    modelName
  };
}
