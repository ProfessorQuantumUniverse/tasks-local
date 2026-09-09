import config from '../config.js';
import db, { credentialCount, logAuthEvent } from '../db.js';
import { noStore } from '../security.js';
import {
    createSession,
    destroySession,
    destroyAllSessions,
    destroyOtherSessions,
    readSession,
    requireSession,
} from '../auth/session.js';
import {
    buildRegistrationOptions,
    completeRegistration,
    buildAuthenticationOptions,
    completeAuthentication,
    listCredentials,
    deleteCredential,
    renameCredential,
} from '../auth/webauthn.js';
import {
    checkEnrollmentToken,
    issueEnrollmentToken,
    regenerateRecoveryCodes,
    recoveryCodeStatus,
    redeemRecoveryCode,
    revokeAllEnrollmentTokens,
} from '../auth/enrollment.js';

/**
 * Authentication routes.
 *
 * Responses to unauthenticated callers deliberately stay vague: the only thing
 * an anonymous visitor learns is whether the instance still needs its first
 * passkey. Failure reasons are logged server side, not returned.
 */

// Anything that can create or consume credentials gets a much tighter budget
// than ordinary API traffic.
const STRICT_LIMIT = { max: 10, timeWindow: '5 minutes' };
const RECOVERY_LIMIT = { max: 5, timeWindow: '15 minutes' };
const LOGIN_LIMIT = { max: 30, timeWindow: '5 minutes' };

function challengeCookieOptions() {
    return {
        path: '/',
        httpOnly: true,
        secure: config.cookie.secure,
        sameSite: config.cookie.sameSite,
        maxAge: config.challengeTtlSeconds,
    };
}

export default async function authRoutes(fastify) {
    fastify.addHook('onSend', (request, reply, payload, done) => {
        noStore(reply);
        done(null, payload);
    });

    // ── Current state ─────────────────────────────────────────────────────
    fastify.get('/state', async (request, reply) => {
        const session = readSession(request, reply);
        const hasCredentials = credentialCount() > 0;
        return reply.send({
            authenticated: !!session,
            // Only meaningful before the first passkey exists; after that it is
            // always false and reveals nothing.
            setupRequired: !hasCredentials,
        });
    });

    // ── Registration ──────────────────────────────────────────────────────
    fastify.post(
        '/register/options',
        {
            config: { rateLimit: STRICT_LIMIT },
            schema: {
                body: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        enrollmentToken: { type: 'string', maxLength: 200 },
                    },
                },
            },
        },
        async (request, reply) => {
            const session = readSession(request, reply);
            const hasCredentials = credentialCount() > 0;

            let enrollmentTokenHash = null;

            if (!session) {
                const token = request.body?.enrollmentToken;
                const checked = checkEnrollmentToken(token);
                if (!checked) {
                    logAuthEvent({
                        event: 'register.options',
                        outcome: 'denied',
                        ip: request.ip,
                        userAgent: request.headers['user-agent'],
                        detail: hasCredentials ? 'invalid enrollment token' : 'first-run token missing or invalid',
                    });
                    return reply.code(403).send({ error: 'enrollment_token_invalid' });
                }
                enrollmentTokenHash = checked.hash;
            }

            const { options, challengeId } = await buildRegistrationOptions({ enrollmentTokenHash });
            reply.setCookie(config.cookie.challenge, challengeId, challengeCookieOptions());
            return reply.send({ options });
        },
    );

    fastify.post(
        '/register/verify',
        {
            config: { rateLimit: STRICT_LIMIT },
            schema: {
                body: {
                    type: 'object',
                    required: ['response'],
                    additionalProperties: false,
                    properties: {
                        response: { type: 'object' },
                        name: { type: 'string', maxLength: 60 },
                    },
                },
            },
        },
        async (request, reply) => {
            const challengeId = request.cookies?.[config.cookie.challenge];
            reply.clearCookie(config.cookie.challenge, { path: '/' });

            // Read once, before the credential is written: a challenge that was
            // authorised by a session must still be backed by one now.
            const hadSession = !!readSession(request, reply);

            const result = await completeRegistration({
                response: request.body.response,
                challengeId,
                name: request.body.name,
                hasSession: hadSession,
            });

            if (!result.ok) {
                logAuthEvent({
                    event: 'register.verify',
                    outcome: 'failed',
                    ip: request.ip,
                    userAgent: request.headers['user-agent'],
                    detail: result.reason,
                });
                return reply.code(400).send({ error: 'registration_failed' });
            }

            const isFirstCredential = credentialCount() === 1;
            let recoveryCodes = null;
            if (isFirstCredential) {
                recoveryCodes = await regenerateRecoveryCodes();
            }

            if (!hadSession) {
                createSession(reply, {
                    credentialId: result.credentialId,
                    ip: request.ip,
                    userAgent: request.headers['user-agent'],
                });
            }

            logAuthEvent({
                event: 'register.verify',
                outcome: 'success',
                ip: request.ip,
                userAgent: request.headers['user-agent'],
                detail: `credential ${result.credentialId.slice(0, 12)}…`,
            });

            return reply.send({ ok: true, recoveryCodes });
        },
    );

    // ── Login ─────────────────────────────────────────────────────────────
    fastify.post('/login/options', { config: { rateLimit: LOGIN_LIMIT } }, async (request, reply) => {
        if (credentialCount() === 0) {
            return reply.code(409).send({ error: 'setup_required' });
        }
        const { options, challengeId } = await buildAuthenticationOptions();
        reply.setCookie(config.cookie.challenge, challengeId, challengeCookieOptions());
        return reply.send({ options });
    });

    fastify.post(
        '/login/verify',
        {
            config: { rateLimit: LOGIN_LIMIT },
            schema: {
                body: {
                    type: 'object',
                    required: ['response'],
                    additionalProperties: false,
                    properties: { response: { type: 'object' } },
                },
            },
        },
        async (request, reply) => {
            const challengeId = request.cookies?.[config.cookie.challenge];
            reply.clearCookie(config.cookie.challenge, { path: '/' });

            const result = await completeAuthentication({
                response: request.body.response,
                challengeId,
            });

            if (!result.ok) {
                logAuthEvent({
                    event: 'login',
                    outcome: 'failed',
                    ip: request.ip,
                    userAgent: request.headers['user-agent'],
                    detail: result.reason,
                });
                // A counter mismatch means a possible cloned authenticator, so
                // every existing session is dropped as a precaution.
                if (result.reason === 'counter_replay') {
                    destroyAllSessions();
                }
                return reply.code(401).send({ error: 'authentication_failed' });
            }

            createSession(reply, {
                credentialId: result.credentialId,
                ip: request.ip,
                userAgent: request.headers['user-agent'],
            });

            logAuthEvent({
                event: 'login',
                outcome: 'success',
                ip: request.ip,
                userAgent: request.headers['user-agent'],
                detail: `credential ${result.credentialId.slice(0, 12)}…`,
            });

            return reply.send({ ok: true });
        },
    );

    fastify.post('/logout', async (request, reply) => {
        destroySession(request, reply);
        logAuthEvent({
            event: 'logout',
            outcome: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'],
        });
        return reply.send({ ok: true });
    });

    // ── Recovery ──────────────────────────────────────────────────────────
    fastify.post(
        '/recovery',
        {
            config: { rateLimit: RECOVERY_LIMIT },
            schema: {
                body: {
                    type: 'object',
                    required: ['code'],
                    additionalProperties: false,
                    properties: { code: { type: 'string', maxLength: 64 } },
                },
            },
        },
        async (request, reply) => {
            const result = await redeemRecoveryCode(request.body.code);

            if (!result.ok) {
                logAuthEvent({
                    event: 'recovery',
                    outcome: 'failed',
                    ip: request.ip,
                    userAgent: request.headers['user-agent'],
                });
                return reply.code(401).send({ error: 'recovery_failed' });
            }

            // Recovery means devices were lost: drop every existing session and
            // every outstanding enrollment token before issuing a fresh one.
            destroyAllSessions();
            revokeAllEnrollmentTokens();
            const { token } = issueEnrollmentToken({ label: 'recovery', ttlMinutes: 10 });

            logAuthEvent({
                event: 'recovery',
                outcome: 'success',
                ip: request.ip,
                userAgent: request.headers['user-agent'],
            });

            return reply.send({ ok: true, enrollmentToken: token });
        },
    );

    // ── Credential management (authenticated) ─────────────────────────────
    fastify.get('/credentials', { preHandler: requireSession }, async (request, reply) => reply.send({
        credentials: listCredentials(),
        recoveryCodes: recoveryCodeStatus(),
    }));

    fastify.patch(
        '/credentials/:id',
        {
            preHandler: requireSession,
            schema: {
                body: {
                    type: 'object',
                    required: ['name'],
                    additionalProperties: false,
                    properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
                },
            },
        },
        async (request, reply) => {
            const changed = renameCredential(request.params.id, request.body.name);
            if (!changed) return reply.code(404).send({ error: 'not_found' });
            return reply.send({ ok: true });
        },
    );

    fastify.delete('/credentials/:id', { preHandler: requireSession }, async (request, reply) => {
        if (credentialCount() <= 1) {
            // Removing the only passkey would leave the console as the sole way
            // back in. Refuse rather than let a tap cause a lockout.
            return reply.code(409).send({ error: 'last_credential' });
        }
        const changed = deleteCredential(request.params.id);
        if (!changed) return reply.code(404).send({ error: 'not_found' });

        logAuthEvent({
            event: 'credential.delete',
            outcome: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'],
            detail: String(request.params.id).slice(0, 32),
        });
        return reply.send({ ok: true });
    });

    // ── Enrollment token for adding another device while logged in ────────
    fastify.post('/enrollment-token', { preHandler: requireSession, config: { rateLimit: STRICT_LIMIT } }, async (request, reply) => {
        const { token, expiresAt } = issueEnrollmentToken({ label: 'session' });
        logAuthEvent({
            event: 'enrollment.issue',
            outcome: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'],
        });
        return reply.send({ token, expiresAt });
    });

    // ── Recovery codes (authenticated) ────────────────────────────────────
    fastify.post('/recovery-codes', { preHandler: requireSession, config: { rateLimit: STRICT_LIMIT } }, async (request, reply) => {
        const codes = await regenerateRecoveryCodes();
        logAuthEvent({
            event: 'recovery-codes.regenerate',
            outcome: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'],
        });
        return reply.send({ codes });
    });

    // ── Sessions ──────────────────────────────────────────────────────────
    fastify.get('/sessions', { preHandler: requireSession }, async (request, reply) => {
        // Superseded rows are the previous token of a rotation, still inside
        // its grace window. They are the same device, so listing them would
        // show a phantom extra session.
        const rows = db
            .prepare(
                'SELECT created_at, expires_at, rotated_at, ip, user_agent, token_hash FROM sessions WHERE superseded_at IS NULL ORDER BY created_at DESC',
            )
            .all();
        return reply.send({
            sessions: rows.map((row) => ({
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                lastRotatedAt: row.rotated_at,
                ip: row.ip,
                userAgent: row.user_agent,
                current: row.token_hash === request.session.tokenHash,
            })),
        });
    });

    fastify.post('/sessions/revoke-others', { preHandler: requireSession }, async (request, reply) => {
        const removed = destroyOtherSessions(request.session.tokenHash);
        logAuthEvent({
            event: 'sessions.revoke-others',
            outcome: 'success',
            ip: request.ip,
            userAgent: request.headers['user-agent'],
            detail: `${removed} removed`,
        });
        return reply.send({ ok: true, removed });
    });

    // ── Audit trail ───────────────────────────────────────────────────────
    fastify.get('/log', { preHandler: requireSession }, async (request, reply) => {
        const rows = db
            .prepare('SELECT at, event, outcome, ip, user_agent, detail FROM auth_log ORDER BY id DESC LIMIT 100')
            .all();
        return reply.send({
            entries: rows.map((row) => ({
                at: row.at,
                event: row.event,
                outcome: row.outcome,
                ip: row.ip,
                userAgent: row.user_agent,
                detail: row.detail,
            })),
        });
    });
}
