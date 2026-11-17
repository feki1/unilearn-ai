import {
  apiRequest,
  clearSession,
  getDeviceIdentity,
  loadSavedSession,
  saveSession
} from './api.js';

const state = {
  token: null,
  student: null,
  subscription: null,
  activeSlots: { pc: null, phone: null },
  currentView: 'auth',
  selectedSubjectId: null,
  currentConversationId: null,
  currentDeck: null,
  currentSlideIndex: 0,
  pendingChallenge: null,
  sseSource: null,
  heartbeatTimer: null
};

const $ = (id) => document.getElementById(id);

function showAlert(msg) {
  const el = $('globalAlert');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setAuthenticatedUi(isAuthed) {
  $('mainNav').classList.toggle('hidden', !isAuthed);
  $('logoutBtn').classList.toggle('hidden', !isAuthed);
  if (!isAuthed) {
    switchView('auth');
    $('subscriptionBadge').textContent = 'Not Signed In';
    $('subscriptionBadge').className = 'sub-pill sub-none';
    $('pcSlotBadge').textContent = 'PC: Offline';
    $('pcSlotBadge').className = 'slot-pill slot-empty';
    $('phoneSlotBadge').textContent = 'Phone: Offline';
    $('phoneSlotBadge').className = 'slot-pill slot-empty';
  }
}

function updateStatusBar() {
  const sub = state.subscription;
  const subEl = $('subscriptionBadge');
  if (sub) {
    subEl.textContent = `Sub: ${sub.status.toUpperCase()} (${sub.planId || 'plan'})`;
    subEl.className = `sub-pill ${
      sub.status === 'active'
        ? 'sub-active'
        : sub.status === 'grace_period'
          ? 'sub-grace'
          : 'sub-expired'
    }`;
  }

  const pc = state.activeSlots?.pc;
  const phone = state.activeSlots?.phone;
  $('pcSlotBadge').textContent = pc ? `PC: Active (${pc.deviceLabel || 'PC'})` : 'PC: Available';
  $('pcSlotBadge').className = `slot-pill ${pc ? 'slot-active' : 'slot-empty'}`;
  $('phoneSlotBadge').textContent = phone ? `Phone: Active (${phone.deviceLabel || 'Phone'})` : 'Phone: Available';
  $('phoneSlotBadge').className = `slot-pill ${phone ? 'slot-active' : 'slot-empty'}`;
}

function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('hidden', v.id !== `view-${viewName}`);
    v.classList.toggle('active', v.id === `view-${viewName}`);
  });
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
}

function showPreemptedLock(reason) {
  $('preemptedReason').textContent = reason || 'Your session was preempted by another device after Facial Authentication.';
  $('preemptedOverlay').classList.remove('hidden');
  stopRealtimeAndHeartbeat();
}

function stopRealtimeAndHeartbeat() {
  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function startRealtimeAndHeartbeat() {
  stopRealtimeAndHeartbeat();
  if (!state.token) return;

  try {
    state.sseSource = new EventSource(`/api/auth/sessions/events?token=${encodeURIComponent(state.token)}`);
    state.sseSource.addEventListener('session_preempted', (ev) => {
      const payload = JSON.parse(ev.data || '{}');
      showPreemptedLock(payload.message || 'Session preempted by facial auth takeover on another device.');
    });
    state.sseSource.addEventListener('anomaly_locked', () => {
      showAlert('Security anomaly detected. Please complete Facial Authentication.');
    });
  } catch {
    // Fallback to heartbeat polling
  }

  state.heartbeatTimer = setInterval(async () => {
    if (!state.token) return;
    const res = await apiRequest('/api/auth/sessions/heartbeat', {
      method: 'POST',
      token: state.token
    });
    if (res.status === 401 && res.data?.code === 'SESSION_PREEMPTED') {
      showPreemptedLock(res.data?.message);
    } else if (res.ok && res.data?.activeSlots) {
      state.activeSlots = res.data.activeSlots;
      updateStatusBar();
    }
  }, 15000);
}

async function openFacialModal(challengeData) {
  state.pendingChallenge = challengeData;
  $('facialModalMessage').textContent =
    challengeData.message || 'Complete Facial Authentication to verify your identity and claim this device slot.';
  $('facialResultMsg').textContent = '';
  $('facialModal').classList.remove('hidden');

  const videoEl = $('facialVideo');
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoEl.srcObject = stream;
      $('webcamStatus').textContent = 'WebRTC Camera active — ready for capture';
    } catch {
      $('webcamStatus').textContent = 'Camera unavailable — use simulator presets below';
    }
  }
}

function closeFacialModal() {
  $('facialModal').classList.add('hidden');
  const videoEl = $('facialVideo');
  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
}

async function submitFacialVerification({ simulationPreset = null, captureWebcam = false } = {}) {
  if (!state.pendingChallenge) return;
  let livenessConfirmed = true;
  if (captureWebcam) {
    const videoEl = $('facialVideo');
    const canvasEl = $('facialCanvas');
    const ctx = canvasEl.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    simulationPreset = 'match';
  }

  const res = await apiRequest('/api/auth/biometrics/verify-and-takeover', {
    method: 'POST',
    token: state.token,
    body: {
      challengeId: state.pendingChallenge.challengeId,
      nonce: state.pendingChallenge.nonce,
      simulationPreset: simulationPreset || 'match',
      livenessConfirmed
    }
  });

  if (res.ok && res.data?.verified) {
    closeFacialModal();
    await onLoginSuccess(res.data);
    showAlert(`Facial Authentication passed (similarity ${res.data.similarityScore}). Device slot claimed!`);
  } else {
    $('facialResultMsg').textContent = res.data?.error || 'Facial verification failed.';
  }
}

async function onLoginSuccess(data) {
  state.token = data.sessionToken || data.token;
  state.student = data.student;
  state.subscription = data.subscription;
  state.activeSlots = data.activeSlots || state.activeSlots;
  saveSession({ token: state.token, student: state.student });

  setAuthenticatedUi(true);
  updateStatusBar();
  startRealtimeAndHeartbeat();

  if (state.subscription?.status === 'expired' || state.subscription?.status === 'unsubscribed') {
    switchView('subscription');
    $('subStatusDetail').textContent = `Current subscription is ${state.subscription.status}. Activate a plan to unlock study tools.`;
  } else {
    switchView('catalog');
    await loadCatalogAndSelectors();
    await loadProviders();
  }
}

async function loadCatalogAndSelectors() {
  const majorsRes = await apiRequest('/api/catalog/majors', { token: state.token });
  if (majorsRes.ok) {
    const sel = $('majorFilterSelect');
    sel.innerHTML = '<option value="">All Majors</option>';
    for (const m of majorsRes.data.majors || []) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.code} — ${m.name}`;
      sel.appendChild(opt);
    }
  }

  const subjRes = await apiRequest('/api/catalog/subjects', { token: state.token });
  if (subjRes.ok) {
    const subjects = subjRes.data.subjects || [];
    const listEl = $('subjectsList');
    listEl.innerHTML = '';
    for (const s of subjects) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `<strong>${s.code}</strong>: ${s.title}<div class="muted">${s.majorName || ''} · ${s.lessonCount} lessons</div>`;
      item.onclick = () => selectSubject(s.id);
      listEl.appendChild(item);
    }

    ['slideSubjectSelect', 'videoSubjectSelect', 'examSubjectSelect'].forEach((id) => {
      const selectEl = $(id);
      selectEl.innerHTML = '';
      for (const s of subjects) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.code} — ${s.title}`;
        selectEl.appendChild(opt);
      }
    });

    if (subjects.length > 0 && !state.selectedSubjectId) {
      await selectSubject(subjects[0].id);
    }
  }
}

async function selectSubject(subjectId) {
  state.selectedSubjectId = subjectId;
  const res = await apiRequest(`/api/catalog/subjects/${encodeURIComponent(subjectId)}`, {
    token: state.token
  });
  if (!res.ok) return;
  const { subject, lessons, files } = res.data;
  $('selectedSubjectTitle').textContent = `${subject.code}: ${subject.title}`;
  const container = $('subjectLessonsList');
  container.innerHTML = '';
  for (const l of lessons || []) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<strong>Module ${l.moduleNumber}: ${l.title}</strong><div class="muted">${l.summary}</div>`;
    container.appendChild(div);
  }
  for (const f of files || []) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<strong>File: ${f.filename}</strong><div class="muted">${f.chunkCount} FTS5 chunks indexed</div>`;
    container.appendChild(div);
  }
}

async function loadProviders() {
  const res = await apiRequest('/api/ai/providers', { token: state.token });
  if (!res.ok) return;
  const listEl = $('providersList');
  const selectEl = $('chatProviderSelect');
  listEl.innerHTML = '';
  selectEl.innerHTML = '';

  for (const p of res.data.configuredProviders || []) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<strong>${p.displayName}</strong> (${p.providerType})<div class="muted">Model: ${p.modelName} · Key: ${p.apiKeyMasked || 'Internal'}</div>`;
    listEl.appendChild(div);

    const opt = document.createElement('option');
    opt.value = p.id;
    opt.dataset.providerType = p.providerType;
    opt.textContent = `${p.displayName} (${p.modelName})`;
    selectEl.appendChild(opt);
  }
}

async function ensureConversation() {
  if (state.currentConversationId) return state.currentConversationId;
  const res = await apiRequest('/api/ai/conversations', {
    method: 'POST',
    token: state.token,
    body: {
      subjectId: state.selectedSubjectId,
      title: 'HSU AI Tutor Session'
    }
  });
  if (res.ok) {
    state.currentConversationId = res.data.conversation.id;
  }
  return state.currentConversationId;
}

function renderCurrentSlide() {
  const deck = state.currentDeck;
  if (!deck || !deck.slides?.length) return;
  const slide = deck.slides[state.currentSlideIndex] || deck.slides[0];
  $('slideCounter').textContent = `${state.currentSlideIndex + 1} / ${deck.slides.length}`;
  $('slideStage').innerHTML = `
    <h3>${slide.title}</h3>
    <p class="muted">${slide.subtitle || ''}</p>
    <ul>${(slide.bullets || []).map((b) => `<li>${b}</li>`).join('')}</ul>
    ${slide.diagramSvg ? `<div>${slide.diagramSvg}</div>` : ''}
    ${slide.formula ? `<div class="code-box">${slide.formula}</div>` : ''}
    <p class="muted"><strong>Speaker Notes:</strong> ${slide.speakerNotes || ''}</p>
  `;
}

function bindEvents() {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('quickDemoBtn').addEventListener('click', () => {
    $('loginEmail').value = 'feki@xmu.edu.my';
    $('loginPassword').value = 'UniPass2026!';
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    const dev = getDeviceIdentity();
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: $('loginEmail').value,
        password: $('loginPassword').value,
        ...dev
      }
    });
    if (res.status === 409 && res.data?.requiresFacialAuth) {
      await openFacialModal(res.data);
      return;
    }
    if (!res.ok) {
      $('loginError').textContent = res.data?.error || 'Login failed';
      return;
    }
    await onLoginSuccess(res.data);
  });

  $('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('registerError').textContent = '';
    const voucher = $('regVoucher').value.trim();
    const res = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        fullName: $('regName').value,
        email: $('regEmail').value,
        password: $('regPassword').value,
        planId: voucher ? 'department_sponsored' : undefined,
        voucherCode: voucher || undefined
      }
    });
    if (!res.ok) {
      $('registerError').textContent = res.data?.error || 'Registration failed';
      return;
    }
    showAlert('Account created! You can now sign in.');
  });

  $('logoutBtn').addEventListener('click', async () => {
    await apiRequest('/api/auth/logout', { method: 'POST', token: state.token });
    clearSession();
    state.token = null;
    stopRealtimeAndHeartbeat();
    setAuthenticatedUi(false);
  });

  $('reauthFromLockBtn').addEventListener('click', () => {
    $('preemptedOverlay').classList.add('hidden');
    clearSession();
    state.token = null;
    setAuthenticatedUi(false);
  });

  $('closeFacialModalBtn').addEventListener('click', closeFacialModal);
  $('verifyWebcamBtn').addEventListener('click', () => submitFacialVerification({ captureWebcam: true }));
  $('verifyMatchPresetBtn').addEventListener('click', () => submitFacialVerification({ simulationPreset: 'match' }));
  $('verifyImpostorPresetBtn').addEventListener('click', () => submitFacialVerification({ simulationPreset: 'impostor' }));

  $('activateSubForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await apiRequest('/api/subscription/activate', {
      method: 'POST',
      token: state.token,
      body: {
        planId: $('subPlanSelect').value,
        voucherCode: $('subVoucherInput').value.trim() || undefined
      }
    });
    if (res.ok) {
      state.subscription = res.data.subscription;
      updateStatusBar();
      showAlert('Subscription activated!');
      await loadCatalogAndSelectors();
    } else {
      showAlert(res.data?.error || 'Subscription activation failed');
    }
  });

  $('enrollFaceBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/auth/biometrics/enroll', {
      method: 'POST',
      token: state.token,
      body: { captureMode: 'webcam' }
    });
    $('securityStatusOutput').textContent = JSON.stringify(res.data, null, 2);
  });

  $('anomalyTestBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/auth/sessions/report-anomaly', {
      method: 'POST',
      token: state.token,
      body: { reason: 'User triggered security verification' }
    });
    $('securityStatusOutput').textContent = JSON.stringify(res.data, null, 2);
    if (res.data?.challengeId) {
      await openFacialModal(res.data);
    }
  });

  $('catalogSearchBtn').addEventListener('click', async () => {
    const q = $('catalogSearchInput').value.trim();
    const res = await apiRequest(`/api/catalog/search?q=${encodeURIComponent(q)}`, {
      token: state.token
    });
    if (res.ok) {
      $('searchResultsBox').classList.remove('hidden');
      const list = $('searchResultsList');
      list.innerHTML = '';
      for (const r of res.data.results || []) {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.innerHTML = `<strong>${r.sourceTitle} · ${r.heading}</strong><div>${r.snippet}</div>`;
        list.appendChild(div);
      }
    }
  });

  $('courseUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedSubjectId) return;
    const fileInput = $('courseFileInput');
    let filename = $('courseFileName').value.trim() || 'student-notes.md';
    let contentText = $('courseFileText').value.trim();
    if (fileInput.files?.[0]) {
      filename = fileInput.files[0].name;
      contentText = await fileInput.files[0].text();
    }
    const res = await apiRequest('/api/catalog/files/upload', {
      method: 'POST',
      token: state.token,
      body: { subjectId: state.selectedSubjectId, filename, contentText }
    });
    if (res.ok) {
      showAlert(`Indexed ${res.data.file.filename} (${res.data.chunksCreated} chunks)`);
      await selectSubject(state.selectedSubjectId);
    }
  });

  $('addProviderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await apiRequest('/api/ai/providers', {
      method: 'POST',
      token: state.token,
      body: {
        providerType: $('byoProviderType').value,
        modelName: $('byoModelName').value.trim() || undefined,
        apiKey: $('byoApiKey').value.trim()
      }
    });
    if (res.ok) {
      $('byoApiKey').value = '';
      await loadProviders();
      showAlert(`Saved ${res.data.provider.displayName}`);
    }
  });

  $('newChatBtn').addEventListener('click', async () => {
    state.currentConversationId = null;
    $('chatMessagesBox').innerHTML = '';
    await ensureConversation();
  });

  $('chatUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const convId = await ensureConversation();
    const res = await apiRequest(`/api/ai/conversations/${convId}/files`, {
      method: 'POST',
      token: state.token,
      body: {
        filename: $('chatFileName').value.trim() || 'attached-note.txt',
        contentText: $('chatFileContent').value.trim() || 'Sample attached study note'
      }
    });
    if (res.ok) {
      showAlert(`Attached ${res.data.chatFile.filename} to chat`);
    }
  });

  $('chatSendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const convId = await ensureConversation();
    const prompt = $('chatPromptInput').value.trim();
    if (!prompt) return;
    $('chatPromptInput').value = '';
    const sel = $('chatProviderSelect');
    const selectedOpt = sel.options[sel.selectedIndex];

    const res = await apiRequest(`/api/ai/conversations/${convId}/messages`, {
      method: 'POST',
      token: state.token,
      body: {
        content: prompt,
        providerConfigId: sel.value || undefined,
        providerType: selectedOpt?.dataset?.providerType || 'built_in'
      }
    });

    if (res.ok) {
      const box = $('chatMessagesBox');
      box.innerHTML += `<div class="msg msg-user">${res.data.userMessage.content}</div>`;
      box.innerHTML += `<div class="msg msg-assistant">${res.data.assistantMessage.content.replace(/\n/g, '<br/>')}</div>`;
      box.scrollTop = box.scrollHeight;
    }
  });

  $('generateSlidesBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/slides/generate', {
      method: 'POST',
      token: state.token,
      body: {
        subjectId: $('slideSubjectSelect').value,
        customTopic: $('slideTopicInput').value.trim() || undefined
      }
    });
    if (res.ok) {
      state.currentDeck = res.data.deck;
      state.currentSlideIndex = 0;
      renderCurrentSlide();
    }
  });

  $('prevSlideBtn').addEventListener('click', () => {
    if (!state.currentDeck) return;
    state.currentSlideIndex = Math.max(0, state.currentSlideIndex - 1);
    renderCurrentSlide();
  });

  $('nextSlideBtn').addEventListener('click', () => {
    if (!state.currentDeck) return;
    state.currentSlideIndex = Math.min(state.currentDeck.slides.length - 1, state.currentSlideIndex + 1);
    renderCurrentSlide();
  });

  $('runResearchBtn').addEventListener('click', async () => {
    const query = $('researchQueryInput').value.trim();
    if (!query) return;
    const res = await apiRequest('/api/research/run', {
      method: 'POST',
      token: state.token,
      body: { query, subjectId: state.selectedSubjectId }
    });
    if (res.ok) {
      const p = res.data.project;
      const cols = p.collectedDataTable?.columns || [];
      const rows = p.collectedDataTable?.rows || [];
      $('researchOutputBox').innerHTML = `
        <h4>${p.title}</h4>
        <p>${p.executiveSummary}</p>
        <table class="data-table">
          <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      `;
    }
  });

  $('generateVideoBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/videos/generate', {
      method: 'POST',
      token: state.token,
      body: {
        subjectId: $('videoSubjectSelect').value,
        topicPrompt: $('videoTopicInput').value.trim() || 'Core Lesson Walkthrough'
      }
    });
    if (res.ok) {
      const v = res.data.video;
      $('videoPlayerBox').innerHTML = `
        <h4>${v.title}</h4>
        <video controls width="100%" src="/api/videos/${v.id}/stream?token=${encodeURIComponent(state.token)}"></video>
        <div class="list-stack">${v.transcript.map((t) => `<div class="list-item"><strong>${t.timestamp}</strong> ${t.text}</div>`).join('')}</div>
      `;
    }
  });

  $('genQuizBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/exam-prep/exams/generate', {
      method: 'POST',
      token: state.token,
      body: { subjectId: $('examSubjectSelect').value, mode: 'practice_quiz', questionCount: 4 }
    });
    if (res.ok) {
      const exam = res.data.exam;
      $('examStudioBox').innerHTML = `
        <h4>${exam.title}</h4>
        ${exam.questions.map((q) => `<div class="list-item"><strong>${q.prompt}</strong><div class="muted">${q.options.join(' | ')}</div></div>`).join('')}
      `;
    }
  });

  $('genFlashcardsBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/exam-prep/flashcards/generate', {
      method: 'POST',
      token: state.token,
      body: { subjectId: $('examSubjectSelect').value, count: 4 }
    });
    if (res.ok) {
      $('examStudioBox').innerHTML = res.data.flashcards
        .map((c) => `<div class="list-item"><strong>${c.front}</strong><div class="muted">${c.back}</div></div>`)
        .join('');
    }
  });

  $('genGuideBtn').addEventListener('click', async () => {
    const res = await apiRequest('/api/exam-prep/study-guides/generate', {
      method: 'POST',
      token: state.token,
      body: { subjectId: $('examSubjectSelect').value }
    });
    if (res.ok) {
      $('examStudioBox').innerHTML = `<div class="code-box">${res.data.studyGuide.contentMarkdown}</div>`;
    }
  });
}

async function init() {
  bindEvents();
  const saved = loadSavedSession();
  if (saved?.token) {
    state.token = saved.token;
    const statusRes = await apiRequest('/api/auth/sessions/status', { token: state.token });
    if (statusRes.ok) {
      await onLoginSuccess({
        token: state.token,
        student: statusRes.data.student,
        subscription: statusRes.data.subscription,
        activeSlots: statusRes.data.slots
      });
      return;
    }
    clearSession();
    state.token = null;
  }
  setAuthenticatedUi(false);
}

init();
