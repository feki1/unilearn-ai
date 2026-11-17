/**
 * Unified SQLite + FTS5 Schema for UniLearn AI (M1, M2, M3, M4).
 * Uses single-quoted SQL literals exclusively for node:sqlite compatibility.
 */

export function initSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS universities (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      allowed_domains_json TEXT NOT NULL DEFAULT '["horizon.edu","student.horizon.edu","novatech.edu"]',
      motto TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS majors (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      faculty TEXT NOT NULL DEFAULT 'Faculty of Arts & Sciences',
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'graduation-cap',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      university_id TEXT NOT NULL DEFAULT 'uni_hsu' REFERENCES universities(id) ON DELETE CASCADE,
      student_number TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'instructor', 'admin')),
      major_id TEXT DEFAULT 'major_cs',
      year_level INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL DEFAULT 'semester_essential',
      status TEXT NOT NULL CHECK (status IN ('active', 'grace_period', 'expired', 'past_due', 'canceled', 'unsubscribed')),
      price_cents INTEGER NOT NULL DEFAULT 1900,
      max_pc_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_pc_devices = 1),
      max_phone_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_phone_devices = 1),
      voucher_code TEXT,
      payment_method TEXT DEFAULT 'card',
      current_period_start TEXT NOT NULL DEFAULT (datetime('now')),
      current_period_end TEXT NOT NULL DEFAULT (datetime('now', '+180 days')),
      grace_period_ends_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS student_biometrics (
      student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      face_embedding_json TEXT NOT NULL,
      similarity_threshold REAL NOT NULL DEFAULT 0.85,
      capture_mode TEXT NOT NULL DEFAULT 'simulated',
      reference_image TEXT,
      enrollment_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'pending_reenrollment'))
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      session_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      device_type TEXT NOT NULL CHECK (device_type IN ('pc', 'phone')),
      device_fingerprint_hash TEXT NOT NULL,
      device_instance_id TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT 'University Device',
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'logged_out', 'expired', 'revoked_by_biometric_takeover', 'revoked_by_anomaly', 'locked_pending_biometric')),
      revoked_at TEXT,
      revoked_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_device_slots (
      slot_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      device_type TEXT NOT NULL CHECK (device_type IN ('pc', 'phone')),
      session_id TEXT NOT NULL UNIQUE REFERENCES user_sessions(session_id) ON DELETE CASCADE,
      device_fingerprint_hash TEXT NOT NULL,
      device_instance_id TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT 'University Device',
      ip_address TEXT DEFAULT '127.0.0.1',
      user_agent TEXT DEFAULT '',
      slot_version INTEGER NOT NULL DEFAULT 1,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked_pending_biometric')),
      UNIQUE(student_id, device_type)
    );

    CREATE TABLE IF NOT EXISTS biometric_challenges (
      challenge_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      target_slot_type TEXT NOT NULL CHECK (target_slot_type IN ('pc', 'phone')),
      conflicting_session_id TEXT,
      requesting_device_fingerprint TEXT NOT NULL,
      requesting_device_instance_id TEXT NOT NULL,
      requesting_device_label TEXT NOT NULL DEFAULT 'New Device',
      nonce TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'SECOND_DEVICE_CONFLICT',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
      similarity_score REAL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT
    );

    CREATE TABLE IF NOT EXISTS security_audit_logs (
      log_id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      device_type TEXT,
      session_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      major_id TEXT NOT NULL REFERENCES majors(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      semester TEXT NOT NULL DEFAULT 'Fall / Year 3',
      credits INTEGER NOT NULL DEFAULT 4,
      instructor TEXT NOT NULL DEFAULT 'Prof. Faculty',
      syllabus_summary TEXT NOT NULL DEFAULT '',
      exam_weight_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      module_number INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content_markdown TEXT NOT NULL DEFAULT '',
      key_concepts_json TEXT NOT NULL DEFAULT '[]',
      formulas_json TEXT NOT NULL DEFAULT '[]',
      estimated_minutes INTEGER NOT NULL DEFAULT 30,
      created_by TEXT DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS course_files (
      id TEXT PRIMARY KEY,
      major_id TEXT,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      uploaded_by TEXT DEFAULT 'system',
      scope TEXT NOT NULL DEFAULT 'university',
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/markdown',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT,
      extracted_text TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      key_topics_json TEXT NOT NULL DEFAULT '[]',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'indexed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS course_chunks (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      file_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'lesson',
      source_title TEXT NOT NULL DEFAULT '',
      chunk_index INTEGER NOT NULL DEFAULT 0,
      heading TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS course_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      subject_id UNINDEXED,
      source_title,
      heading,
      content,
      keywords
    );

    CREATE TABLE IF NOT EXISTS ai_provider_configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      api_key_encrypted TEXT NOT NULL DEFAULT '',
      api_key_masked TEXT NOT NULL DEFAULT '',
      execution_mode TEXT NOT NULL DEFAULT 'auto',
      custom_headers_json TEXT NOT NULL DEFAULT '{}',
      temperature REAL NOT NULL DEFAULT 0.3,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_tested_at TEXT,
      last_test_status TEXT DEFAULT 'ready',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      major_id TEXT,
      subject_id TEXT,
      lesson_id TEXT,
      provider_config_id TEXT DEFAULT 'built_in',
      provider_type TEXT NOT NULL DEFAULT 'built_in',
      title TEXT NOT NULL DEFAULT 'Study Session',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_chat_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      user_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      extracted_text TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'built_in',
      model_name TEXT NOT NULL DEFAULT 'hsu-tutor-v1',
      execution_mode TEXT NOT NULL DEFAULT 'course_grounded_rag',
      attached_file_ids_json TEXT NOT NULL DEFAULT '[]',
      citations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS slide_decks (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      file_id TEXT,
      created_by TEXT DEFAULT 'system',
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'university-indigo',
      provider_type TEXT NOT NULL DEFAULT 'built_in',
      slide_count INTEGER NOT NULL DEFAULT 0,
      slides_json TEXT NOT NULL DEFAULT '[]',
      source_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS research_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      major_id TEXT,
      subject_id TEXT,
      title TEXT NOT NULL,
      query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      executive_summary TEXT NOT NULL DEFAULT '',
      sections_json TEXT NOT NULL DEFAULT '[]',
      collected_data_table_json TEXT NOT NULL DEFAULT '{}',
      citations_json TEXT NOT NULL DEFAULT '[]',
      student_notes TEXT NOT NULL DEFAULT '',
      provider_type TEXT NOT NULL DEFAULT 'built_in',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_videos (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      research_id TEXT,
      title TEXT NOT NULL,
      topic_prompt TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 45,
      style_theme TEXT NOT NULL DEFAULT 'academic-dark',
      scenes_json TEXT NOT NULL DEFAULT '[]',
      transcript_json TEXT NOT NULL DEFAULT '[]',
      key_takeaways_json TEXT NOT NULL DEFAULT '[]',
      mp4_generated_path TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS flashcards (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      topic_tag TEXT NOT NULL DEFAULT 'General',
      front TEXT NOT NULL,
      back TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      formula TEXT NOT NULL DEFAULT '',
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      mastery_level TEXT NOT NULL DEFAULT 'new',
      next_review_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exams_and_quizzes (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_id TEXT,
      mode TEXT NOT NULL DEFAULT 'practice_quiz',
      title TEXT NOT NULL,
      difficulty TEXT NOT NULL DEFAULT 'intermediate',
      time_limit_sec INTEGER NOT NULL DEFAULT 900,
      questions_json TEXT NOT NULL DEFAULT '[]',
      total_points INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exam_attempts (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exams_and_quizzes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'practice_quiz',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_used_sec INTEGER NOT NULL DEFAULT 0,
      score_points REAL NOT NULL DEFAULT 0,
      total_points REAL NOT NULL DEFAULT 100,
      percentage REAL NOT NULL DEFAULT 0,
      letter_grade TEXT NOT NULL DEFAULT 'F',
      answers_json TEXT NOT NULL DEFAULT '{}',
      topic_breakdown_json TEXT NOT NULL DEFAULT '[]',
      weakness_recommendations_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS study_guides (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      overview TEXT NOT NULL DEFAULT '',
      high_yield_concepts_json TEXT NOT NULL DEFAULT '[]',
      formulas_sheet_json TEXT NOT NULL DEFAULT '[]',
      common_exam_traps_json TEXT NOT NULL DEFAULT '[]',
      worked_problems_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_student ON user_sessions(student_id, device_type, status);
    CREATE INDEX IF NOT EXISTS idx_slots_student ON active_device_slots(student_id, device_type);
    CREATE INDEX IF NOT EXISTS idx_challenges_student ON biometric_challenges(student_id, status);
    CREATE INDEX IF NOT EXISTS idx_subjects_major ON subjects(major_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_subject ON lessons(subject_id, module_number);
    CREATE INDEX IF NOT EXISTS idx_course_files_subject ON course_files(subject_id);
    CREATE INDEX IF NOT EXISTS idx_course_chunks_subject ON course_chunks(subject_id);
  `);
}

export default initSchema;
