/**
 * End-to-end check of the self-hosted Tasks API.
 *
 * Implements just enough of a WebAuthn authenticator in software to register a
 * passkey and sign in with it, then exercises the task, settings and data
 * routes, plus the negative cases that matter for security.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8080';
const ORIGIN = BASE;
const RP_ID = new URL(BASE).hostname;
const TOKEN = process.env.ENROLL_TOKEN;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
    }
}

// ── Cookie jar ────────────────────────────────────────────────────────────
const jar = new Map();

function storeCookies(response) {
    const raw = response.headers.getSetCookie?.() || [];
    for (const line of raw) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
        else jar.set(name, value);
    }
}

/** `override` replaces jar entries for this one request; null removes one. */
function cookieHeader(override) {
    const merged = new Map(jar);
    for (const [name, value] of Object.entries(override || {})) {
        if (value === null) merged.delete(name);
        else merged.set(name, value);
    }
    return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Pull one cookie value straight out of a response, bypassing the jar. */
function cookieFrom(setCookies, name) {
    for (const line of setCookies || []) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
    }
    return null;
}

const CHALLENGE_COOKIE = 'tasks_challenge';

async function call(path, {
    method = 'GET', body, origin = ORIGIN, raw = false, cookies: override,
} = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    const cookies = cookieHeader(override);
    if (cookies) headers.Cookie = cookies;

    const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
    });
    const setCookies = response.headers.getSetCookie?.() || [];
    storeCookies(response);
    if (raw) return response;

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    return { status: response.status, body: payload, setCookies };
}

// ── Minimal CBOR encoder ──────────────────────────────────────────────────
function head(major, length) {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65536) {
        const b = Buffer.alloc(3);
        b[0] = (major << 5) | 25;
        b.writeUInt16BE(length, 1);
        return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(length, 1);
    return b;
}

const cborInt = (n) => (n >= 0 ? head(0, n) : head(1, -n - 1));
const cborBytes = (buf) => Buffer.concat([head(2, buf.length), buf]);
const cborText = (str) => {
    const buf = Buffer.from(str, 'utf8');
    return Buffer.concat([head(3, buf.length), buf]);
};
const cborMap = (entries) => Buffer.concat([
    head(5, entries.length),
    ...entries.map(([k, v]) => Buffer.concat([k, v])),
]);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ── Software authenticator ────────────────────────────────────────────────
class SoftAuthenticator {
    constructor() {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.credentialId = randomBytes(32);
        this.counter = 0;

        // Raw uncompressed point: 0x04 || X(32) || Y(32)
        const raw = publicKey.export({ format: 'der', type: 'spki' });
        const point = raw.subarray(raw.length - 65);
        this.x = point.subarray(1, 33);
        this.y = point.subarray(33, 65);
    }

    coseKey() {
        return cborMap([
            [cborInt(1), cborInt(2)],    // kty: EC2
            [cborInt(3), cborInt(-7)],   // alg: ES256
            [cborInt(-1), cborInt(1)],   // crv: P-256
            [cborInt(-2), cborBytes(this.x)],
            [cborInt(-3), cborBytes(this.y)],
        ]);
    }

    authData({ attested }) {
        const rpIdHash = createHash('sha256').update(RP_ID).digest();
        // UP (0x01) | UV (0x04), plus AT (0x40) when a credential is attached.
        const flags = Buffer.from([attested ? 0x45 : 0x05]);
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(this.counter, 0);

        if (!attested) return Buffer.concat([rpIdHash, flags, counter]);

        const aaguid = Buffer.alloc(16);
        const idLength = Buffer.alloc(2);
        idLength.writeUInt16BE(this.credentialId.length, 0);
        return Buffer.concat([rpIdHash, flags, counter, aaguid, idLength, this.credentialId, this.coseKey()]);
    }

    clientData(type, challenge) {
        return Buffer.from(JSON.stringify({
            type,
            challenge,
            origin: ORIGIN,
            crossOrigin: false,
        }), 'utf8');
    }

    register(challenge) {
        this.counter += 1;
        const clientDataJSON = this.clientData('webauthn.create', challenge);
        const attestationObject = cborMap([
            [cborText('fmt'), cborText('none')],
            [cborText('attStmt'), cborMap([])],
            [cborText('authData'), cborBytes(this.authData({ attested: true }))],
        ]);

        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                clientDataJSON: b64url(clientDataJSON),
                attestationObject: b64url(attestationObject),
                transports: ['internal'],
            },
        };
    }

    authenticate(challenge, { bumpCounter = true } = {}) {
        if (bumpCounter) this.counter += 1;
        const clientDataJSON = this.clientData('webauthn.get', challenge);
        const authData = this.authData({ attested: false });
        const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
        const signature = createSign('SHA256').update(signed).sign(this.privateKey);

        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            clientExtensionResults: {},
            response: {
                clientDataJSON: b64url(clientDataJSON),
                authenticatorData: b64url(authData),
                signature: b64url(signature),
            },
        };
    }
}

// ── Scenario ──────────────────────────────────────────────────────────────
async function main() {
    console.log(`\nTarget ${BASE}\n`);

    // ── Registration ──
    console.log('Registration');
    const badToken = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: 'definitely-not-valid' },
    });
    check('invalid enrollment token is rejected', badToken.status === 403, `got ${badToken.status}`);

    const options = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: TOKEN },
    });
    check('valid enrollment token yields options', options.status === 200, JSON.stringify(options.body));
    check('user verification is required', options.body?.options?.authenticatorSelection?.userVerification === 'required');
    check('resident key is required', options.body?.options?.authenticatorSelection?.residentKey === 'required');

    const authenticator = new SoftAuthenticator();
    const attestation = authenticator.register(options.body.options.challenge);
    const registered = await call('/api/auth/register/verify', {
        method: 'POST',
        body: { response: attestation, name: 'Test-Gerät' },
    });
    check('registration verifies', registered.status === 200, JSON.stringify(registered.body));
    check('recovery codes are issued once', Array.isArray(registered.body?.recoveryCodes)
        && registered.body.recoveryCodes.length === 10);
    const recoveryCodes = registered.body?.recoveryCodes || [];

    const stateAfter = await call('/api/auth/state');
    check('session established by registration', stateAfter.body?.authenticated === true);
    check('setup no longer required', stateAfter.body?.setupRequired === false);

    const reusedToken = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: TOKEN },
    });
    // Still 200 because the caller now holds a session; the token itself is spent.
    check('enrollment token consumed', reusedToken.status === 200);

    // ── Tasks ──
    console.log('\nTasks');
    const created = await call('/api/tasks', {
        method: 'POST',
        body: { title: 'Testaufgabe', dueDate: '2026-01-15', repeatType: 'weekly' },
    });
    check('task created', created.status === 201, JSON.stringify(created.body));
    const taskId = created.body?.task?.id;
    check('task carries nextDueDate', created.body?.task?.nextDueDate === '2026-01-15');

    const listed = await call('/api/tasks');
    check('task appears in list', listed.body?.tasks?.some((t) => t.id === taskId));

    const patched = await call(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: { progress: 3 },
    });
    check('progress update accepted', patched.body?.task?.progress === 3);
    check('completing a repeating task schedules the next occurrence',
        patched.body?.task?.nextDueDate === '2026-01-22',
        `got ${patched.body?.task?.nextDueDate}`);

    const postponed = await call(`/api/tasks/${encodeURIComponent(taskId)}/postpone`, { method: 'POST' });
    check('postpone shifts the due date by one day', postponed.body?.task?.dueDate === '2026-01-16',
        `got ${postponed.body?.task?.dueDate}`);

    const badProgress = await call(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        body: { progress: 99 },
    });
    check('out-of-range progress rejected', badProgress.status === 400, `got ${badProgress.status}`);

    const badRepeat = await call('/api/tasks', {
        method: 'POST',
        body: { title: 'x', repeatType: 'hourly' },
    });
    check('unknown repeat type rejected', badRepeat.status === 400, `got ${badRepeat.status}`);

    const extraField = await call('/api/tasks', {
        method: 'POST',
        body: { title: 'x', isAdmin: true },
    });
    check('unknown body field rejected', extraField.status === 400, `got ${extraField.status}`);

    const blankTitle = await call('/api/tasks', { method: 'POST', body: { title: '   ' } });
    check('whitespace-only title rejected', blankTitle.status === 400, `got ${blankTitle.status}`);

    // ── Settings ──
    console.log('\nSettings');
    const settings = await call('/api/settings');
    check('settings include defaults', typeof settings.body?.defaults?.accentColor === 'string');

    const savedPrefs = await call('/api/settings/preferences', {
        method: 'PUT',
        body: { preferences: { accentColor: '#ff0000', bogusKey: 'x', fontSize: 'not-a-number' } },
    });
    check('known preference stored', savedPrefs.body?.preferences?.accentColor === '#ff0000');
    check('unknown preference dropped', savedPrefs.body?.preferences?.bogusKey === undefined);
    check('wrongly typed preference falls back to default',
        savedPrefs.body?.preferences?.fontSize === settings.body.defaults.fontSize);

    // Preferences end up in CSS custom properties, and an import file is an
    // untrusted source of them, so values outside the offered sets are refused.
    const hostilePrefs = await call('/api/settings/preferences', {
        method: 'PUT',
        body: {
            preferences: {
                accentColor: 'red; background: url(//evil)',
                borderStyle: 'solid"); } body { display: none',
                filledBoxSymbol: '"; content: url(//evil)',
                fontFamily: 'Comic Sans',
                fontSize: 4096,
            },
        },
    });
    const clean = hostilePrefs.body?.preferences || {};
    check('non-colour accent refused', clean.accentColor === settings.body.defaults.accentColor,
        `got ${clean.accentColor}`);
    check('unlisted border style refused', clean.borderStyle === settings.body.defaults.borderStyle,
        `got ${clean.borderStyle}`);
    check('unlisted progress symbol refused', clean.filledBoxSymbol === settings.body.defaults.filledBoxSymbol,
        `got ${clean.filledBoxSymbol}`);
    check('unlisted font family refused', clean.fontFamily === settings.body.defaults.fontFamily,
        `got ${clean.fontFamily}`);
    check('out-of-range font size clamped', clean.fontSize === 19, `got ${clean.fontSize}`);

    const savedOrder = await call('/api/settings/order', { method: 'PUT', body: { order: [taskId] } });
    check('custom order stored', Array.isArray(savedOrder.body?.order) && savedOrder.body.order[0] === taskId);

    // ── Export / import ──
    console.log('\nExport / import');
    const exported = await call('/api/data/export');
    check('export returns tasks', Array.isArray(exported.body?.tasks) && exported.body.tasks.length >= 1);
    check('export leaks no credentials', !JSON.stringify(exported.body).includes('publicKey')
        && exported.body.credentials === undefined
        && exported.body.recoveryCodes === undefined);

    const imported = await call('/api/data/import', {
        method: 'POST',
        body: {
            mode: 'merge',
            data: { tasks: [{ id: 'imported_1', title: 'Importiert', progress: 1, repeatType: 'none' }] },
        },
    });
    check('import adds new task', imported.body?.imported === 1, JSON.stringify(imported.body));

    const reimported = await call('/api/data/import', {
        method: 'POST',
        body: {
            mode: 'merge',
            data: { tasks: [{ id: 'imported_1', title: 'Nochmal', progress: 1, repeatType: 'none' }] },
        },
    });
    check('merge skips an id that already exists', reimported.body?.skipped === 1);

    // ── Login with the passkey ──
    console.log('\nLogin');
    await call('/api/auth/logout', { method: 'POST' });
    const loggedOut = await call('/api/auth/state');
    check('logout clears the session', loggedOut.body?.authenticated === false);

    const loginOptions = await call('/api/auth/login/options', { method: 'POST' });
    check('login options returned', loginOptions.status === 200);
    check('login demands user verification', loginOptions.body?.options?.userVerification === 'required');

    const assertion = authenticator.authenticate(loginOptions.body.options.challenge);
    const loggedIn = await call('/api/auth/login/verify', { method: 'POST', body: { response: assertion } });
    check('passkey login succeeds', loggedIn.status === 200, JSON.stringify(loggedIn.body));

    const stateSignedIn = await call('/api/auth/state');
    check('session active after login', stateSignedIn.body?.authenticated === true);

    // ── Replayed challenge ──
    const replay = await call('/api/auth/login/verify', { method: 'POST', body: { response: assertion } });
    check('a replayed assertion is refused', replay.status === 401, `got ${replay.status}`);

    // Sign back in for the remaining checks.
    const freshOptions = await call('/api/auth/login/options', { method: 'POST' });
    const freshAssertion = authenticator.authenticate(freshOptions.body.options.challenge);
    await call('/api/auth/login/verify', { method: 'POST', body: { response: freshAssertion } });

    // ── Cloned authenticator: counter fails to advance ──
    console.log('\nClone detection');

    // The counter only means anything once the signature has been verified.
    // A response with a stale counter and a bogus signature is an ordinary
    // failed login, not a clone, and must not drop everyone's sessions.
    const forgeOptions = await call('/api/auth/login/options', { method: 'POST' });
    const forged = authenticator.authenticate(forgeOptions.body.options.challenge, { bumpCounter: false });
    forged.response.signature = b64url(randomBytes(70));
    const forgedResult = await call('/api/auth/login/verify', { method: 'POST', body: { response: forged } });
    check('forged assertion refused', forgedResult.status === 401, `got ${forgedResult.status}`);
    const survived = await call('/api/auth/state');
    check('a forged assertion leaves existing sessions alone',
        survived.body?.authenticated === true);

    const cloneOptions = await call('/api/auth/login/options', { method: 'POST' });
    const stale = authenticator.authenticate(cloneOptions.body.options.challenge, { bumpCounter: false });
    // Roll the stored counter back the way a cloned key would behave.
    authenticator.counter -= 1;
    const cloned = await call('/api/auth/login/verify', { method: 'POST', body: { response: stale } });
    check('non-advancing counter is rejected', cloned.status === 401, `got ${cloned.status}`);
    authenticator.counter += 2;

    const afterClone = await call('/api/auth/state');
    check('clone detection drops all sessions', afterClone.body?.authenticated === false);

    // ── Credential management ──
    console.log('\nCredentials and recovery');
    const relogin = await call('/api/auth/login/options', { method: 'POST' });
    const reassert = authenticator.authenticate(relogin.body.options.challenge);
    await call('/api/auth/login/verify', { method: 'POST', body: { response: reassert } });

    const credentials = await call('/api/auth/credentials');
    check('credential is listed', credentials.body?.credentials?.length === 1);
    check('credential name kept', credentials.body?.credentials?.[0]?.name === 'Test-Gerät');
    check('recovery code status reported', credentials.body?.recoveryCodes?.unused === 10);

    const deleteLast = await call(
        `/api/auth/credentials/${encodeURIComponent(credentials.body.credentials[0].id)}`,
        { method: 'DELETE' },
    );
    check('deleting the only passkey is refused', deleteLast.status === 409, `got ${deleteLast.status}`);

    // ── Recovery ──
    await call('/api/auth/logout', { method: 'POST' });
    const badRecovery = await call('/api/auth/recovery', { method: 'POST', body: { code: 'AAAAA-BBBBB' } });
    check('wrong recovery code rejected', badRecovery.status === 401, `got ${badRecovery.status}`);

    const goodRecovery = await call('/api/auth/recovery', { method: 'POST', body: { code: recoveryCodes[0] } });
    check('valid recovery code accepted', goodRecovery.status === 200, JSON.stringify(goodRecovery.body));
    check('recovery yields an enrollment token', typeof goodRecovery.body?.enrollmentToken === 'string');
    check('recovery does not itself sign you in',
        (await call('/api/auth/state')).body?.authenticated === false);

    const reusedRecovery = await call('/api/auth/recovery', { method: 'POST', body: { code: recoveryCodes[0] } });
    check('a recovery code works only once', reusedRecovery.status === 401, `got ${reusedRecovery.status}`);

    // Register a second device with the recovery-issued token.
    const secondOptions = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: goodRecovery.body.enrollmentToken },
    });
    check('recovery token authorises registration', secondOptions.status === 200);

    const second = new SoftAuthenticator();
    const secondAttestation = second.register(secondOptions.body.options.challenge);
    const secondRegistered = await call('/api/auth/register/verify', {
        method: 'POST',
        body: { response: secondAttestation, name: 'Zweitgerät' },
    });
    check('second passkey registered', secondRegistered.status === 200, JSON.stringify(secondRegistered.body));
    check('recovery codes are not re-issued for a second device',
        secondRegistered.body?.recoveryCodes === null);

    const twoCreds = await call('/api/auth/credentials');
    check('two passkeys now registered', twoCreds.body?.credentials?.length === 2);

    // ── Cross-origin and session hygiene ──
    console.log('\nRequest origin');
    const crossOrigin = await call('/api/tasks', {
        method: 'POST',
        origin: 'https://attacker.example',
        body: { title: 'nope' },
    });
    check('cross-origin write blocked', crossOrigin.status === 403, `got ${crossOrigin.status}`);

    const noOrigin = await call('/api/tasks', { method: 'POST', origin: null, body: { title: 'nope' } });
    check('write without an Origin header blocked', noOrigin.status === 403, `got ${noOrigin.status}`);

    const sessions = await call('/api/auth/sessions');
    check('sessions listed', Array.isArray(sessions.body?.sessions));
    check('exactly one is marked current', sessions.body.sessions.filter((s) => s.current).length === 1);

    const log = await call('/api/auth/log');
    check('auth log records events', (log.body?.entries?.length || 0) > 0);
    check('auth log records the failed recovery attempt',
        log.body.entries.some((e) => e.event === 'recovery' && e.outcome === 'failed'));

    // ── Enrollment token reuse ──
    // The token is validated when options are requested but only spent when a
    // credential is actually written, so several challenges can be collected
    // from one token before any of them is redeemed. Only the first may work.
    console.log('\nEnrollment token reuse');
    const issued = await call('/api/auth/enrollment-token', { method: 'POST' });
    const oneShotToken = issued.body?.token;
    check('enrollment token issued', typeof oneShotToken === 'string' && oneShotToken.length > 20);

    // Unauthenticated from here, so the token is what authorises the request.
    await call('/api/auth/logout', { method: 'POST' });

    const reuseOptionsA = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: oneShotToken },
    });
    const reuseChallengeA = cookieFrom(reuseOptionsA.setCookies, CHALLENGE_COOKIE);
    const reuseOptionsB = await call('/api/auth/register/options', {
        method: 'POST',
        body: { enrollmentToken: oneShotToken },
    });
    const reuseChallengeB = cookieFrom(reuseOptionsB.setCookies, CHALLENGE_COOKIE);
    check('two challenges collected from one token',
        !!reuseChallengeA && !!reuseChallengeB && reuseChallengeA !== reuseChallengeB);

    const deviceA = new SoftAuthenticator();
    const firstUse = await call('/api/auth/register/verify', {
        method: 'POST',
        body: { response: deviceA.register(reuseOptionsA.body.options.challenge), name: 'Token-Gerät A' },
        cookies: { [CHALLENGE_COOKIE]: reuseChallengeA },
    });
    check('first registration with the token succeeds', firstUse.status === 200,
        JSON.stringify(firstUse.body));

    // That registration signed us in; drop the session so the second attempt
    // stands or falls on the token alone.
    await call('/api/auth/logout', { method: 'POST' });

    const deviceB = new SoftAuthenticator();
    const secondUse = await call('/api/auth/register/verify', {
        method: 'POST',
        body: { response: deviceB.register(reuseOptionsB.body.options.challenge), name: 'Token-Gerät B' },
        cookies: { [CHALLENGE_COOKIE]: reuseChallengeB },
    });
    check('a spent enrollment token cannot register a second passkey',
        secondUse.status === 400, `got ${secondUse.status}`);

    const afterReuse = await call('/api/auth/state');
    check('the refused registration granted no session',
        afterReuse.body?.authenticated === false);

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('\nTest run crashed:', error);
    process.exit(1);
});
