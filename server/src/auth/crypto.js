import {
    randomBytes,
    createHash,
    scrypt as scryptCb,
    timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Small crypto helpers built on node:crypto only.
 *
 * Deliberately no native password hashing dependency: the only secrets hashed
 * here are high-entropy values this server generated itself (recovery codes,
 * enrollment tokens), not user chosen passwords, so scrypt with these
 * parameters is ample and the supply chain stays smaller.
 */

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** Cryptographically random, URL safe token. */
export function randomToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}

/** Fast lookup hash for values that already carry full entropy. */
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export async function hashSecret(secret) {
    const salt = randomBytes(16);
    const derived = await scrypt(secret, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
    return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifySecret(secret, stored) {
    try {
        const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64url');
        const expected = Buffer.from(hashB64, 'base64url');
        const derived = await scrypt(secret, salt, expected.length, {
            N: Number(n),
            r: Number(r),
            p: Number(p),
            maxmem: SCRYPT_PARAMS.maxmem,
        });
        return timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}

/** Constant time comparison for two strings of arbitrary length. */
export function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    // Hash first so that differing lengths do not throw and do not leak length.
    const ha = createHash('sha256').update(ba).digest();
    const hb = createHash('sha256').update(bb).digest();
    return timingSafeEqual(ha, hb);
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes

/** Human transcribable recovery code, ~50 bits of entropy. */
export function generateRecoveryCode() {
    const pick = () => {
        // Rejection sampling keeps the distribution uniform.
        let byte;
        do {
            byte = randomBytes(1)[0];
        } while (byte >= 256 - (256 % RECOVERY_ALPHABET.length));
        return RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    };
    const group = () => Array.from({ length: 5 }, pick).join('');
    return `${group()}-${group()}`;
}

/** Recovery codes are compared case-insensitively and ignoring separators. */
export function normalizeRecoveryCode(input) {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
