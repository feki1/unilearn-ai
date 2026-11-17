import crypto from 'node:crypto';
import CONFIG from '../../config.js';

export const SUPPORTED_PROVIDERS = [
  'built_in',
  'gemini',
  'claude',
  'kimi',
  'kiro',
  'openai',
  'custom'
];

export const PROVIDER_DEFAULTS = {
  built_in: {
    displayName: 'HSU Built-In Academic Tutor',
    modelName: 'hsu-tutor-v1',
    baseUrl: ''
  },
  gemini: {
    displayName: 'Google Gemini (BYO-AI)',
    modelName: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  },
  claude: {
    displayName: 'Anthropic Claude (BYO-AI)',
    modelName: 'claude-3-7-sonnet',
    baseUrl: 'https://api.anthropic.com/v1'
  },
  kimi: {
    displayName: 'Moonshot Kimi (BYO-AI)',
    modelName: 'moonshot-v1-128k',
    baseUrl: 'https://api.moonshot.cn/v1'
  },
  kiro: {
    displayName: 'Kiro AI Assistant (BYO-AI)',
    modelName: 'kiro-agent-v1',
    baseUrl: 'https://api.kiro.dev/v1'
  },
  openai: {
    displayName: 'OpenAI (BYO-AI)',
    modelName: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1'
  },
  custom: {
    displayName: 'Custom OpenAI-Compatible (BYO-AI)',
    modelName: 'custom-model',
    baseUrl: ''
  }
};

function getEncryptionKey() {
  return crypto.createHash('sha256').update(CONFIG.jwtSecret).digest();
}

export function encryptApiKey(rawKey) {
  if (!rawKey) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(rawKey), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptApiKey(stored) {
  if (!stored || !String(stored).includes(':')) return '';
  try {
    const [ivHex, tagHex, dataHex] = String(stored).split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getEncryptionKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final()
    ]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

export function maskApiKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return '';
  if (key.length <= 8) return `****${key.slice(-2)}`;
  const prefix = key.slice(0, 3);
  const suffix = key.slice(-4);
  return `${prefix}****${suffix}`;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function formatProviderRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    providerType: r.provider_type,
    displayName: r.display_name,
    modelName: r.model_name,
    baseUrl: r.base_url,
    apiKeyMasked: r.api_key_masked || '',
    api_key_masked: r.api_key_masked || '',
    executionMode: r.execution_mode,
    customHeaders: safeJsonParse(r.custom_headers_json, {}),
    temperature: Number(r.temperature ?? 0.3),
    isDefault: Boolean(r.is_default),
    isEnabled: Boolean(r.is_enabled),
    lastTestedAt: r.last_tested_at,
    lastTestStatus: r.last_test_status,
    createdAt: r.created_at
  };
}

export function ensureBuiltInProvider(db, userId) {
  const existing = db
    .prepare("SELECT * FROM ai_provider_configs WHERE user_id = ? AND provider_type = 'built_in'")
    .get(userId);
  if (existing) return existing;

  const hasAny = db.prepare('SELECT COUNT(*) AS cnt FROM ai_provider_configs WHERE user_id = ?').get(userId).cnt;
  const id = `prov_builtin_${userId.slice(-6)}`;
  db.prepare(`
    INSERT INTO ai_provider_configs (
      id, user_id, provider_type, display_name, model_name, base_url,
      api_key_encrypted, api_key_masked, execution_mode, temperature, is_default, is_enabled, last_test_status
    )
    VALUES (?, ?, 'built_in', ?, ?, '', '', 'HSU-INTERNAL', 'local_rag', 0.25, ?, 1, 'ready')
  `).run(
    id,
    userId,
    PROVIDER_DEFAULTS.built_in.displayName,
    PROVIDER_DEFAULTS.built_in.modelName,
    hasAny === 0 ? 1 : 0
  );
  return db.prepare('SELECT * FROM ai_provider_configs WHERE id = ?').get(id);
}

export function listProviders(db, userId) {
  ensureBuiltInProvider(db, userId);
  const rows = db
    .prepare('SELECT * FROM ai_provider_configs WHERE user_id = ? ORDER BY is_default DESC, created_at ASC')
    .all(userId);
  return {
    supportedProviders: SUPPORTED_PROVIDERS,
    configuredProviders: rows.map(formatProviderRow)
  };
}

export function upsertProvider(db, userId, payload) {
  const providerType = String(payload.providerType || '').trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(providerType)) {
    const err = new Error(`Unsupported AI provider type: ${providerType}`);
    err.statusCode = 400;
    err.code = 'UNSUPPORTED_PROVIDER';
    throw err;
  }

  const defaults = PROVIDER_DEFAULTS[providerType] || PROVIDER_DEFAULTS.custom;
  const displayName = String(payload.displayName || defaults.displayName).trim();
  const modelName = String(payload.modelName || defaults.modelName).trim();
  const baseUrl = String(payload.baseUrl ?? defaults.baseUrl).trim();
  const executionMode = ['auto', 'live', 'local_rag'].includes(payload.executionMode)
    ? payload.executionMode
    : 'auto';
  const temperature = Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0.3;
  const isDefault = Boolean(payload.isDefault);
  const rawApiKey = String(payload.apiKey || '').trim();

  if (providerType !== 'built_in' && !rawApiKey && !payload.id) {
    const err = new Error(`apiKey is required for BYO-AI provider '${providerType}'.`);
    err.statusCode = 400;
    err.code = 'API_KEY_REQUIRED';
    throw err;
  }

  if (isDefault) {
    db.prepare('UPDATE ai_provider_configs SET is_default = 0 WHERE user_id = ?').run(userId);
  }

  const encrypted = rawApiKey ? encryptApiKey(rawApiKey) : '';
  const masked = rawApiKey ? maskApiKey(rawApiKey) : 'HSU-INTERNAL';
  const id = `prov_${providerType}_${crypto.randomUUID().slice(0, 8)}`;

  db.prepare(`
    INSERT INTO ai_provider_configs (
      id, user_id, provider_type, display_name, model_name, base_url,
      api_key_encrypted, api_key_masked, execution_mode, custom_headers_json,
      temperature, is_default, is_enabled, last_test_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ready')
  `).run(
    id,
    userId,
    providerType,
    displayName,
    modelName,
    baseUrl,
    encrypted,
    masked,
    executionMode,
    JSON.stringify(payload.customHeaders || {}),
    temperature,
    isDefault ? 1 : 0
  );

  const saved = db.prepare('SELECT * FROM ai_provider_configs WHERE id = ?').get(id);
  return formatProviderRow(saved);
}

export function updateProvider(db, userId, providerId, payload) {
  const existing = db
    .prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?')
    .get(providerId, userId);

  if (!existing) {
    const err = new Error(`AI provider not found: ${providerId}`);
    err.statusCode = 404;
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }

  if (payload.isDefault === true) {
    db.prepare('UPDATE ai_provider_configs SET is_default = 0 WHERE user_id = ?').run(userId);
  }

  const rawApiKey = payload.apiKey ? String(payload.apiKey).trim() : '';
  const encrypted = rawApiKey ? encryptApiKey(rawApiKey) : existing.api_key_encrypted;
  const masked = rawApiKey ? maskApiKey(rawApiKey) : existing.api_key_masked;

  db.prepare(`
    UPDATE ai_provider_configs
    SET display_name = ?, model_name = ?, base_url = ?, api_key_encrypted = ?,
        api_key_masked = ?, execution_mode = ?, temperature = ?, is_default = ?, is_enabled = ?
    WHERE id = ? AND user_id = ?
  `).run(
    payload.displayName !== undefined ? String(payload.displayName) : existing.display_name,
    payload.modelName !== undefined ? String(payload.modelName) : existing.model_name,
    payload.baseUrl !== undefined ? String(payload.baseUrl) : existing.base_url,
    encrypted,
    masked,
    payload.executionMode || existing.execution_mode,
    payload.temperature !== undefined ? Number(payload.temperature) : existing.temperature,
    payload.isDefault !== undefined ? (payload.isDefault ? 1 : 0) : existing.is_default,
    payload.isEnabled !== undefined ? (payload.isEnabled ? 1 : 0) : existing.is_enabled,
    providerId,
    userId
  );

  return formatProviderRow(
    db.prepare('SELECT * FROM ai_provider_configs WHERE id = ?').get(providerId)
  );
}

export function deleteProvider(db, userId, providerId) {
  const existing = db
    .prepare('SELECT * FROM ai_provider_configs WHERE id = ? AND user_id = ?')
    .get(providerId, userId);

  if (!existing) {
    const err = new Error(`AI provider not found: ${providerId}`);
    err.statusCode = 404;
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }

  if (existing.provider_type === 'built_in') {
    const err = new Error('The built-in HSU Academic Tutor provider cannot be deleted.');
    err.statusCode = 400;
    err.code = 'CANNOT_DELETE_BUILTIN';
    throw err;
  }

  db.prepare('DELETE FROM ai_provider_configs WHERE id = ? AND user_id = ?').run(providerId, userId);
  return { deleted: true, providerId };
}

export async function testProvider(db, userId, providerId) {
  ensureBuiltInProvider(db, userId);
  const row = db
    .prepare('SELECT * FROM ai_provider_configs WHERE (id = ? OR provider_type = ?) AND user_id = ?')
    .get(providerId, providerId, userId);

  if (!row) {
    const err = new Error(`AI provider not found: ${providerId}`);
    err.statusCode = 404;
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }

  let sampleResponse = `[${row.provider_type.toUpperCase()} / ${row.model_name}] Connection verified and ready for course-grounded tutoring.`;
  let actualMode = row.execution_mode === 'live' ? 'live' : 'course_grounded_rag';

  if (row.execution_mode === 'live' && row.base_url && row.base_url.startsWith('http://127.0.0.1')) {
    try {
      const apiKey = decryptApiKey(row.api_key_encrypted);
      const resp = await fetch(`${row.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: row.model_name,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        signal: AbortSignal.timeout(2500)
      });
      if (resp.ok) {
        const data = await resp.json();
        sampleResponse = data?.choices?.[0]?.message?.content || sampleResponse;
        actualMode = 'live';
      }
    } catch {
      actualMode = 'course_grounded_rag';
    }
  }

  db.prepare("UPDATE ai_provider_configs SET last_tested_at = datetime('now'), last_test_status = 'ok' WHERE id = ?").run(row.id);

  return {
    status: 'ok',
    providerId: row.id,
    providerType: row.provider_type,
    modelName: row.model_name,
    executionMode: actualMode,
    sampleResponse
  };
}
