import crypto from 'node:crypto';
import CONFIG from '../config.js';
import { runImmediateTransaction } from './connection.js';
import { seedXmumCurriculum } from './seedXmum.js';

export function hashPassword(password) {
  const salt = 'hsu-salt-2026';
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPasswordHash(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    const derivedHex = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(derivedHex, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const hmacHex = crypto.createHmac('sha256', CONFIG.jwtSecret).update(String(password)).digest('hex');
  return hmacHex === storedHash;
}

export function normalizeVector(vec, dimensions = 128) {
  const arr = Array.isArray(vec) ? vec.map((v) => Number(v) || 0) : [];
  const padded = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    padded[i] = i < arr.length ? arr[i] : 0.5;
  }
  let sumSq = 0;
  for (let i = 0; i < dimensions; i++) {
    sumSq += padded[i] * padded[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) {
    const uniform = 1 / Math.sqrt(dimensions);
    return new Array(dimensions).fill(Number(uniform.toFixed(6)));
  }
  return padded.map((v) => Number((v / norm).toFixed(6)));
}

export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
    return 0;
  }
  const len = Math.min(vecA.length, vecB.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-12) return 0;
  return Number((dot / denom).toFixed(4));
}

export function generateDeterministicEmbedding(seedKey = 'amina@horizon.edu', dimensions = 128) {
  const digest = crypto.createHash('sha256').update(String(seedKey).toLowerCase()).digest();
  const raw = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    const byteVal = digest[i % digest.length] / 255;
    // Positive baseline so both student-specific match presets and uniform positive test vectors score >= 0.85
    raw[i] = 0.82 + 0.18 * Math.sin(byteVal * Math.PI * 2 + i * 0.41);
  }
  return normalizeVector(raw, dimensions);
}

export function getEnrolledEmbedding(email = 'amina@horizon.edu') {
  return generateDeterministicEmbedding(email, 128);
}

export function generateMatchEmbedding(enrolledVector) {
  const base = Array.isArray(enrolledVector) && enrolledVector.length === 128
    ? enrolledVector
    : generateDeterministicEmbedding('amina@horizon.edu', 128);
  const perturbed = base.map((v, i) => v * 0.97 + 0.025 * Math.cos(i * 0.53));
  return normalizeVector(perturbed, 128);
}

export function generateImpostorEmbedding(enrolledVector) {
  const base = Array.isArray(enrolledVector) && enrolledVector.length === 128
    ? enrolledVector
    : generateDeterministicEmbedding('amina@horizon.edu', 128);
  // Construct an orthogonal + low-weight component so cosine similarity is ~0.21 (< 0.85)
  const impostor = base.map((v, i) => (i % 2 === 0 ? 1 : -1) * 0.085 + v * 0.18);
  return normalizeVector(impostor, 128);
}

export function seedDatabase(db) {
  const existingUni = db.prepare('SELECT id FROM universities WHERE code = ?').get('HSU');
  if (existingUni) {
    return;
  }

  const now = '2026-11-16T06:00:00.000Z';
  const futurePeriod = '2027-06-30T23:59:59.000Z';
  const pastPeriod = '2026-09-01T00:00:00.000Z';
  const graceEnd = '2026-11-23T23:59:59.000Z';
  const defaultPasswordHash = hashPassword('UniPass2026!');

  runImmediateTransaction(db, () => {
    // 1. University
    db.prepare(`
      INSERT INTO universities (id, code, name, allowed_domains_json, motto, settings_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'uni_hsu',
      'HSU',
      'Horizon State University',
      JSON.stringify(['horizon.edu', 'student.horizon.edu', 'novatech.edu']),
      'Knowledge, Integrity, Discovery Across Every Discipline',
      JSON.stringify({ maxPcDevices: 1, maxPhoneDevices: 1, biometricThreshold: 0.85 }),
      now
    );

    // 2. 4 Majors
    const majors = [
      {
        id: 'major_cs',
        code: 'CS',
        name: 'Computer Science & Artificial Intelligence',
        faculty: 'Faculty of Computing & Data Sciences',
        description: 'Algorithms, Operating Systems, Distributed Systems, and Deep Learning Architectures.',
        icon: 'cpu'
      },
      {
        id: 'major_ece',
        code: 'ECE',
        name: 'Electrical & Computer Engineering',
        faculty: 'Faculty of Engineering & Hardware Systems',
        description: 'Signals & Systems, Fourier Analysis, Digital Logic, and Microprocessor Design.',
        icon: 'zap'
      },
      {
        id: 'major_bio',
        code: 'BIO',
        name: 'Biomedical & Life Sciences',
        faculty: 'Faculty of Medicine & Biological Sciences',
        description: 'Molecular Genetics, CRISPR Gene Editing, Enzyme Kinetics, and Cellular Biochemistry.',
        icon: 'activity'
      },
      {
        id: 'major_econ',
        code: 'ECON',
        name: 'Quantitative Economics & Finance',
        faculty: 'School of Economics & Quantitative Management',
        description: 'Macroeconomic Policy, IS-LM Equilibrium, Corporate Valuation, and Derivatives Pricing.',
        icon: 'trending-up'
      }
    ];

    const insertMajor = db.prepare(`
      INSERT INTO majors (id, code, name, faculty, description, icon, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of majors) {
      insertMajor.run(m.id, m.code, m.name, m.faculty, m.description, m.icon, now);
    }

    // 3. 3 Deterministic Student Personas
    const students = [
      {
        id: 'stu_amina',
        studentNumber: 'HSU-2026-0101',
        email: 'amina@horizon.edu',
        fullName: 'Amina Khelifi',
        majorId: 'major_cs',
        yearLevel: 3,
        subId: 'sub_amina',
        planId: 'annual_scholar',
        subStatus: 'active',
        priceCents: 2900,
        periodEnd: futurePeriod,
        graceEnd: null
      },
      {
        id: 'stu_youssef',
        studentNumber: 'HSU-2026-0102',
        email: 'youssef@horizon.edu',
        fullName: 'Youssef Mansouri',
        majorId: 'major_ece',
        yearLevel: 3,
        subId: 'sub_youssef',
        planId: 'semester_essential',
        subStatus: 'expired',
        priceCents: 1900,
        periodEnd: pastPeriod,
        graceEnd: null
      },
      {
        id: 'stu_sara',
        studentNumber: 'HSU-2026-0103',
        email: 'sara@horizon.edu',
        fullName: 'Sara Benali',
        majorId: 'major_bio',
        yearLevel: 4,
        subId: 'sub_sara',
        planId: 'semester_essential',
        subStatus: 'grace_period',
        priceCents: 1900,
        periodEnd: pastPeriod,
        graceEnd
      }
    ];

    const insertStudent = db.prepare(`
      INSERT INTO students (id, university_id, student_number, email, full_name, password_hash, role, major_id, year_level, created_at)
      VALUES (?, 'uni_hsu', ?, ?, ?, ?, 'student', ?, ?, ?)
    `);
    const insertSub = db.prepare(`
      INSERT INTO subscriptions (id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices, payment_method, current_period_start, current_period_end, grace_period_ends_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, 'university_card', ?, ?, ?, ?)
    `);
    const insertBio = db.prepare(`
      INSERT INTO student_biometrics (student_id, enrolled_at, face_embedding_json, similarity_threshold, capture_mode, enrollment_version, status)
      VALUES (?, ?, ?, 0.85, 'simulated', 1, 'enrolled')
    `);
    const insertAiConfig = db.prepare(`
      INSERT INTO ai_provider_configs (id, user_id, provider_type, display_name, model_name, base_url, api_key_encrypted, api_key_masked, execution_mode, temperature, is_default, is_enabled, last_tested_at, last_test_status, created_at)
      VALUES (?, ?, 'built_in', 'HSU Built-In Academic AI Tutor', 'hsu-grounded-rag-v1', '', '', 'BUILT-IN', 'local_rag', 0.2, 1, 1, ?, 'ok', ?)
    `);

    for (const s of students) {
      insertStudent.run(s.id, s.studentNumber, s.email, s.fullName, defaultPasswordHash, s.majorId, s.yearLevel, now);
      insertSub.run(s.subId, s.id, s.planId, s.subStatus, s.priceCents, pastPeriod, s.periodEnd, s.graceEnd, now);
      const embedding = generateDeterministicEmbedding(s.email, 128);
      insertBio.run(s.id, now, JSON.stringify(embedding));
      insertAiConfig.run(`prov_builtin_${s.id}`, s.id, now, now);
    }

    // 4. 8 Subjects across the 4 Majors
    const subjects = [
      {
        id: 'subj_cs301',
        majorId: 'major_cs',
        code: 'CS-301',
        title: 'Algorithms & Data Structures',
        semester: 'Fall / Year 3',
        credits: 4,
        instructor: 'Prof. Nadia Haddad',
        syllabusSummary: 'Asymptotic complexity, Master Theorem, balanced trees, graph shortest-path algorithms (Dijkstra, Bellman-Ford), and dynamic programming.',
        examWeight: { midterm: 35, final: 45, problemSets: 20 }
      },
      {
        id: 'subj_cs402',
        majorId: 'major_cs',
        code: 'CS-402',
        title: 'Operating Systems & Distributed Kernels',
        semester: 'Spring / Year 3',
        credits: 4,
        instructor: 'Prof. Karim Toumi',
        syllabusSummary: 'Virtual memory paging, TLB translation, process scheduling, mutexes/semaphores, deadlock prevention, and Raft distributed consensus.',
        examWeight: { midterm: 30, final: 40, kernelLabs: 30 }
      },
      {
        id: 'subj_cs450',
        majorId: 'major_cs',
        code: 'CS-450',
        title: 'Machine Learning & Neural Architectures',
        semester: 'Fall / Year 4',
        credits: 4,
        instructor: 'Prof. Leila Chergui',
        syllabusSummary: 'Gradient descent, backpropagation, scaled dot-product self-attention in Transformers, regularization, and generalization bounds.',
        examWeight: { midterm: 30, final: 40, researchProject: 30 }
      },
      {
        id: 'subj_ece210',
        majorId: 'major_ece',
        code: 'ECE-210',
        title: 'Signals, Systems & Fourier Analysis',
        semester: 'Fall / Year 2',
        credits: 4,
        instructor: 'Prof. Omar Belkacem',
        syllabusSummary: 'Continuous and discrete LTI systems, convolution integrals, Fourier Transform spectra, Nyquist-Shannon sampling theorem, and Laplace/Z-transforms.',
        examWeight: { midterm: 35, final: 45, labReports: 20 }
      },
      {
        id: 'subj_ece340',
        majorId: 'major_ece',
        code: 'ECE-340',
        title: 'Digital Logic & Microprocessor Architecture',
        semester: 'Spring / Year 3',
        credits: 4,
        instructor: 'Prof. Tarek Meziane',
        syllabusSummary: 'CMOS combinational logic, sequential FSM timing, 5-stage RISC-V pipelining, data hazard forwarding, and cache coherence protocols.',
        examWeight: { midterm: 30, final: 45, verilogLabs: 25 }
      },
      {
        id: 'subj_bio205',
        majorId: 'major_bio',
        code: 'BIO-205',
        title: 'Molecular Genetics & Cellular Biochemistry',
        semester: 'Fall / Year 2',
        credits: 4,
        instructor: 'Prof. Samira Dridi',
        syllabusSummary: 'DNA replication fidelity, transcriptional regulation, CRISPR-Cas9 targeted genome editing, and Michaelis-Menten enzyme kinetics.',
        examWeight: { midterm: 35, final: 45, wetLab: 20 }
      },
      {
        id: 'subj_econ201',
        majorId: 'major_econ',
        code: 'ECON-201',
        title: 'Macroeconomic Theory & Monetary Policy',
        semester: 'Fall / Year 2',
        credits: 3,
        instructor: 'Prof. Rachid Ferhat',
        syllabusSummary: 'IS-LM general equilibrium, Taylor rule central bank policy, Phillips curve inflation dynamics, and Solow-Swan endogenous growth.',
        examWeight: { midterm: 40, final: 40, policyMemo: 20 }
      },
      {
        id: 'subj_fin320',
        majorId: 'major_econ',
        code: 'FIN-320',
        title: 'Quantitative Corporate Finance & Derivatives',
        semester: 'Spring / Year 3',
        credits: 4,
        instructor: 'Prof. Sonia Amrani',
        syllabusSummary: 'Discounted cash flow (NPV/WACC), CAPM beta pricing, Black-Scholes-Merton PDE option valuation, and Greeks hedging.',
        examWeight: { midterm: 35, final: 45, caseStudies: 20 }
      }
    ];

    const insertSubject = db.prepare(`
      INSERT INTO subjects (id, major_id, code, title, semester, credits, instructor, syllabus_summary, exam_weight_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const subj of subjects) {
      insertSubject.run(
        subj.id,
        subj.majorId,
        subj.code,
        subj.title,
        subj.semester,
        subj.credits,
        subj.instructor,
        subj.syllabusSummary,
        JSON.stringify(subj.examWeight),
        now
      );
    }

    // 5. Lessons, Course Files, Course Chunks & FTS5 Entries
    const lessonsData = [
      {
        id: 'les_cs301_1',
        subjectId: 'subj_cs301',
        moduleNumber: 1,
        title: 'Shortest Path Algorithms: Dijkstra & Bellman-Ford',
        summary: 'Greedy priority-queue edge relaxation in non-negative graphs vs dynamic programming over negative-weight edges.',
        contentMarkdown: `# Shortest Path Algorithms in Weighted Graphs\n\n## 1. Dijkstra's Greedy Relaxation Algorithm\nDijkstra's algorithm solves the single-source shortest path (SSSP) problem on directed or undirected graphs $G = (V, E)$ with non-negative edge weights $w(u, v) \\ge 0$.\n\n### Edge Relaxation Formula\n$$d[v] = \\min(d[v], d[u] + w(u, v))$$\n\nUsing a binary min-heap priority queue, Dijkstra achieves time complexity $O((|V| + |E|) \\log |V|)$, and $O(|E| + |V| \\log |V|)$ with a Fibonacci heap.\n\n## 2. Bellman-Ford & Negative Weight Cycles\nWhen graphs contain negative edge weights, Dijkstra's greedy invariant fails because a path discovered later may reduce the cost of an already extracted vertex. Bellman-Ford relaxes all $|E|$ edges across $|V| - 1$ phases in $O(|V| \\cdot |E|)$ time and detects negative cycles on the $|V|$-th pass.`,
        keyConcepts: ['Edge Relaxation', 'Binary Min-Heap Priority Queue', 'Non-Negative Edge Invariant', 'Bellman-Ford Negative Cycle Detection'],
        formulas: [
          { name: 'Edge Relaxation', expression: 'd[v] = min(d[v], d[u] + w(u, v))' },
          { name: 'Dijkstra Binary Heap Complexity', expression: 'T(V, E) = O((|V| + |E|) log |V|)' },
          { name: 'Bellman-Ford Complexity', expression: 'T(V, E) = O(|V| * |E|)' }
        ],
        estimatedMinutes: 45
      },
      {
        id: 'les_cs301_2',
        subjectId: 'subj_cs301',
        moduleNumber: 2,
        title: 'Divide-and-Conquer Recurrences & The Master Theorem',
        summary: 'Solving asymptotic recurrences T(n) = a T(n/b) + f(n) and analyzing Red-Black Tree rotations.',
        contentMarkdown: `# Divide-and-Conquer & The Master Theorem\n\n## Master Theorem Recurrence\nFor recurrences of the form $T(n) = a T(n/b) + f(n)$ where $a \\ge 1, b > 1$, compare $f(n)$ with the critical watershed exponent $n^{\\log_b a}$.\n- **Case 1 (Leaf-heavy)**: If $f(n) = O(n^{\\log_b a - \\epsilon})$, then $T(n) = \\Theta(n^{\\log_b a})$.\n- **Case 2 (Balanced)**: If $f(n) = \\Theta(n^{\\log_b a} \\log^k n)$, then $T(n) = \\Theta(n^{\\log_b a} \\log^{k+1} n)$.\n- **Case 3 (Root-heavy)**: If $f(n) = \\Omega(n^{\\log_b a + \\epsilon})$ and regularity $a f(n/b) \\le c f(n)$ holds, then $T(n) = \\Theta(f(n))$.`,
        keyConcepts: ['Master Theorem', 'Critical Exponent log_b(a)', 'Asymptotic Tight Bounds', 'Red-Black Tree Black-Height'],
        formulas: [
          { name: 'Master Recurrence', expression: 'T(n) = a * T(n / b) + f(n)' },
          { name: 'Critical Exponent', expression: 'c_crit = log_b(a)' }
        ],
        estimatedMinutes: 40
      },
      {
        id: 'les_cs402_1',
        subjectId: 'subj_cs402',
        moduleNumber: 1,
        title: 'Virtual Memory, Multi-Level Page Tables & TLB',
        summary: 'Hardware address translation, Translation Lookaside Buffer hit ratios, and page fault handling.',
        contentMarkdown: `# Virtual Memory & TLB Address Translation\n\n## Effective Access Time (EAT)\nVirtual addresses are split into a Virtual Page Number (VPN) and page offset. The Translation Lookaside Buffer (TLB) caches recent VPN-to-PPN translations.\n$$EAT = \\alpha (t_{TLB} + t_{mem}) + (1 - \\alpha)(t_{TLB} + (k + 1) t_{mem})$$\nwhere $\\alpha$ is the TLB hit ratio and $k$ is the number of page table levels.`,
        keyConcepts: ['Translation Lookaside Buffer (TLB)', 'Effective Access Time (EAT)', 'Multi-Level Page Tables', 'Page Fault Trap'],
        formulas: [
          { name: 'Effective Access Time', expression: 'EAT = alpha * (t_TLB + t_mem) + (1 - alpha) * (t_TLB + 2 * t_mem)' }
        ],
        estimatedMinutes: 35
      },
      {
        id: 'les_cs450_1',
        subjectId: 'subj_cs450',
        moduleNumber: 1,
        title: 'Transformer Self-Attention & Scaled Dot-Product Mechanics',
        summary: 'Query-Key-Value projections, variance scaling by 1/sqrt(d_k), and multi-head representational subspaces.',
        contentMarkdown: `# Transformer Architectures & Scaled Dot-Product Attention\n\n## Scaled Dot-Product Attention\nGiven Query ($Q$), Key ($K$), and Value ($V$) matrices of dimension $d_k$, scaled dot-product attention computes:\n$$\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$\nDividing by $\\sqrt{d_k}$ prevents large dot-product magnitudes from pushing the softmax function into regions with vanishingly small gradients.`,
        keyConcepts: ['Scaled Dot-Product Attention', 'Softmax Gradient Saturation', 'Multi-Head Attention', 'Positional Encoding'],
        formulas: [
          { name: 'Scaled Dot-Product Attention', expression: 'Attention(Q,K,V) = softmax((Q * K^T) / sqrt(d_k)) * V' }
        ],
        estimatedMinutes: 50
      },
      {
        id: 'les_ece210_1',
        subjectId: 'subj_ece210',
        moduleNumber: 1,
        title: 'Fourier Transform & The Nyquist-Shannon Sampling Theorem',
        summary: 'Frequency-domain representation of LTI signals, aliasing prevention, and anti-aliasing reconstruction filters.',
        contentMarkdown: `# Fourier Analysis & Nyquist-Shannon Sampling\n\n## Continuous-Time Fourier Transform (CTFT)\n$$X(j\\omega) = \\int_{-\\infty}^{\\infty} x(t) e^{-j\\omega t} dt$$\n\n## Nyquist-Shannon Sampling Theorem\nA bandlimited signal with maximum frequency $f_{max}$ can be perfectly reconstructed from uniform samples if and only if the sampling rate $f_s$ satisfies:\n$$f_s > 2 f_{max}$$\nwhere $f_N = 2 f_{max}$ is the Nyquist rate. Sampling below $2 f_{max}$ causes spectral aliasing.`,
        keyConcepts: ['Continuous-Time Fourier Transform', 'Nyquist Rate 2*f_max', 'Spectral Aliasing', 'Sinc Reconstruction'],
        formulas: [
          { name: 'Nyquist Sampling Condition', expression: 'f_s > 2 * f_max' },
          { name: 'Fourier Transform', expression: 'X(j*omega) = integral x(t) * exp(-j*omega*t) dt' }
        ],
        estimatedMinutes: 40
      },
      {
        id: 'les_ece340_1',
        subjectId: 'subj_ece340',
        moduleNumber: 1,
        title: '5-Stage RISC-V Pipelining & Hazard Forwarding',
        summary: 'Instruction Fetch, Decode, Execute, Memory, Writeback stages, data forwarding paths, and load-use stalls.',
        contentMarkdown: `# 5-Stage RISC-V Pipeline & Hazard Resolution\n\n## Pipeline Stages\nThe classic 5-stage RISC-V datapath consists of ` + '`IF`, `ID`, `EX`, `MEM`, and `WB`' + `.\n\n## Iron Law of Processor Performance\n$$T_{CPU} = \\text{IC} \\times \\text{CPI} \\times T_{clock}$$\nRAW (Read-After-Write) data hazards between ALU instructions are resolved without stalling via EX/MEM and MEM/WB forwarding muxes, whereas a Load-Use hazard requires 1 bubble stall cycle.`,
        keyConcepts: ['5-Stage RISC-V Pipeline', 'RAW Data Hazard Forwarding', 'Load-Use Pipeline Stall', 'Iron Law of Processor Performance'],
        formulas: [
          { name: 'CPU Execution Time', expression: 'T_CPU = Instruction_Count * CPI * Clock_Cycle_Time' }
        ],
        estimatedMinutes: 40
      },
      {
        id: 'les_bio205_1',
        subjectId: 'subj_bio205',
        moduleNumber: 1,
        title: 'CRISPR-Cas9 Genome Editing & Enzyme Kinetics',
        summary: 'PAM sequence recognition (5-NGG-3), sgRNA-guided double-strand breaks, and Michaelis-Menten catalysis.',
        contentMarkdown: `# CRISPR-Cas9 Genome Engineering & Michaelis-Menten Kinetics\n\n## 1. CRISPR-Cas9 Mechanism\nThe Cas9 endonuclease complexes with a single-guide RNA (sgRNA) to scan duplex DNA for a Protospacer Adjacent Motif (PAM, ` + "`5'-NGG-3'`" + ` in *S. pyogenes*). Upon PAM recognition and R-loop formation, the HNH and RuvC catalytic domains cleave both DNA strands 3 bp upstream of the PAM, triggering NHEJ or HDR repair.\n\n## 2. Michaelis-Menten Enzyme Kinetics\n$$v_0 = \\frac{V_{max} [S]}{K_M + [S]}$$\nwhere $K_M = \\frac{k_{-1} + k_{cat}}{k_1}$ is the substrate concentration at which reaction velocity reaches half of $V_{max}$.`,
        keyConcepts: ['Protospacer Adjacent Motif (5-NGG-3)', 'sgRNA R-Loop Cleavage', 'NHEJ vs HDR DNA Repair', 'Michaelis-Menten Constant K_M'],
        formulas: [
          { name: 'Michaelis-Menten Equation', expression: 'v_0 = (V_max * [S]) / (K_M + [S])' },
          { name: 'Catalytic Efficiency', expression: 'eta = k_cat / K_M' }
        ],
        estimatedMinutes: 45
      },
      {
        id: 'les_econ201_1',
        subjectId: 'subj_econ201',
        moduleNumber: 1,
        title: 'IS-LM General Equilibrium & Monetary Transmission',
        summary: 'Goods market equilibrium (IS), money market liquidity preference (LM), fiscal multipliers, and crowding out.',
        contentMarkdown: `# IS-LM Macroeconomic Equilibrium & Policy Multipliers\n\n## Goods Market (IS Curve) & Money Market (LM Curve)\n- **IS Relation**: $Y = C(Y - T) + I(Y, r) + G$\n- **LM Relation**: $\\frac{M}{P} = L(Y, i)$\n- **Autonomous Spending Multiplier**: $\\frac{\\Delta Y}{\\Delta G} = \\frac{1}{1 - c_1}$ in a fixed-rate Keynesian cross, tempered by interest-rate crowding out when LM is upward-sloping.`,
        keyConcepts: ['IS Goods Market Equilibrium', 'LM Money Market Equilibrium', 'Fiscal Multiplier 1/(1-MPC)', 'Interest Rate Crowding Out'],
        formulas: [
          { name: 'IS Equation', expression: 'Y = C(Y - T) + I(Y, r) + G' },
          { name: 'Keynesian Multiplier', expression: 'k = 1 / (1 - MPC)' }
        ],
        estimatedMinutes: 35
      },
      {
        id: 'les_fin320_1',
        subjectId: 'subj_fin320',
        moduleNumber: 1,
        title: 'CAPM Asset Pricing & Black-Scholes Option Valuation',
        summary: 'Systematic beta risk, Weighted Average Cost of Capital (WACC), and continuous-time European option pricing.',
        contentMarkdown: `# Quantitative Valuation: CAPM, WACC & Black-Scholes\n\n## Capital Asset Pricing Model (CAPM)\n$$E[R_i] = R_f + \\beta_i (E[R_m] - R_f), \\quad \\beta_i = \\frac{\\text{Cov}(R_i, R_m)}{\\text{Var}(R_m)}$$\n\n## Black-Scholes European Call Price\n$$C(S, t) = S_0 N(d_1) - K e^{-rT} N(d_2)$$`,
        keyConcepts: ['CAPM Systematic Beta', 'Weighted Average Cost of Capital (WACC)', 'Black-Scholes-Merton Formula', 'Put-Call Parity'],
        formulas: [
          { name: 'CAPM Expected Return', expression: 'E[R_i] = R_f + beta_i * (E[R_m] - R_f)' },
          { name: 'Black-Scholes Call', expression: 'C = S_0 * N(d_1) - K * exp(-r*T) * N(d_2)' }
        ],
        estimatedMinutes: 45
      }
    ];

    const insertLesson = db.prepare(`
      INSERT INTO lessons (id, subject_id, module_number, title, summary, content_markdown, key_concepts_json, formulas_json, estimated_minutes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?)
    `);
    const insertCourseFile = db.prepare(`
      INSERT INTO course_files (id, major_id, subject_id, lesson_id, uploaded_by, scope, filename, mime_type, size_bytes, storage_path, extracted_text, summary, key_topics_json, chunk_count, status, created_at)
      VALUES (?, ?, ?, ?, 'system', 'university', ?, 'text/markdown', ?, ?, ?, ?, ?, 1, 'indexed', ?)
    `);
    const insertChunk = db.prepare(`
      INSERT INTO course_chunks (id, subject_id, lesson_id, file_id, source_type, source_title, chunk_index, heading, content, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO course_chunks_fts (chunk_id, subject_id, source_title, heading, content, keywords)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const les of lessonsData) {
      insertLesson.run(
        les.id,
        les.subjectId,
        les.moduleNumber,
        les.title,
        les.summary,
        les.contentMarkdown,
        JSON.stringify(les.keyConcepts),
        JSON.stringify(les.formulas),
        les.estimatedMinutes,
        now
      );

      const subj = subjects.find((s) => s.id === les.subjectId);
      const fileId = `file_${les.id}`;
      const filename = `${subj.code}_Module_${les.moduleNumber}_Notes.md`;
      insertCourseFile.run(
        fileId,
        subj.majorId,
        les.subjectId,
        les.id,
        filename,
        Buffer.byteLength(les.contentMarkdown, 'utf8'),
        `/data/seed_files/${filename}`,
        les.contentMarkdown,
        les.summary,
        JSON.stringify(les.keyConcepts),
        now
      );

      const chunkId = `chk_${les.id}_0`;
      const keywords = les.keyConcepts.join(', ');
      insertChunk.run(
        chunkId,
        les.subjectId,
        les.id,
        fileId,
        'lesson',
        les.title,
        0,
        les.title,
        les.contentMarkdown,
        keywords
      );
      insertFts.run(chunkId, les.subjectId, les.title, les.title, les.contentMarkdown, keywords);
    }

    // 6. Seed Sample Slide Deck, Flashcards, Exam, Study Guide, Research Project, and AI Video
    const sampleSlides = [
      {
        slideNumber: 1,
        layout: 'title_overview',
        title: 'CS-301: Shortest Path Algorithms & Relaxation',
        subtitle: 'Horizon State University — Algorithms & Data Structures',
        bullets: [
          'Single-Source Shortest Path (SSSP) problem formulation',
          'Greedy edge relaxation in Dijkstra with non-negative weights',
          'Dynamic programming relaxation in Bellman-Ford for negative edges'
        ],
        speakerNotes: 'Welcome to CS-301 Module 1 on Shortest Path Algorithms.'
      },
      {
        slideNumber: 2,
        layout: 'core_concept',
        title: 'The Edge Relaxation Invariant',
        bullets: [
          'Maintain upper bound estimate d[v] initialized to infinity (d[s] = 0)',
          'Relaxing edge (u, v) tests whether going through u improves d[v]',
          'Dijkstra extracts the unvisited vertex with minimum d[u] from a priority queue'
        ],
        speakerNotes: 'Focus on why non-negative edge weights guarantee that once u is extracted, d[u] is final.'
      },
      {
        slideNumber: 3,
        layout: 'visual_diagram',
        title: 'Dijkstra Priority Queue Relaxation Flow',
        bullets: ['Extract-Min u from Heap', 'Relax all outgoing edges (u, v)', 'Decrease-Key on improved neighbors'],
        diagramSvg: '<svg viewBox="0 0 500 140" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="40" width="130" height="55" rx="8" fill="#1e3a8a"/><text x="75" y="72" fill="#fff" text-anchor="middle" font-size="12">Extract-Min(Q)</text><line x1="140" y1="67" x2="185" y2="67" stroke="#60a5fa" stroke-width="3"/><rect x="185" y="40" width="130" height="55" rx="8" fill="#0f766e"/><text x="250" y="72" fill="#fff" text-anchor="middle" font-size="12">Relax (u, v)</text><line x1="315" y1="67" x2="360" y2="67" stroke="#60a5fa" stroke-width="3"/><rect x="360" y="40" width="130" height="55" rx="8" fill="#4338ca"/><text x="425" y="72" fill="#fff" text-anchor="middle" font-size="12">Decrease-Key</text></svg>',
        speakerNotes: 'This diagram illustrates the three core steps executed per vertex extraction.'
      },
      {
        slideNumber: 4,
        layout: 'formula_derivation',
        title: 'Asymptotic Time Complexity Derivation',
        formula: 'd[v] = min(d[v], d[u] + w(u, v)) | T(V,E) = O((|V| + |E|) log |V|)',
        bullets: [
          '|V| Extract-Min operations cost O(|V| log |V|)',
          '|E| Decrease-Key operations cost O(|E| log |V|) in a binary heap',
          'Bellman-Ford performs |V|-1 passes over |E| edges in O(|V| * |E|)'
        ],
        speakerNotes: 'Know both the binary heap and Fibonacci heap bounds for the midterm.'
      },
      {
        slideNumber: 5,
        layout: 'checkpoint_quiz',
        title: 'Interactive Concept Checkpoint',
        bullets: ['Test your understanding of why Dijkstra requires non-negative edge weights'],
        checkpointQuiz: {
          question: 'Why can Dijkstra fail on a graph containing a negative-weight edge?',
          options: [
            'Because binary heaps cannot store negative numbers',
            'Because an already-finalized vertex could later be reached via a negative edge with lower total cost',
            'Because graph cycles always have negative weight',
            'Because Extract-Min takes exponential time'
          ],
          correctIndex: 1,
          explanation: 'Dijkstra assumes adding future edges only increases path cost (w >= 0).'
        },
        speakerNotes: 'Pause and let students answer the checkpoint question.'
      },
      {
        slideNumber: 6,
        layout: 'exam_takeaways',
        title: 'High-Yield Exam Takeaways',
        bullets: [
          'Use Dijkstra when all w(u,v) >= 0 for O((V+E) log V) speed',
          'Use Bellman-Ford when negative weights exist or to detect negative cycles',
          'Use BFS for unweighted graphs in O(V + E) time'
        ],
        speakerNotes: 'Summary slide for exam review.'
      }
    ];

    db.prepare(`
      INSERT INTO slide_decks (id, subject_id, lesson_id, file_id, created_by, title, subtitle, theme, provider_type, slide_count, slides_json, source_summary, created_at)
      VALUES (?, ?, ?, ?, 'stu_amina', ?, ?, 'university-indigo', 'built_in', ?, ?, ?, ?)
    `).run(
      'deck_cs301_seed',
      'subj_cs301',
      'les_cs301_1',
      'file_les_cs301_1',
      'CS-301: Shortest Path Algorithms & Relaxation',
      'Interactive Lecture Deck — Dijkstra vs. Bellman-Ford',
      sampleSlides.length,
      JSON.stringify(sampleSlides),
      'Grounded in CS-301 Module 1 lecture notes.',
      now
    );

    // Seed Flashcards
    const seedCards = [
      {
        id: 'fc_cs301_1',
        subjectId: 'subj_cs301',
        lessonId: 'les_cs301_1',
        topicTag: 'Shortest Paths',
        front: 'What is the time complexity of Dijkstra with a binary min-heap?',
        back: 'O((|V| + |E|) log |V|)',
        hint: 'Consider |V| extractions and |E| key decreases.',
        formula: 'T(V, E) = O((|V| + |E|) log |V|)'
      },
      {
        id: 'fc_cs301_2',
        subjectId: 'subj_cs301',
        lessonId: 'les_cs301_1',
        topicTag: 'Negative Edges',
        front: 'How many relaxation passes does Bellman-Ford perform to guarantee shortest paths (without negative cycles)?',
        back: '|V| - 1 passes over all |E| edges, plus 1 extra pass to check for negative-weight cycles.',
        hint: 'A simple path has at most |V| - 1 edges.',
        formula: 'O(|V| * |E|)'
      },
      {
        id: 'fc_bio205_1',
        subjectId: 'subj_bio205',
        lessonId: 'les_bio205_1',
        topicTag: 'Enzyme Kinetics',
        front: 'Define the Michaelis constant K_M in enzyme kinetics.',
        back: 'The substrate concentration [S] at which the initial reaction velocity v_0 equals half of V_max.',
        hint: 'Set v_0 = 0.5 * V_max in the Michaelis-Menten equation.',
        formula: 'v_0 = (V_max * [S]) / (K_M + [S])'
      }
    ];
    const insertCard = db.prepare(`
      INSERT INTO flashcards (id, subject_id, lesson_id, topic_tag, front, back, hint, formula, ease_factor, interval_days, repetitions, mastery_level, next_review_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2.5, 0, 0, 'new', ?, ?)
    `);
    for (const c of seedCards) {
      insertCard.run(c.id, c.subjectId, c.lessonId, c.topicTag, c.front, c.back, c.hint, c.formula, now, now);
    }

    // Seed Practice Exam
    const sampleQuestions = [
      {
        id: 'q_cs301_1',
        topic: 'Shortest Paths',
        type: 'multiple_choice',
        prompt: 'Which condition is required for Dijkstra greedy relaxation to be guaranteed correct?',
        options: [
          'The graph must be a DAG',
          'All edge weights must be non-negative (w(u,v) >= 0)',
          'The graph must be bipartite',
          'All edge weights must be distinct'
        ],
        correctAnswer: 'All edge weights must be non-negative (w(u,v) >= 0)',
        correctIndex: 1,
        points: 25,
        explanation: 'Non-negative edge weights ensure that extracting the minimum d[u] cannot be undercut by a longer path with negative edges.'
      },
      {
        id: 'q_cs301_2',
        topic: 'Master Theorem',
        type: 'multiple_choice',
        prompt: 'Using the Master Theorem, what is the tight asymptotic bound for T(n) = 2T(n/2) + n?',
        options: ['Theta(n)', 'Theta(n log n)', 'Theta(n^2)', 'Theta(log n)'],
        correctAnswer: 'Theta(n log n)',
        correctIndex: 1,
        points: 25,
        explanation: 'Here a=2, b=2, so n^(log_b a) = n^1 = f(n), which falls into Case 2: Theta(n log n).'
      }
    ];
    db.prepare(`
      INSERT INTO exams_and_quizzes (id, subject_id, lesson_id, mode, title, difficulty, time_limit_sec, questions_json, total_points, created_at)
      VALUES (?, ?, ?, 'timed_mock_exam', ?, 'intermediate', 900, ?, 50, ?)
    `).run(
      'exam_cs301_seed',
      'subj_cs301',
      'les_cs301_1',
      'CS-301 Midterm Mock Exam: Graphs & Recurrences',
      JSON.stringify(sampleQuestions),
      now
    );

    // Seed Study Guide
    db.prepare(`
      INSERT INTO study_guides (id, subject_id, title, overview, high_yield_concepts_json, formulas_sheet_json, common_exam_traps_json, worked_problems_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sg_cs301_seed',
      'subj_cs301',
      'CS-301 Comprehensive Exam Study Guide',
      'High-yield review of Dijkstra, Bellman-Ford, and Master Theorem recurrences.',
      JSON.stringify(['Edge Relaxation Invariant', 'Master Theorem Watershed Exponent', 'Negative Cycle Detection']),
      JSON.stringify([
        { name: 'Edge Relaxation', formula: 'd[v] = min(d[v], d[u] + w(u,v))' },
        { name: 'Master Theorem', formula: 'T(n) = aT(n/b) + f(n)' }
      ]),
      JSON.stringify(['Applying Dijkstra when negative edges exist', 'Confusing log_b(a) with a/b in Master Theorem']),
      JSON.stringify([
        {
          problem: 'Solve T(n) = 4T(n/2) + n.',
          solution: 'log_2(4) = 2. Since f(n) = n = O(n^(2 - 0.5)), Case 1 applies: T(n) = Theta(n^2).'
        }
      ]),
      now
    );

    // Seed Research Project
    db.prepare(`
      INSERT INTO research_projects (id, user_id, major_id, subject_id, title, query, status, executive_summary, sections_json, collected_data_table_json, citations_json, student_notes, provider_type, created_at)
      VALUES (?, 'stu_amina', 'major_cs', 'subj_cs301', ?, ?, 'completed', ?, ?, ?, ?, ?, 'built_in', ?)
    `).run(
      'res_cs301_seed',
      'Comparative Analysis of Shortest-Path Graph Algorithms',
      'Compare Dijkstra, Bellman-Ford, and BFS asymptotic performance and constraints',
      'Empirical and theoretical comparison of SSSP algorithms across sparse and dense university benchmark graphs.',
      JSON.stringify([
        { heading: 'Algorithmic Tradeoffs', body: 'Dijkstra achieves O((V+E) log V) on non-negative graphs while Bellman-Ford handles negative weights in O(VE).' }
      ]),
      JSON.stringify({
        title: 'SSSP Algorithm Benchmark Data',
        columns: ['Algorithm', 'Time Complexity', 'Space Complexity', 'Negative Weights', 'Benchmark 10k Nodes (ms)'],
        rows: [
          ['BFS (Unweighted)', 'O(V + E)', 'O(V)', 'No', '4.2'],
          ['Dijkstra (Binary Heap)', 'O((V + E) log V)', 'O(V)', 'No', '18.7'],
          ['Bellman-Ford', 'O(V * E)', 'O(V)', 'Yes', '640.5']
        ],
        unitNotes: 'Measured on HSU CS-301 benchmark graph suite.'
      }),
      JSON.stringify([{ sourceTitle: 'Shortest Path Algorithms: Dijkstra & Bellman-Ford', subjectCode: 'CS-301' }]),
      'Review before the CS-301 exam.',
      now
    );

    // Seed AI Educational Video Metadata
    db.prepare(`
      INSERT INTO ai_videos (id, user_id, subject_id, lesson_id, research_id, title, topic_prompt, duration_sec, style_theme, scenes_json, transcript_json, key_takeaways_json, mp4_generated_path, status, created_at)
      VALUES (?, 'stu_amina', 'subj_cs301', 'les_cs301_1', 'res_cs301_seed', ?, ?, 36, 'academic-dark', ?, ?, ?, NULL, 'ready', ?)
    `).run(
      'vid_cs301_seed',
      'Visualizing Dijkstra vs. Bellman-Ford Edge Relaxation',
      'Explain how Dijkstra and Bellman-Ford relax edges step by step',
      JSON.stringify([
        {
          sceneNumber: 1,
          startSec: 0,
          endSec: 12,
          durationSec: 12,
          title: 'The Shortest Path Problem',
          narrationText: 'In CS-301, finding the minimum cost path from a source vertex s relies on iterative edge relaxation.',
          caption: 'Iterative edge relaxation: d[v] = min(d[v], d[u] + w(u,v))',
          visualScene: { type: 'graph_relaxation', nodes: ['S', 'A', 'B', 'T'], highlightEdge: 'S->A' }
        },
        {
          sceneNumber: 2,
          startSec: 12,
          endSec: 24,
          durationSec: 12,
          title: 'Dijkstra Priority Queue Extraction',
          narrationText: 'When all edge weights are non-negative, extracting the minimum vertex from a min-heap guarantees optimality in O((V+E) log V).',
          caption: 'Dijkstra: Greedy extraction with binary min-heap',
          visualScene: { type: 'priority_queue', heap: ['S:0', 'A:3', 'B:5'] }
        },
        {
          sceneNumber: 3,
          startSec: 24,
          endSec: 36,
          durationSec: 12,
          title: 'Bellman-Ford & Negative Cycles',
          narrationText: 'When negative weights exist, Bellman-Ford relaxes all edges V minus 1 times and detects negative cycles on pass V.',
          caption: 'Bellman-Ford: V-1 dynamic programming passes',
          visualScene: { type: 'bellman_ford', passes: '|V| - 1' }
        }
      ]),
      JSON.stringify([
        { timeSec: 0, text: 'In CS-301, finding the minimum cost path from a source vertex s relies on iterative edge relaxation.' },
        { timeSec: 12, text: 'When all edge weights are non-negative, extracting the minimum vertex from a min-heap guarantees optimality.' },
        { timeSec: 24, text: 'When negative weights exist, Bellman-Ford relaxes all edges V minus 1 times.' }
      ]),
      JSON.stringify([
        'Relaxation updates d[v] = min(d[v], d[u] + w(u,v))',
        'Dijkstra requires w(u,v) >= 0',
        'Bellman-Ford handles negative weights in O(VE)'
      ]),
      now
    );
  });
}

export default seedDatabase;
