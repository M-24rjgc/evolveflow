import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import * as crypto from 'crypto';

export interface Preference {
  key: string;
  value: string;
  updated_at: string;
}

// ── AES-256-GCM Encryption ────────────────────────────────────────
// The API key is encrypted at rest using a key derived from the
// machine hostname via PBKDF2.  This is NOT military-grade security
// (anyone with filesystem + knowledge of the derivation can decrypt),
// but it prevents casual key theft from backup files or DB inspection.

const ENCRYPTED_PREFIX = 'encrypted:';
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32; // AES-256
const SALT = 'evolveflow-v1-key-salt';

function deriveMachineKey(): Buffer {
  const hostname =
    process.env.HOSTNAME ||
    process.env.COMPUTERNAME ||
    'unknown-host';
  return crypto.pbkdf2Sync(
    hostname,
    SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha256',
  );
}

function encryptValue(plaintext: string): string {
  const key = deriveMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return ENCRYPTED_PREFIX + iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptValue(encryptedText: string): string {
  if (!encryptedText.startsWith(ENCRYPTED_PREFIX)) {
    return encryptedText; // Not encrypted (legacy plaintext)
  }
  const stripped = encryptedText.slice(ENCRYPTED_PREFIX.length);
  const parts = stripped.split(':');
  if (parts.length !== 3) {return encryptedText;} // Malformed, return as-is
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const key = deriveMachineKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// ── Service ───────────────────────────────────────────────────────

export class PreferenceService {
  private db: Database.Database;
  private migrated = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrateApiKey();
  }

  /**
   * On startup, check for a legacy plaintext API key and encrypt it.
   * Runs once per process lifetime.
   */
  private migrateApiKey(): void {
    if (this.migrated) {return;}
    this.migrated = true;
    try {
      const row = this.db
        .prepare('SELECT value FROM preferences WHERE key = ?')
        .get('api_key') as { value: string } | undefined;
      if (row && row.value && !isEncrypted(row.value)) {
        const encrypted = encryptValue(row.value);
        const now = new Date().toISOString();
        this.db
          .prepare(
            'UPDATE preferences SET value = ?, updated_at = ? WHERE key = ?',
          )
          .run(encrypted, now, 'api_key');
        console.log('PreferenceService: migrated plaintext api_key to encrypted storage');
      }
    } catch (err) {
      // Migration failure should not crash the app
      console.error('PreferenceService: api_key migration failed', err);
    }
  }

  get(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) {return null;}
    // Auto-decrypt api_key on retrieval
    if (key === 'api_key' && row.value && isEncrypted(row.value)) {
      try {
        return decryptValue(row.value);
      } catch {
        // If decryption fails, return raw value (might be legacy plaintext)
        return row.value;
      }
    }
    return row.value ?? null;
  }

  set(key: string, value: string): void {
    const now = new Date().toISOString();
    // Auto-encrypt api_key on storage
    const storedValue =
      key === 'api_key' && value ? encryptValue(value) : value;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)',
      )
      .run(key, storedValue, now);
  }

  /** Check whether an API key has been configured (encrypted or legacy). */
  hasApiKey(): boolean {
    const row = this.db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get('api_key') as { value: string } | undefined;
    return !!(row && row.value);
  }

  getAll(): Preference[] {
    const rows = this.db
      .prepare('SELECT * FROM preferences ORDER BY key')
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      key: r.key as string,
      value: r.key === 'api_key' ? '(encrypted)' : (r.value as string),
      updated_at: r.updated_at as string,
    }));
  }

  getWorkHours(): { start: string; end: string } {
    return {
      start: this.get('work_hours_start') ?? '09:00',
      end: this.get('work_hours_end') ?? '18:00',
    };
  }

  setWorkHours(start: string, end: string): void {
    this.set('work_hours_start', start);
    this.set('work_hours_end', end);
  }

  recordSignal(
    signalType: string,
    signalData: Record<string, unknown>,
    source: string,
  ): void {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO preference_signals (id, signal_type, signal_data, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id, signalType, JSON.stringify(signalData), source, now);
  }
}
