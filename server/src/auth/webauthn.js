import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import db from '../db.js';
import config from '../config.js';
import { randomToken } from './crypto.js';
import { consumeEnrollmentToken } from './enrollment.js';

/**
 * WebAuthn / passkey glue.
 *
 * Policy choices worth knowing:
 *  - userVerification: 'required'  -> the authenticator must check biometrics
 *    or a PIN, so a stolen unlocked phone is not automatically a login.
 *  - residentKey: 'required'       -> discoverable credentials, which is what
 *    lets the login screen work without any username field.
 *  - attestation: 'none'           -> no hardware identity is collected; there
 *    is nothing to verify it against in a single user deployment.
 */

const CHALLENGE_TYPES = { REGISTRATION: 'registration', AUTHENTICATION: 'authentication' };

/** Stable, random user handle for the single owner account. */
function userHandle() {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('user_handle');
    if (row) return Buffer.from(row.value, 'base64url');
    const handle = randomToken(32);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('user_handle', handle);
    return Buffer.from(handle, 'base64url');
}

function storeChallenge(challenge, type, enrollmentTokenHash = null) {
    const id = randomToken(24);
    const expires = new Date(Date.now() + config.challengeTtlSeconds * 1000).toISOString();
    db.prepare(
        'INSERT INTO challenges (id, challenge, type, expires_at, enrollment_token_hash) VALUES (?, ?, ?, ?, ?)',
    ).run(id, challenge, type, expires, enrollmentTokenHash);
    return id;
}

/** Fetch and immediately delete a challenge: single use by construction. */
function consumeChallenge(id, type) {
    if (!id || typeof id !== 'string') return null;
    const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
    if (!row) return null;
    db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
    if (row.type !== type) return null;
    if (new Date(row.expires_at) <= new Date()) return null;
    return row;
}

export function listCredentials() {
    return db
        .prepare(
            'SELECT id, name, created_at, last_used_at, device_type, backed_up, transports FROM credentials ORDER BY created_at ASC',
        )
        .all()
        .map((row) => ({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            deviceType: row.device_type,
            backedUp: !!row.backed_up,
            transports: row.transports ? JSON.parse(row.transports) : [],
        }));
}

export async function buildRegistrationOptions({ enrollmentTokenHash = null } = {}) {
    const existing = db.prepare('SELECT id, transports FROM credentials').all();

    const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userID: userHandle(),
        userName: config.accountName,
        userDisplayName: config.accountDisplayName,
        attestationType: 'none',
        // Stops the same authenticator being enrolled twice.
        excludeCredentials: existing.map((row) => ({
            id: row.id,
            transports: row.transports ? JSON.parse(row.transports) : undefined,
        })),
        authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
        },
        timeout: config.challengeTtlSeconds * 1000,
    });

    const challengeId = storeChallenge(options.challenge, CHALLENGE_TYPES.REGISTRATION, enrollmentTokenHash);
    return { options, challengeId };
}

/**
 * Finish a registration.
 *
 * `hasSession` is evaluated by the caller at *verify* time, not at options
 * time: authorisation has to still hold when the credential is actually
 * written, otherwise revoking a session would not stop a registration that was
 * started just before it.
 */
export async function completeRegistration({ response, challengeId, name, hasSession = false }) {
    const stored = consumeChallenge(challengeId, CHALLENGE_TYPES.REGISTRATION);
    if (!stored) {
        return { ok: false, reason: 'challenge_expired' };
    }

    // A challenge with no enrollment token was only ever authorised by a live
    // session. Re-check it here rather than trusting that it still exists.
    if (!stored.enrollment_token_hash && !hasSession) {
        return { ok: false, reason: 'not_authorized' };
    }

    let verification;
    try {
        verification = await verifyRegistrationResponse({
            response,
            expectedChallenge: stored.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpID,
            requireUserVerification: true,
        });
    } catch (error) {
        return { ok: false, reason: 'verification_failed', detail: error.message };
    }

    if (!verification.verified || !verification.registrationInfo) {
        return { ok: false, reason: 'verification_failed' };
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const exists = db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(credential.id);
    if (exists) {
        return { ok: false, reason: 'credential_already_registered' };
    }

    // Burning the token and writing the credential happen in one transaction.
    // Nothing stops a caller fetching several challenges from one token before
    // spending it, so the token has to be claimed at the moment the credential
    // is created; consuming it afterwards would make a "single use" token good
    // for as many registrations as challenges were fetched in advance.
    let spent = false;
    const claim = db.transaction(() => {
        if (stored.enrollment_token_hash) {
            if (!consumeEnrollmentToken(stored.enrollment_token_hash)) {
                spent = true;
                return;
            }
        }
        db.prepare(
            'INSERT INTO credentials (id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
            credential.id,
            Buffer.from(credential.publicKey),
            credential.counter ?? 0,
            JSON.stringify(credential.transports || []),
            credentialDeviceType || null,
            credentialBackedUp ? 1 : 0,
            String(name || 'Passkey').slice(0, 60),
            new Date().toISOString(),
        );
    });
    claim();

    if (spent) {
        return { ok: false, reason: 'enrollment_token_spent' };
    }

    return { ok: true, credentialId: credential.id };
}

export async function buildAuthenticationOptions() {
    const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        // Empty allowCredentials: the authenticator offers its discoverable
        // passkeys itself, and the server reveals nothing about what exists.
        allowCredentials: [],
        userVerification: 'required',
        timeout: config.challengeTtlSeconds * 1000,
    });

    const challengeId = storeChallenge(options.challenge, CHALLENGE_TYPES.AUTHENTICATION);
    return { options, challengeId };
}

export async function completeAuthentication({ response, challengeId }) {
    const stored = consumeChallenge(challengeId, CHALLENGE_TYPES.AUTHENTICATION);
    if (!stored) {
        return { ok: false, reason: 'challenge_expired' };
    }

    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(response?.id);
    if (!row) {
        return { ok: false, reason: 'unknown_credential' };
    }

    let verification;
    try {
        verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: stored.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpID,
            requireUserVerification: true,
            credential: {
                id: row.id,
                publicKey: new Uint8Array(row.public_key),
                // Deliberately 0, which switches off the library's own counter
                // check; the real one runs below, after the signature has been
                // verified. The library folds a counter regression into the
                // same generic error as a bad signature, and the two have to be
                // told apart: one is a cloned authenticator, the other is noise.
                counter: 0,
                transports: row.transports ? JSON.parse(row.transports) : undefined,
            },
        });
    } catch (error) {
        return { ok: false, reason: 'verification_failed', detail: error.message };
    }

    if (!verification.verified) {
        return { ok: false, reason: 'verification_failed' };
    }

    const { newCounter } = verification.authenticationInfo;

    // A counter that fails to advance on an authenticator that uses one is the
    // classic signal of a cloned credential. Refuse the login rather than
    // quietly accepting it.
    //
    // This runs only once the signature has been verified. Reacting to the
    // counter earlier would let anyone who knows a credential id hand in an
    // unsigned response and have the caller treat it as a clone -- which drops
    // every session on the instance.
    if (row.counter > 0 && newCounter <= row.counter) {
        return { ok: false, reason: 'counter_replay' };
    }

    db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
        newCounter,
        new Date().toISOString(),
        row.id,
    );

    return { ok: true, credentialId: row.id };
}

export function deleteCredential(id) {
    return db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes;
}

export function renameCredential(id, name) {
    return db.prepare('UPDATE credentials SET name = ? WHERE id = ?').run(String(name).slice(0, 60), id).changes;
}

export { CHALLENGE_TYPES };
