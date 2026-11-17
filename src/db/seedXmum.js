import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function seedXmumCurriculum(db, { hashPassword, generateDeterministicEmbedding }) {
  const existingMajor = db.prepare('SELECT id FROM majors WHERE code = ?').get('ERA');
  if (existingMajor) return;

  db.prepare(`
    INSERT INTO majors (id, code, name, faculty, description, icon)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'major_era',
    'ERA',
    'Bachelor of Robotics and Automation Engineering (XMUM)',
    'School of Electrical Engineering & Artificial Intelligence (Xiamen University Malaysia)',
    'Robotics, Artificial Intelligence, Digital Logic Design, Electrical Machines & Power, C Programming, Electronics, and Engineering Mathematics.',
    'bot'
  );

  const xmumSubjects = [
    {
      id: 'subj_era121',
      code: 'ERA121',
      title: 'Principles of Artificial Intelligence',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'Dr. Tony Hii Chang Soon (tony.hii@xmu.edu.my)',
      syllabusSummary:
        'Intelligent agents, uninformed search (BFS, DFS, UCS, Branch & Bound), heuristic & A* search, hill climbing, simulated annealing, genetic algorithms, and problem formulation.',
      lesson: {
        id: 'les_era121_1',
        title: 'Uninformed, Heuristic & Local Search Algorithms',
        summary: 'BFS, DFS, Uniform Cost Search, A* Search, Hill Climbing, Simulated Annealing, and Genetic Algorithms.',
        contentMarkdown:
          '# ERA121 Principles of Artificial Intelligence\n\n## Search Strategies\n- **Uninformed Search**: BFS (complete, optimal for unit cost), DFS (low memory), Uniform Cost Search (expands lowest path cost g(n)), Branch & Bound.\n- **Heuristic Search**: Greedy Best-First f(n)=h(n), A* Search f(n)=g(n)+h(n) (optimal if h is admissible and consistent).\n- **Local Search**: Hill Climbing, Simulated Annealing (accepts worse moves with probability exp(-ΔE/T)), Genetic Algorithms (selection, crossover, mutation).',
        keyConcepts: ['Uniform Cost Search', 'A* Search', 'Admissible Heuristic', 'Simulated Annealing', 'Genetic Algorithms'],
        formulas: ['f(n) = g(n) + h(n)', 'P(accept) = exp(-deltaE / T)']
      }
    },
    {
      id: 'subj_era122',
      code: 'ERA122',
      title: 'Introduction to Machines and Power Systems',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'XMUM Electrical & Robotics Faculty',
      syllabusSummary:
        'Machinery principles, magnetic fields, Faraday law, rotational motion, three-phase AC circuits (Y-Delta), and single-phase/three-phase transformers.',
      lesson: {
        id: 'les_era122_1',
        title: 'Three-Phase Circuits & Transformer Equivalent Models',
        summary: 'Balanced Y-Delta power relationships, magnetic circuits, induced voltage, and transformer turns ratio.',
        contentMarkdown:
          '# ERA122 Introduction to Machines and Power Systems\n\n## Core Laws & Relationships\n- **Rotational Power**: P = tau * omega, where 1 rpm = 2*pi/60 rad/s and 1 hp = 746 W.\n- **Faraday Law**: e_ind = -N * dPhi/dt; induced force F = i(l x B).\n- **Three-Phase Balanced Power**: P = sqrt(3) * V_L * I_L * cos(theta); Y-connection V_L = sqrt(3)*V_phi; Delta-connection I_L = sqrt(3)*I_phi.\n- **Transformers**: Ideal turns ratio a = N_p / N_s = V_p / V_s = I_s / I_p.',
        keyConcepts: ['Faraday Law', 'Three-Phase Y-Delta', 'Turns Ratio', 'Magnetic Flux'],
        formulas: ['P = sqrt(3) * V_L * I_L * cos(theta)', 'V_p / V_s = N_p / N_s']
      }
    },
    {
      id: 'subj_era123',
      code: 'ERA123',
      title: 'Digital Logic Design',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'Dr. Norhayati binti Mohd Zainee',
      syllabusSummary:
        'Number systems, Boolean algebra, Karnaugh maps (K-map), Quine-McCluskey minimization, combinational logic (MUX, decoders), VHDL, flip-flops, shift registers, and synchronous/asynchronous counters.',
      lesson: {
        id: 'les_era123_1',
        title: 'Boolean Minimization, K-Maps, Combinational & Sequential Logic',
        summary: 'De Morgan theorems, SOP/POS, K-Map & Quine-McCluskey simplification, 4-to-1 MUX, 3-to-8 Decoder, and counters.',
        contentMarkdown:
          '# ERA123 Digital Logic Design\n\n## Minimization & Design\n- **Boolean Algebra & De Morgan**: (A + B)\' = A\'B\', (AB)\' = A\' + B\'.\n- **Karnaugh Maps & Quine-McCluskey**: Systematic grouping of minterms (1, 2, 4, 8) to find minimal Sum-of-Products (SOP) and prime implicants.\n- **Combinational Circuits & VHDL**: 3-to-8 Decoders, 4-to-1 Multiplexers, Half/Full Adders implemented in VHDL (`andgate.vhd`, `mux4to1.vhd`, `decoder3to8.vhd`).\n- **Sequential Logic**: D/JK flip-flops, Shift Registers, Synchronous & Asynchronous Counters.',
        keyConcepts: ['Boolean Algebra', 'Karnaugh Map', 'Quine-McCluskey', 'Multiplexer & Decoder', 'Synchronous Counters'],
        formulas: ['(A + B)\' = A\' * B\'', 'Minterms = 2^n']
      }
    },
    {
      id: 'subj_era124',
      code: 'ERA124',
      title: 'Programming C',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'Dr. Hew Soon Hin',
      syllabusSummary:
        'C fundamentals, data types, operators, control flow (if/else, switch, loops), functions & modular program structure, arrays, and pointers.',
      lesson: {
        id: 'les_era124_1',
        title: 'Control Flow, Functions, Arrays & Pointers in C',
        summary: 'Modular C programming with header files, pass-by-value vs pass-by-reference pointers, and array traversal.',
        contentMarkdown:
          '# ERA124 Programming C\n\n## Core C Programming Concepts\n- **Control Flow**: `if/else`, `switch`, `for`, `while`, `do-while` loops for algorithmic problem solving.\n- **Functions & Multi-File Structure**: Separating declarations in `.h` headers (`farm.h`, `strawberry.h`) and implementations across `.c` modules (`GetInput.c`, `Calculate.c`, `Display.c`).\n- **Arrays & Pointers**: Contiguous memory indexing `arr[i] == *(arr + i)`, pointer arithmetic, and passing pointers to mutate caller variables.',
        keyConcepts: ['Control Flow', 'Modular C Headers', 'Arrays', 'Pointers & Memory'],
        formulas: ['*(arr + i) == arr[i]', 'sizeof(type) * length']
      }
    },
    {
      id: 'subj_era125',
      code: 'ERA125',
      title: 'Electronics 2',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'XMUM Electronics Faculty',
      syllabusSummary:
        'BJT & MOSFET small-signal amplifiers, frequency response, operational amplifiers, feedback topologies, and power electronics.',
      lesson: {
        id: 'les_era125_1',
        title: 'Transistor Amplifiers, Op-Amps & Frequency Response',
        summary: 'Small-signal AC modeling, gain-bandwidth product, and negative feedback amplifier stability.',
        contentMarkdown:
          '# ERA125 Electronics 2\n\n## Analog & Amplifier Design\n- **BJT & MOSFET Small-Signal Models**: Transconductance g_m, input/output impedance, Common-Emitter and Common-Source gain.\n- **Operational Amplifiers**: Inverting, non-inverting, summing, and differential configurations with virtual short assumption.\n- **Frequency Response**: Low-frequency coupling poles and high-frequency parasitic capacitance roll-off.',
        keyConcepts: ['Small-Signal Model', 'Op-Amp Feedback', 'Gain-Bandwidth Product'],
        formulas: ['A_v = -g_m * (R_C || r_o)', 'GBW = A_0 * f_3dB']
      }
    },
    {
      id: 'subj_era126',
      code: 'ERA126',
      title: 'Engineering Maths 2',
      semester: 'Semester 2 (2026/09)',
      credits: 3,
      instructor: 'XMUM Mathematics Faculty',
      syllabusSummary:
        'Multivariable calculus, partial derivatives, multiple integrals, vector calculus, ordinary differential equations, and Laplace transforms.',
      lesson: {
        id: 'les_era126_1',
        title: 'Differential Equations, Laplace Transforms & Multivariable Calculus',
        summary: 'Solving 2nd-order ODEs via characteristic equations and Laplace s-domain transforms.',
        contentMarkdown:
          '# ERA126 Engineering Maths 2\n\n## Analytical Engineering Methods\n- **Second-Order Linear ODEs**: Characteristic roots (real distinct, repeated, complex conjugate) for damped harmonic systems.\n- **Laplace Transforms**: Converting time-domain differential equations into algebraic s-domain equations: L{f\'(t)} = sF(s) - f(0).\n- **Vector Calculus**: Gradient, divergence, curl, and surface/line integrals.',
        keyConcepts: ['2nd-Order ODEs', 'Laplace Transform', 'Partial Derivatives', 'Vector Calculus'],
        formulas: ['L{f\'(t)} = sF(s) - f(0)', 'nabla f = (df/dx, df/dy, df/dz)']
      }
    }
  ];

  const insertSubject = db.prepare(`
    INSERT INTO subjects (id, major_id, code, title, semester, credits, instructor, syllabus_summary)
    VALUES (?, 'major_era', ?, ?, ?, ?, ?, ?)
  `);
  const insertLesson = db.prepare(`
    INSERT INTO lessons (id, subject_id, module_number, title, summary, content_markdown, key_concepts_json, formulas_json, estimated_minutes, created_by)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 45, 'system')
  `);
  const insertChunk = db.prepare(`
    INSERT INTO course_chunks (id, subject_id, lesson_id, file_id, source_type, source_title, chunk_index, heading, content, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO course_chunks_fts (chunk_id, subject_id, source_title, heading, content, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const subjectIdByCode = {};
  for (const s of xmumSubjects) {
    subjectIdByCode[s.code] = s.id;
    insertSubject.run(s.id, s.code, s.title, s.semester, s.credits, s.instructor, s.syllabusSummary);
    insertLesson.run(
      s.lesson.id,
      s.id,
      s.lesson.title,
      s.lesson.summary,
      s.lesson.contentMarkdown,
      JSON.stringify(s.lesson.keyConcepts),
      JSON.stringify(s.lesson.formulas)
    );
    const chkId = `chk_${s.lesson.id}`;
    const kw = s.lesson.keyConcepts.join(', ');
    insertChunk.run(chkId, s.id, s.lesson.id, null, 'lesson', s.lesson.title, 0, s.lesson.title, s.lesson.contentMarkdown, kw);
    insertFts.run(chkId, s.id, s.lesson.title, s.lesson.title, s.lesson.contentMarkdown, kw);
  }

  // Load extracted XMUM curriculum files
  const jsonPath = path.join(__dirname, 'xmum_curriculum.json');
  if (fs.existsSync(jsonPath)) {
    const items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const insertFile = db.prepare(`
      INSERT INTO course_files (id, major_id, subject_id, uploaded_by, scope, filename, mime_type, size_bytes, extracted_text, summary, key_topics_json, chunk_count, status)
      VALUES (?, 'major_era', ?, 'system', 'university', ?, ?, ?, ?, ?, ?, 1, 'indexed')
    `);

    items.forEach((it, idx) => {
      const subjectId = subjectIdByCode[it.subjectCode];
      if (!subjectId || !it.excerpt) return;
      const fileId = `xmum_file_${idx + 1}`;
      const chunkId = `xmum_chk_${idx + 1}`;
      const summary = it.excerpt.slice(0, 220);
      insertFile.run(
        fileId,
        subjectId,
        it.filename,
        it.mimeType || 'application/pdf',
        Buffer.byteLength(it.excerpt, 'utf8'),
        it.excerpt,
        summary,
        JSON.stringify([it.subjectCode, 'XMUM', 'Semester 2'])
      );
      insertChunk.run(
        chunkId,
        subjectId,
        null,
        fileId,
        'file',
        it.filename,
        0,
        it.filename,
        it.excerpt,
        `${it.subjectCode}, XMUM, ${it.filename}`
      );
      insertFts.run(
        chunkId,
        subjectId,
        it.filename,
        it.filename,
        it.excerpt,
        `${it.subjectCode}, XMUM, ${it.filename}`
      );
    });
  }

  // Seed XMUM student account (feki@xmu.edu.my)
  const existingFeki = db.prepare('SELECT id FROM students WHERE email = ?').get('feki@xmu.edu.my');
  if (!existingFeki) {
    const stuId = 'stu_feki_xmum';
    db.prepare(`
      INSERT INTO students (id, university_id, student_number, email, full_name, password_hash, role, major_id, year_level)
      VALUES (?, 'uni_hsu', 'XMUM-ERA-2026', 'feki@xmu.edu.my', 'Mohamed Seddik Feki', ?, 'student', 'major_era', 1)
    `).run(stuId, hashPassword('UniPass2026!'));

    db.prepare(`
      INSERT INTO subscriptions (id, student_id, plan_id, status, price_cents, max_pc_devices, max_phone_devices, voucher_code, payment_method)
      VALUES ('sub_feki_xmum', ?, 'annual_scholar', 'active', 2900, 1, 1, 'HSU-SCHOLAR-2026', 'card')
    `).run(stuId);

    db.prepare(`
      INSERT INTO student_biometrics (student_id, face_embedding_json, similarity_threshold, capture_mode, status)
      VALUES (?, ?, 0.85, 'simulated', 'enrolled')
    `).run(stuId, JSON.stringify(generateDeterministicEmbedding('feki@xmu.edu.my', 128)));
  }
}
