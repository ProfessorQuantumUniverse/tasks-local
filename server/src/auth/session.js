import db, { logAuthEvent } from '../db.js';
import config from '../config.js';
import { randomToken, sha256 } from './crypto.js';

/**
 * Opaque, server-side sessions.
 *
 * The cookie carries a random token; only its SHA-256 is stored. Tokens rotate
 * periodically so that a token captured once has a bounded useful life, with a
 * short grace window so parallel in-flight requests are not logged out.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function cookieOptions(maxAgeSeconds) {
    return {
        path: '/',
        httpOnly: true,
        secure: config.cookie.secure,
        sameSite: config.cookie.sameSite,
        maxAge: maxAgeSeconds,
        // No domain attribute: required by the __Host- prefix and keeps the
        // cookie from being shared with sibling subdomains.
    };
}

export function createSession(reply, { credentialId, ip, userAgent }) {
    const token = randomToken(32);
    const now = new Date();
    const expires = new Date(now.getTime() + config.session.ttlDays * DAY_MS);

    db.prepare(
        `INSERT INTO sessions (token_hash, created_at, expires_at, rotated_at, credential_id, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        sha256(token),
        now.toISOString(),
        expires.toISOString(),
        now.toISOString(),
        credentialId || null,
        ip || null,
        userAgent ? String(userAgent).slice(0, 256) : null,
    );

    reply.setCookie(config.cookie.session, token, cookieOptions(config.session.ttlDays * 24 * 60 * 60));
    return token;
}

/**
 * Resolve the request's cookie to a live session, rotating the token when it
 * has been in use for longer than the configured window.
 *
 * @returns {{ tokenHash: string } | null}
 */
export function readSession(request, reply) {
    const token = request.cookies?.[config.cookie.session];
    if (!token || typeof token !== 'string') return null;

    const tokenHash = sha256(token);
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;

    const now = new Date();
    if (new Date(row.expires_at) <= now) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
        return null;
    }

    // A superseded token stays usable only for the grace window, so requests
    // that were already in flight during a rotation still succeed.
    if (row.superseded_at) {
        const graceEnds = new Date(new Date(row.superseded_at).getTime() + config.session.rotationGraceSeconds * 1000);
        if (now > graceEnds) {
            db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
            return null;
        }
        return { tokenHash, row };
    }

    const rotateDue = new Date(new Date(row.rotated_at).getTime() + config.session.rotateAfterHours * 60 * 60 * 1000);
    if (reply && now >= rotateDue) {
        return rotate(reply, row, now);
    }

    return { tokenHash, row };
}

function rotate(reply, row, now) {
    const newToken = randomToken(32);
    const newHash = sha256(newToken);
    const expires = new Date(now.getTime() + config.session.ttlDays * DAY_MS);

    const tx = db.transaction(() => {
        db.prepare(
            `INSERT INTO sessions (token_hash, created_at, expires_at, rotated_at, credential_id, ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            newHash,
            row.created_at,
            expires.toISOString(),
            now.toISOString(),
            row.credential_id,
            row.ip,
            row.user_agent,
        );
        db.prepare('UPDATE sessions SET superseded_at = ? WHERE token_hash = ?').run(
            now.toISOString(),
            row.token_hash,
        );
    });
    tx();

    reply.setCookie(config.cookie.session, newToken, cookieOptions(config.session.ttlDays * 24 * 60 * 60));
    return { tokenHash: newHash, row: { ...row, token_hash: newHash } };
}

export function destroySession(request, reply) {
    const token = request.cookies?.[config.cookie.session];
    if (token) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    }
    reply.clearCookie(config.cookie.session, { path: '/' });
}

/** Drop every session except the caller's own. */
export function destroyOtherSessions(currentTokenHash) {
    const info = db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(currentTokenHash);
    return info.changes;
}

export function destroyAllSessions() {
    return db.prepare('DELETE FROM sessions').run().changes;
}

/**
 * Rate limit the rejection log.
 *
 * The audit trail is capped at 5000 rows, so an unauthenticated caller that got
 * one entry per rejected request could push every genuine security event out of
 * it within minutes. One entry per source per minute keeps the signal ("a token
 * this server does not accept was presented") without the eviction.
 */
const REJECT_LOG_WINDOW_MS = 60 * 1000;
const REJECT_LOG_MAX_KEYS = 1024;
const rejectLoggedAt = new Map();

function shouldLogReject(ip) {
    const now = Date.now();

    if (rejectLoggedAt.size >= REJECT_LOG_MAX_KEYS) {
        for (const [key, at] of rejectLoggedAt) {
            if (now - at >= REJECT_LOG_WINDOW_MS) rejectLoggedAt.delete(key);
        }
        // Still full: every entry is fresh, so this is an active flood and the
        // one-per-window guarantee matters more than per-source accuracy.
        if (rejectLoggedAt.size >= REJECT_LOG_MAX_KEYS) return false;
    }

    const last = rejectLoggedAt.get(ip);
    if (last !== undefined && now - last < REJECT_LOG_WINDOW_MS) return false;
    rejectLoggedAt.set(ip, now);
    return true;
}

/**
 * Fastify preHandler that rejects unauthenticated requests.
 * Attaches `request.session` on success.
 */
export function requireSession(request, reply, done) {
    const session = readSession(request, reply);
    if (!session) {
        // A request with no session cookie at all is just a browser that is not
        // signed in, and says nothing. A cookie the server refuses does.
        const presentedToken = !!request.cookies?.[config.cookie.session];
        if (presentedToken && shouldLogReject(request.ip || 'unknown')) {
            logAuthEvent({
                event: 'session.reject',
                outcome: 'denied',
                ip: request.ip,
                userAgent: request.headers['user-agent'],
                detail: `${request.method} ${request.url}`,
            });
        }
        reply.code(401).send({ error: 'unauthenticated' });
        return;
    }
    request.session = session;
    done();
}

export { cookieOptions };
