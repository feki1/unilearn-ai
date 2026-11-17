import crypto from 'node:crypto';
import { extractTextFromInput } from '../catalog/ingestionService.js';
import { ensureBuiltInProvider, PROVIDER_DEFAULTS } from './providerRegistry.js';
import { generateAssistantReply, retrieveContext } from './ragEngine.js';

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatConversation(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    majorId: r.major_id,
    subjectId: r.subject_id,
    lessonId: r.lesson_id,
    providerConfigId: r.provider_config_id,
    providerType: r.provider_type,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export function formatChatFile(r) {
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userId: r.user_id,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes || 0),
    extractedText: r.extracted_text,
    summary: r.summary,
    createdAt: r.created_at
  };
}

export function formatMessage(r) {
  if (!r) return null;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    providerType: r.provider_type,
    modelName: r.model_name,
    executionMode: r.execution_mode,
    attachedFilesUsed: safeJsonParse(r.attached_file_ids_json, []),
    citations: safeJsonParse(r.citations_json, []),
    createdAt: r.created_at
  };
}

export function listConversations(db, userId, { subjectId = '' } = {}) {
  let sql = 'SELECT * FROM ai_conversations WHERE user_id = ?';
  const params = [userId];
  if (subjectId) {
    sql += ' AND subject_id = ?';
    params.push(subjectId);
  }
  sql += ' ORDER BY updated_at DESC, created_at DESC';
  return db.prepare(sql).all(...params).map(formatConversation);
}

export function createConversation(db, userId, payload) {
  ensureBuiltInProvider(db, userId);
  const id = `conv_${crypto.randomUUID().slice(0, 12)}`;
  const providerType = String(payload.providerType || 'built_in').toLowerCase();
  const providerConfigId = payload.providerConfigId || 'built_in';
  const title = String(payload.title || 'University AI Study Session').trim();

  db.prepare(`
    INSERT INTO ai_conversations (
      id, user_id, major_id, subject_id, lesson_id, provider_config_id, provider_type, title
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    payload.majorId || null,
    payload.subjectId || null,
    payload.lessonId || null,
    providerConfigId,
    providerType,
    title
  );

  return formatConversation(db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(id));
}

export function getConversationDetail(db, userId, conversationId) {
  const conv = db
    .prepare('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId);

  if (!conv) {
    const err = new Error(`Conversation not found: ${conversationId}`);
    err.statusCode = 404;
    err.code = 'CONVERSATION_NOT_FOUND';
    throw err;
  }

  const messages = db
    .prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId)
    .map(formatMessage);

  const files = db
    .prepare('SELECT * FROM ai_chat_files WHERE conversation_id = ? AND user_id = ? ORDER BY created_at DESC')
    .all(conversationId, userId)
    .map(formatChatFile);

  return {
    conversation: formatConversation(conv),
    messages,
    files
  };
}

export function uploadChatFile(db, userId, conversationId, payload) {
  if (conversationId) {
    const conv = db
      .prepare('SELECT id FROM ai_conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, userId);
    if (!conv) {
      const err = new Error(`Conversation not found: ${conversationId}`);
      err.statusCode = 404;
      err.code = 'CONVERSATION_NOT_FOUND';
      throw err;
    }
  }

  const filename = String(payload.filename || 'student-note.txt').trim();
  const extracted = extractTextFromInput({
    buffer: payload.buffer || null,
    contentText: payload.contentText || '',
    contentBase64: payload.contentBase64 || '',
    filename,
    mimeType: payload.mimeType || ''
  });

  if (!extracted.text) {
    const err = new Error('Uploaded chat file has no extractable text.');
    err.statusCode = 400;
    err.code = 'EMPTY_CHAT_FILE';
    throw err;
  }

  const id = `cfile_${crypto.randomUUID().slice(0, 12)}`;
  const sizeBytes = extracted.buffer.length || Buffer.byteLength(extracted.text, 'utf8');
  const summary = extracted.text.slice(0, 200).replace(/\s+/g, ' ').trim();

  db.prepare(`
    INSERT INTO ai_chat_files (
      id, conversation_id, user_id, filename, mime_type, size_bytes, extracted_text, summary
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    conversationId || null,
    userId,
    filename,
    extracted.mimeType,
    sizeBytes,
    extracted.text,
    summary
  );

  return formatChatFile(db.prepare('SELECT * FROM ai_chat_files WHERE id = ?').get(id));
}

export async function sendChatMessage(db, userId, conversationId, payload) {
  const conv = db
    .prepare('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId);

  if (!conv) {
    const err = new Error(`Conversation not found: ${conversationId}`);
    err.statusCode = 404;
    err.code = 'CONVERSATION_NOT_FOUND';
    throw err;
  }

  const content = String(payload.content || '').trim();
  if (!content) {
    const err = new Error('Message content cannot be empty.');
    err.statusCode = 400;
    err.code = 'EMPTY_MESSAGE';
    throw err;
  }

  ensureBuiltInProvider(db, userId);
  let providerRow = null;
  if (payload.providerConfigId) {
    providerRow = db
      .prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?')
      .get(payload.providerConfigId, userId);
  } else if (payload.providerType) {
    providerRow = db
      .prepare('SELECT * FROM ai_provider_configs WHERE provider_type = ? AND user_id = ? ORDER BY is_default DESC LIMIT 1')
      .get(String(payload.providerType).toLowerCase(), userId);
  } else if (conv.provider_config_id && conv.provider_config_id !== 'built_in') {
    providerRow = db
      .prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?')
      .get(conv.provider_config_id, userId);
  }

  if (!providerRow) {
    const requestedType = String(payload.providerType || conv.provider_type || 'built_in').toLowerCase();
    const defaults = PROVIDER_DEFAULTS[requestedType] || PROVIDER_DEFAULTS.built_in;
    providerRow = {
      provider_type: requestedType,
      model_name: defaults.modelName,
      execution_mode: 'local_rag',
      base_url: defaults.baseUrl,
      api_key_encrypted: ''
    };
  }

  // Include explicit attachedFileIds OR all files uploaded to this conversation if omitted
  let attachedFileIds = Array.isArray(payload.attachedFileIds) ? payload.attachedFileIds : [];
  if (attachedFileIds.length === 0) {
    attachedFileIds = db
      .prepare('SELECT id FROM ai_chat_files WHERE conversation_id = ? AND user_id = ?')
      .all(conversationId, userId)
      .map((r) => r.id);
  }

  const context = retrieveContext(db, {
    query: content,
    subjectId: payload.subjectId || conv.subject_id || '',
    lessonId: payload.lessonId || conv.lesson_id || '',
    attachedFileIds,
    userId,
    includeCourseContext: payload.includeCourseContext !== false
  });

  const userMsgId = `msg_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO ai_messages (
      id, conversation_id, role, content, provider_type, model_name, execution_mode, attached_file_ids_json, citations_json
    )
    VALUES (?, ?, 'user', ?, ?, ?, 'user_input', ?, '[]')
  `).run(
    userMsgId,
    conversationId,
    content,
    providerRow.provider_type,
    providerRow.model_name,
    JSON.stringify(attachedFileIds)
  );

  const reply = await generateAssistantReply({
    prompt: content,
    provider: providerRow,
    context
  });

  const assistantMsgId = `msg_${crypto.randomUUID().slice(0, 12)}`;
  db.prepare(`
    INSERT INTO ai_messages (
      id, conversation_id, role, content, provider_type, model_name, execution_mode, attached_file_ids_json, citations_json
    )
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
  `).run(
    assistantMsgId,
    conversationId,
    reply.content,
    reply.providerType,
    reply.modelName,
    reply.executionMode,
    JSON.stringify(attachedFileIds),
    JSON.stringify(context.citations)
  );

  db.prepare("UPDATE ai_conversations SET updated_at = datetime('now'), provider_type = ? WHERE id = ?").run(
    reply.providerType,
    conversationId
  );

  return {
    userMessage: formatMessage(db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(userMsgId)),
    assistantMessage: formatMessage(db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(assistantMsgId))
  };
}
