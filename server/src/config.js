import { hostname } from 'node:os';

/**
 * Central configuration.
 *
 * Every value comes from the environment so that nothing security relevant is
 * baked into the image. Anything that cannot be validated makes the process
 * exit instead of silently falling back to an insecure default.
 */

function fail(message) {
    // eslint-disable-next-line no-console
    console.error(`[config] ${message}`);
    process.exit(1);
}

function bool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
    fail(`${name} must be a boolean value, got "${raw}"`);
}

function int(name, fallback, { min, max } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) fail(`${name} must be an integer, got "${raw}"`);
    if (min !== undefined && value < min) fail(`${name} must be >= ${min}`);
    if (max !== undefined && value > max) fail(`${name} must be <= ${max}`);
    return value;
}

// ── Origin / relying party ────────────────────────────────────────────────
// APP_ORIGIN is the exact scheme+host+port the browser sees, e.g.
// https://tasks.example.com. WebAuthn refuses to work if this does not match
// the address bar, so it must be explicit rather than guessed from headers.
const rawOrigin = (process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
if (!rawOrigin) {
    fail('APP_ORIGIN is required, e.g. APP_ORIGIN=https://tasks.example.com');
}

let originUrl;
try {
    originUrl = new URL(rawOrigin);
} catch {
    fail(`APP_ORIGIN is not a valid URL: "${rawOrigin}"`);
}

if (!['http:', 'https:'].includes(originUrl.protocol)) {
    fail('APP_ORIGIN must use http:// or https://');
}
if (originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
    fail('APP_ORIGIN must be a bare origin without path, query or fragment');
}

const isLocalhostOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname);

// Browsers only expose the WebAuthn API in a secure context: HTTPS, or
// localhost. Anything else silently fails in the browser, so refuse to start
// and say why rather than shipping a login button that can never work.
if (originUrl.protocol === 'http:' && !isLocalhostOrigin) {
    fail(
        'APP_ORIGIN uses http:// on a non-localhost host. Passkeys require a secure ' +
        'context, so this configuration can never log in. Put the app behind TLS ' +
        'and use the https:// address.',
    );
}

// The relying party ID scopes the passkey. It must be the origin's hostname or
// a registrable parent domain of it; a passkey created under one RP ID cannot
// be used under another.
const rpID = (process.env.RP_ID || originUrl.hostname).trim().toLowerCase();
if (rpID !== originUrl.hostname && !originUrl.hostname.endsWith(`.${rpID}`)) {
    fail(`RP_ID "${rpID}" is not the hostname of APP_ORIGIN or a parent domain of it`);
}

// ── Cookies ───────────────────────────────────────────────────────────────
// The __Host- prefix pins a cookie to exactly this origin: the browser only
// accepts it when it is Secure, has Path=/ and carries no Domain attribute,
// which stops a compromised sibling subdomain from planting a session cookie.
const cookieSecure = bool('COOKIE_SECURE', originUrl.protocol === 'https:');
if (cookieSecure && originUrl.protocol === 'http:') {
    fail('COOKIE_SECURE=true requires an https:// APP_ORIGIN, otherwise the browser drops every cookie');
}
const cookiePrefix = cookieSecure ? '__Host-' : '';

// ── Reverse proxy ─────────────────────────────────────────────────────────
// The app is meant to sit behind a reverse proxy on a private Docker network.
// Trusting only private ranges means a client cannot forge X-Forwarded-For to
// escape rate limiting, while the real proxy is still believed.
const trustProxyRaw = (process.env.TRUST_PROXY || 'loopback,linklocal,uniquelocal').trim();
let trustProxy;
if (trustProxyRaw === 'false') {
    trustProxy = false;
} else if (trustProxyRaw === 'true') {
    // Explicit opt-in only: this lets any client spoof its source address.
    trustProxy = true;
} else {
    trustProxy = trustProxyRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export const config = {
    env: process.env.NODE_ENV || 'production',
    host: process.env.HOST || '0.0.0.0',
    port: int('PORT', 8080, { min: 1, max: 65535 }),
    logLevel: process.env.LOG_LEVEL || 'info',

    origin: originUrl.origin,
    isLocalhostOrigin,
    rpID,
    rpName: process.env.RP_NAME || 'Tasks',
    // Shown next to the passkey in the OS credential manager.
    accountName: process.env.ACCOUNT_NAME || `owner@${rpID}`,
    accountDisplayName: process.env.ACCOUNT_DISPLAY_NAME || 'Tasks',

    dataDir: process.env.DATA_DIR || '/data',

    cookie: {
        secure: cookieSecure,
        session: `${cookiePrefix}tasks_session`,
        challenge: `${cookiePrefix}tasks_challenge`,
        sameSite: 'lax',
    },

    session: {
        ttlDays: int('SESSION_TTL_DAYS', 30, { min: 1, max: 365 }),
        // How long a token may be reused before it is swapped for a fresh one.
        rotateAfterHours: int('SESSION_ROTATE_HOURS', 24, { min: 1, max: 24 * 30 }),
        // In-flight requests may still carry the previous token for this long.
        rotationGraceSeconds: int('SESSION_ROTATION_GRACE_SECONDS', 120, { min: 0, max: 3600 }),
    },

    challengeTtlSeconds: int('CHALLENGE_TTL_SECONDS', 300, { min: 30, max: 3600 }),
    enrollmentTokenTtlMinutes: int('ENROLLMENT_TOKEN_TTL_MINUTES', 15, { min: 1, max: 1440 }),
    recoveryCodeCount: int('RECOVERY_CODE_COUNT', 10, { min: 4, max: 30 }),

    trustProxy,
    hstsEnabled: bool('HSTS_ENABLED', originUrl.protocol === 'https:'),

    // Body limit: settings payloads are a few KB, imports are the largest case.
    bodyLimit: int('BODY_LIMIT_BYTES', 2 * 1024 * 1024, { min: 64 * 1024, max: 64 * 1024 * 1024 }),

    instance: hostname(),
};

export default config;
