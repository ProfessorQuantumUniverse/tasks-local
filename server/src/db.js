import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';

/**
 * SQLite storage. Single file, single user, no ORM.
 *
 * The file is created with 0600 so that only the container's app user can read
 * it; that is the whole at-rest protection by design, disk level encryption is
 * left to the host.
 */

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const dbPath = join(config.dataDir, 'tasks.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

try {
    chmodSync(dbPath, 0o600);
} catch {
    // Some filesystems (bind mounts from exotic hosts) reject chmod; the
    // directory mode still applies, so this is not fatal.
}

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Registered passkeys. Multiple rows = multiple devices for the single owner.
CREATE TABLE IF NOT EXISTS credentials (
    id            TEXT PRIMARY KEY,           -- base64url credential ID
    public_key    BLOB NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,                       -- JSON array
    device_type   TEXT,
    backed_up     INTEGER NOT NULL DEFAULT 0,
    name          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
);

-- Only the SHA-256 of a session token is stored, so a database leak does not
-- hand out usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash    TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    rotated_at    TEXT NOT NULL,
    superseded_at TEXT,                       -- set when rotated away
    credential_id TEXT,
    ip            TEXT,
    user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- WebAuthn challenges live server side and are referenced by an opaque id in a
-- short-lived cookie, so a challenge cannot be chosen by the client.
CREATE TABLE IF NOT EXISTS challenges (
    id                    TEXT PRIMARY KEY,
    challenge             TEXT NOT NULL,
    type                  TEXT NOT NULL,      -- 'registration' | 'authentication'
    expires_at            TEXT NOT NULL,
    enrollment_token_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires_at);

-- One-shot tokens that authorise registering a new passkey.
CREATE TABLE IF NOT EXISTS enrollment_tokens (
    token_hash TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
);

CREATE TABLE IF NOT EXISTS recovery_codes (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    due_date      TEXT,
    progress      INTEGER NOT NULL DEFAULT 0,
    repeat_type   TEXT NOT NULL DEFAULT 'none',
    next_due_date TEXT,
    important     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

-- 'preferences' and 'order' are stored as JSON documents.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Append-only trail of authentication relevant events.
CREATE TABLE IF NOT EXISTS auth_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    event      TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_log_at ON auth_log(at);
`);

db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');

/** Remove rows that are only meaningful while fresh. */
export function pruneExpired() {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare(
        "DELETE FROM enrollment_tokens WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < datetime('now', '-7 days')",
    ).run(now);
    // Keep a bounded audit trail rather than growing forever.
    db.prepare(
        'DELETE FROM auth_log WHERE id NOT IN (SELECT id FROM auth_log ORDER BY id DESC LIMIT 5000)',
    ).run();
}

export function logAuthEvent({ event, outcome, ip, userAgent, detail }) {
    db.prepare(
        'INSERT INTO auth_log (at, event, outcome, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
        new Date().toISOString(),
        event,
        outcome,
        ip || null,
        userAgent ? String(userAgent).slice(0, 256) : null,
        detail ? String(detail).slice(0, 512) : null,
    );
}

export function credentialCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM credentials').get().n;
}

export default db;
