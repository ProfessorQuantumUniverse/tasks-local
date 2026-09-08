import db from '../db.js';
import config from '../config.js';
import {
    randomToken,
    sha256,
    hashSecret,
    verifySecret,
    generateRecoveryCode,
    normalizeRecoveryCode,
} from './crypto.js';

/**
 * Enrollment tokens and recovery codes.
 *
 * Registering a passkey is the one operation that can create access out of
 * nothing, so it always requires one of three proofs:
 *   1. an unused enrollment token (issued on the console, or on first run),
 *   2. an existing session (adding a second device while logged in),
 *   3. a valid recovery code, which mints a short-lived enrollment token.
 */

const MINUTE_MS = 60 * 1000;

export function issueEnrollmentToken({ label = 'manual', ttlMinutes = config.enrollmentTokenTtlMinutes } = {}) {
    const token = randomToken(32);
    const now = new Date();
    db.prepare(
        'INSERT INTO enrollment_tokens (token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(
        sha256(token),
        label,
        now.toISOString(),
        new Date(now.getTime() + ttlMinutes * MINUTE_MS).toISOString(),
    );
    return { token, expiresAt: new Date(now.getTime() + ttlMinutes * MINUTE_MS).toISOString() };
}

/** Validate without consuming: the token is only burned once a passkey exists. */
export function checkEnrollmentToken(token) {
    if (!token || typeof token !== 'string') return null;
    const hash = sha256(token);
    const row = db.prepare('SELECT * FROM enrollment_tokens WHERE token_hash = ?').get(hash);
    if (!row) return null;
    if (row.used_at) return null;
    if (new Date(row.expires_at) <= new Date()) return null;
    return { hash, row };
}

export function consumeEnrollmentToken(hash) {
    if (!hash) return false;
    const info = db
        .prepare('UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
        .run(new Date().toISOString(), hash);
    return info.changes > 0;
}

export function revokeAllEnrollmentTokens() {
    return db.prepare('DELETE FROM enrollment_tokens WHERE used_at IS NULL').run().changes;
}

/** Replace the whole set of recovery codes and return the plaintext once. */
export async function regenerateRecoveryCodes(count = config.recoveryCodeCount) {
    const codes = Array.from({ length: count }, () => generateRecoveryCode());
    const hashes = await Promise.all(codes.map((code) => hashSecret(normalizeRecoveryCode(code))));

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM recovery_codes').run();
        const insert = db.prepare('INSERT INTO recovery_codes (id, code_hash, created_at) VALUES (?, ?, ?)');
        hashes.forEach((hash) => insert.run(randomToken(12), hash, now));
    });
    tx();

    return codes;
}

export function recoveryCodeStatus() {
    const row = db
        .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused FROM recovery_codes')
        .get();
    return { total: row.total || 0, unused: row.unused || 0 };
}

/**
 * Check a recovery code against every unused hash.
 *
 * All candidates are always tried so the work does not depend on where (or
 * whether) a match is found.
 */
export async function redeemRecoveryCode(input) {
    const normalized = normalizeRecoveryCode(input);
    if (normalized.length < 8) return { ok: false };

    const rows = db.prepare('SELECT id, code_hash FROM recovery_codes WHERE used_at IS NULL').all();
    if (rows.length === 0) return { ok: false };

    let matchedId = null;
    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        const matches = await verifySecret(normalized, row.code_hash);
        if (matches && !matchedId) matchedId = row.id;
    }

    if (!matchedId) return { ok: false };

    const info = db
        .prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(new Date().toISOString(), matchedId);
    if (info.changes === 0) return { ok: false };

    return { ok: true };
}
