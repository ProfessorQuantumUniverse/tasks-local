import { api, describeError } from './api.js';
import {
    createCredential,
    getCredential,
    isCancellation,
    isSupported,
    unsupportedReason,
} from './webauthn.js';

/**
 * The sign-in screen: passkey login, device enrollment and recovery.
 */

const el = (id) => document.getElementById(id);

let signedInHandler = () => {};

function showPane(name) {
    document.querySelectorAll('.auth-pane').forEach((pane) => {
        pane.classList.toggle('active', pane.dataset.pane === name);
    });
    setMessage('');
}

function setMessage(text, kind = 'info') {
    const box = el('auth-message');
    if (!box) return;
    box.textContent = text;
    box.className = `auth-message${text ? ` ${kind}` : ''}`;
}

function busy(button, isBusy) {
    if (!button) return;
    button.disabled = isBusy;
}

/** Show the freshly generated recovery codes and wait for acknowledgement. */
function presentRecoveryCodes(codes) {
    return new Promise((resolve) => {
        const box = document.createElement('div');
        box.className = 'auth-codes';

        const heading = document.createElement('h4');
        heading.textContent = 'Recovery-Codes';
        box.appendChild(heading);

        const list = document.createElement('ul');
        codes.forEach((code) => {
            const item = document.createElement('li');
            item.textContent = code;
            list.appendChild(item);
        });
        box.appendChild(list);

        const note = document.createElement('p');
        note.textContent = 'Jeder Code funktioniert genau einmal. Sie werden dir nie wieder '
            + 'angezeigt — speichere sie jetzt offline, z.B. im Passwortmanager oder ausgedruckt.';
        box.appendChild(note);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'auth-primary-btn';
        confirmBtn.textContent = 'Ich habe die Codes gesichert';
        confirmBtn.addEventListener('click', () => {
            box.remove();
            resolve();
        });
        box.appendChild(confirmBtn);

        const pane = document.querySelector('.auth-pane.active') || el('login-container');
        pane.appendChild(box);
    });
}

// ── Login ─────────────────────────────────────────────────────────────────

async function signIn() {
    const button = el('login-btn');
    if (!isSupported()) {
        setMessage(unsupportedReason(), 'error');
        return;
    }

    busy(button, true);
    setMessage('Warte auf deinen Passkey…');

    try {
        const { options } = await api('/api/auth/login/options', { method: 'POST' });
        const assertion = await getCredential(options);
        await api('/api/auth/login/verify', { method: 'POST', body: { response: assertion } });
        setMessage('');
        signedInHandler();
    } catch (error) {
        if (isCancellation(error)) {
            setMessage('Anmeldung abgebrochen.');
        } else {
            setMessage(describeError(error), 'error');
        }
    } finally {
        busy(button, false);
    }
}

// ── Enrollment ────────────────────────────────────────────────────────────

async function enrollDevice() {
    const button = el('enroll-btn');
    const token = el('enroll-token').value.trim();
    const name = el('enroll-name').value.trim() || 'Passkey';

    if (!isSupported()) {
        setMessage(unsupportedReason(), 'error');
        return;
    }
    if (!token) {
        setMessage('Bitte gib den Enrollment-Token ein.', 'error');
        return;
    }

    busy(button, true);
    setMessage('Warte auf deinen Passkey…');

    try {
        const { options } = await api('/api/auth/register/options', {
            method: 'POST',
            body: { enrollmentToken: token },
        });
        const attestation = await createCredential(options);
        const result = await api('/api/auth/register/verify', {
            method: 'POST',
            body: { response: attestation, name },
        });

        el('enroll-token').value = '';
        el('enroll-name').value = '';

        if (result.recoveryCodes?.length) {
            setMessage('Passkey registriert. Sichere jetzt deine Recovery-Codes.', 'success');
            await presentRecoveryCodes(result.recoveryCodes);
        }

        setMessage('');
        signedInHandler();
    } catch (error) {
        if (isCancellation(error)) {
            setMessage('Registrierung abgebrochen.');
        } else {
            setMessage(describeError(error), 'error');
        }
    } finally {
        busy(button, false);
    }
}

// ── Recovery ──────────────────────────────────────────────────────────────

async function redeemRecovery() {
    const button = el('recovery-btn');
    const code = el('recovery-code').value.trim();

    if (!code) {
        setMessage('Bitte gib einen Recovery-Code ein.', 'error');
        return;
    }

    busy(button, true);
    setMessage('Prüfe Code…');

    try {
        const result = await api('/api/auth/recovery', { method: 'POST', body: { code } });
        el('recovery-code').value = '';
        el('enroll-token').value = result.enrollmentToken;
        showPane('enroll');
        el('enroll-lead').textContent = 'Code akzeptiert. Registriere jetzt einen neuen Passkey '
            + 'für dieses Gerät — der Token unten ist bereits eingetragen und nur 10 Minuten gültig.';
        setMessage('Recovery erfolgreich. Alle alten Sitzungen wurden beendet.', 'success');
    } catch (error) {
        setMessage(describeError(error), 'error');
    } finally {
        busy(button, false);
    }
}

// ── Wiring ────────────────────────────────────────────────────────────────

export async function initAuth({ onSignedIn }) {
    signedInHandler = onSignedIn;

    el('login-btn').addEventListener('click', signIn);
    el('enroll-btn').addEventListener('click', enrollDevice);
    el('recovery-btn').addEventListener('click', redeemRecovery);

    document.querySelectorAll('.auth-link[data-goto]').forEach((link) => {
        link.addEventListener('click', () => showPane(link.dataset.goto));
    });

    // Enter should submit the pane the user is looking at.
    el('enroll-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') enrollDevice(); });
    el('enroll-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') enrollDevice(); });
    el('recovery-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') redeemRecovery(); });

    if (!isSupported()) {
        setMessage(unsupportedReason(), 'error');
    }
}

/** Decide which pane to show, based on whether the instance is set up yet. */
export async function resolveInitialPane() {
    try {
        const authState = await api('/api/auth/state', { quiet401: true });
        if (authState.setupRequired) {
            showPane('enroll');
            el('enroll-lead').textContent = 'Erste Einrichtung: gib den Enrollment-Token aus den '
                + 'Container-Logs ein, um dieses Gerät als ersten Passkey zu registrieren.';
        } else {
            showPane('login');
        }
        return authState;
    } catch {
        showPane('login');
        setMessage('Server nicht erreichbar.', 'error');
        return { authenticated: false, setupRequired: false };
    }
}

export function showLoginScreen() {
    showPane('login');
}

export async function signOut() {
    try {
        await api('/api/auth/logout', { method: 'POST' });
    } catch {
        // Even if the request fails the local view should return to the login
        // screen; the cookie is either already gone or will expire.
    }
}
