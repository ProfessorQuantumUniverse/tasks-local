import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import db from '../db.js';
import config from '../config.js';
import { randomToken } from './crypto.js';

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

export async function completeRegistration({ response, challengeId, name }) {
    const stored = consumeChallenge(challengeId, CHALLENGE_TYPES.REGISTRATION);
    if (!stored) {
        return { ok: false, reason: 'challenge_expired' };
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

    return { ok: true, credentialId: credential.id, enrollmentTokenHash: stored.enrollment_token_hash };
}

/**
 * Read the signature counter out of authenticatorData.
 * Layout: rpIdHash(32) | flags(1) | counter(4) | ...
 * @returns {number|null} null when the field is unreadable
 */
function readCounter(authenticatorDataB64) {
    if (typeof authenticatorDataB64 !== 'string') return null;
    try {
        const bytes = Buffer.from(authenticatorDataB64, 'base64url');
        if (bytes.length < 37) return null;
        return bytes.readUInt32BE(33);
    } catch {
        return null;
    }
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

    // Check the signature counter before verifying, because the library raises
    // a generic verification error for it. Doing it here keeps a cloned
    // authenticator distinguishable from an ordinary bad signature, which is
    // what lets the caller react to it as the security event it is.
    const incomingCounter = readCounter(response?.response?.authenticatorData);
    if (row.counter > 0 && incomingCounter !== null && incomingCounter <= row.counter) {
        return { ok: false, reason: 'counter_replay' };
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
                counter: row.counter,
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
