import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

export const CONFIG = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'unilearn.sqlite'),
  dataDir: process.env.DATA_DIR || path.join(ROOT_DIR, 'data'),
  publicDir: path.join(ROOT_DIR, 'src', 'public'),

  // Cryptographic secrets (deterministic defaults for test reproducibility)
  jwtSecret: process.env.JWT_SECRET || 'hsu-unilearn-hmac-secret-2026-key-998877',
  deviceSecret: process.env.DEVICE_SECRET || 'hsu-device-fingerprint-secret-2026-key',
  encryptionKey: process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

  // University Identity (F1)
  university: {
    id: 'uni_hsu',
    code: 'HSU',
    name: 'Horizon State University',
    motto: 'Knowledge, Integrity, Discovery Across Every Discipline',
    allowedDomains: ['horizon.edu', 'student.horizon.edu', 'novatech.edu']
  },

  // Subscription Plans & Vouchers (F3)
  subscriptionPlans: {
    semester_essential: {
      id: 'semester_essential',
      name: 'Semester Essential',
      priceCents: 1900,
      billingCycle: 'semester',
      maxPcDevices: 1,
      maxPhoneDevices: 1,
      features: [
        'All University Majors & Subjects',
        'Built-In AI Tutor & BYO-AI Hub',
        'Interactive Slide Decks & Exam Prep'
      ]
    },
    annual_scholar: {
      id: 'annual_scholar',
      name: 'Annual Scholar',
      priceCents: 2900,
      billingCycle: 'annual',
      maxPcDevices: 1,
      maxPhoneDevices: 1,
      features: [
        'Everything in Semester Essential',
        'Unlimited Deep Research & Data Collection',
        'AI Educational Video Studio (MP4 + Interactive)',
        'Priority BYO-AI Context Window'
      ]
    },
    department_sponsored: {
      id: 'department_sponsored',
      name: 'Department Sponsored Scholarship',
      priceCents: 0,
      billingCycle: 'annual',
      maxPcDevices: 1,
      maxPhoneDevices: 1,
      voucherRequired: true,
      voucherCode: 'HSU-SCHOLAR-2026',
      features: [
        'Full University Sponsored Access',
        '1 PC + 1 Phone Biometric Security',
        'All AI, Research, Video & Exam Modules'
      ]
    }
  },
  validVouchers: ['HSU-SCHOLAR-2026', 'HORIZON-FREE-2026', 'HORIZON-GRANT-2026', 'HSU-FREE-PASS'],

  // Strict 1-PC + 1-Phone & Facial Auth Parameters (F4, F5)
  security: {
    maxPcDevices: 1,
    maxPhoneDevices: 1,
    slotLeaseSeconds: 60,
    sessionTtlSeconds: 86400,
    challengeTtlSeconds: 600,
    biometricSimilarityThreshold: 0.85,
    embeddingDimensions: 128
  }
};

export default CONFIG;
