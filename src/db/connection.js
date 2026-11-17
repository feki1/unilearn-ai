import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDatabase(dbPath = ':memory:') {
  if (dbPath && dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath || ':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath && dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // Ignore WAL errors on virtual filesystems
    }
  }
  return db;
}

/**
 * Executes a synchronous callback inside an atomic SQLite BEGIN IMMEDIATE transaction.
 */
export function runImmediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback errors if already rolled back
    }
    throw err;
  }
}

export const runTransaction = runImmediateTransaction;
