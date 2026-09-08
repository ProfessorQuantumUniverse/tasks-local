import { api, describeError } from './api.js';
import { formatDateTime } from './util.js';
import { refreshTasks } from './tasks.js';
import { loadSettings, applySettings, syncSettingsUI } from './settings.js';
import state from './state.js';

/**
 * The "Konto" tab: registered passkeys, recovery codes, sessions and the
 * JSON export/import.
 */

const el = (id) => document.getElementById(id);

function output(node, { lines = [], code = null, isError = false }) {
    node.textContent = '';
    node.hidden = false;
    node.classList.toggle('error', isError);

    if (code) {
        const codeEl = document.createElement('code');
        codeEl.textContent = code;
        node.appendChild(codeEl);
    }
    lines.forEach((line) => {
        const p = document.createElement('p');
        p.textContent = line;
        node.appendChild(p);
    });
}

function outputCodes(node, codes, note) {
    node.textContent = '';
    node.hidden = false;
    node.classList.remove('error');

    const list = document.createElement('ul');
    codes.forEach((code) => {
        const item = document.createElement('li');
        item.textContent = code;
        list.appendChild(item);
    });
    node.appendChild(list);

    const p = document.createElement('p');
    p.textContent = note;
    node.appendChild(p);
}

async function loadCredentials() {
    const list = el('credential-list');
    const status = el('recovery-status');

    try {
        const data = await api('/api/auth/credentials');
        list.textContent = '';

        if (data.credentials.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'credential-empty';
            empty.textContent = 'Keine Passkeys registriert.';
            list.appendChild(empty);
        }

        data.credentials.forEach((credential) => {
            const item = document.createElement('div');
            item.className = 'credential-item';

            const meta = document.createElement('div');
            meta.className = 'credential-meta';

            const name = document.createElement('span');
            name.className = 'credential-name';
            name.textContent = credential.name;
            meta.appendChild(name);

            const detail = document.createElement('span');
            detail.className = 'credential-detail';
            detail.textContent = `Zuletzt benutzt: ${formatDateTime(credential.lastUsedAt)}`
                + ` · Angelegt: ${formatDateTime(credential.createdAt)}`
                + (credential.backedUp ? ' · synchronisiert' : ' · nur auf diesem Gerät');
            meta.appendChild(detail);

            item.appendChild(meta);

            const remove = document.createElement('button');
            remove.className = 'settings-action-btn danger';
            remove.textContent = 'Entfernen';
            remove.disabled = data.credentials.length <= 1;
            remove.title = data.credentials.length <= 1
                ? 'Der letzte Passkey kann nicht entfernt werden'
                : 'Diesen Passkey entfernen';
            remove.addEventListener('click', async () => {
                if (!confirm(`Passkey "${credential.name}" wirklich entfernen?`)) return;
                try {
                    await api(`/api/auth/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
                    loadCredentials();
                } catch (error) {
                    alert(describeError(error));
                }
            });
            item.appendChild(remove);

            list.appendChild(item);
        });

        status.textContent = `${data.recoveryCodes.unused} von ${data.recoveryCodes.total} Recovery-Codes unbenutzt`;
    } catch (error) {
        list.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'credential-empty';
        empty.textContent = describeError(error);
        list.appendChild(empty);
    }
}

async function loadSessions() {
    try {
        const data = await api('/api/auth/sessions');
        const others = data.sessions.filter((session) => !session.current).length;
        el('session-status').textContent = others === 0
            ? 'Nur dieses Gerät ist angemeldet'
            : `${others} weitere${others === 1 ? 's' : ''} Gerät${others === 1 ? '' : 'e'} angemeldet`;
    } catch {
        el('session-status').textContent = 'Sitzungen konnten nicht geladen werden';
    }
}

async function loadAuthLog() {
    const box = el('auth-log');
    try {
        const data = await api('/api/auth/log');
        box.textContent = '';

        if (data.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'credential-empty';
            empty.textContent = 'Keine Einträge.';
            box.appendChild(empty);
            return;
        }

        data.entries.slice(0, 40).forEach((entry) => {
            const row = document.createElement('div');
            row.className = `auth-log-entry${entry.outcome === 'success' ? '' : ' failed'}`;

            const when = document.createElement('span');
            when.className = 'auth-log-when';
            when.textContent = formatDateTime(entry.at);
            row.appendChild(when);

            const what = document.createElement('span');
            what.className = 'auth-log-what';
            what.textContent = `${entry.event} · ${entry.outcome}${entry.ip ? ` · ${entry.ip}` : ''}`;
            row.appendChild(what);

            box.appendChild(row);
        });
    } catch (error) {
        box.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'credential-empty';
        empty.textContent = describeError(error);
        box.appendChild(empty);
    }
}

async function downloadExport() {
    const button = el('export-btn');
    button.disabled = true;
    try {
        // Fetched rather than linked so the session cookie and the JSON error
        // path behave like every other API call.
        const response = await fetch('/api/data/export', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('export failed');

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `tasks-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        output(el('import-output'), { lines: ['Export heruntergeladen.'] });
    } catch {
        output(el('import-output'), { lines: ['Export fehlgeschlagen.'], isError: true });
    } finally {
        button.disabled = false;
    }
}

async function runImport(file) {
    const box = el('import-output');
    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        output(box, { lines: ['Die Datei ist kein gültiges JSON.'], isError: true });
        return;
    }

    const replace = confirm(
        'Import: OK ersetzt ALLE vorhandenen Aufgaben.\n'
        + 'Abbrechen fügt nur neue Aufgaben hinzu und lässt bestehende unberührt.',
    );

    try {
        const result = await api('/api/data/import', {
            method: 'POST',
            body: { data: parsed, mode: replace ? 'replace' : 'merge' },
        });
        output(box, {
            lines: [
                `${result.imported} Aufgabe(n) importiert`
                + (result.skipped ? `, ${result.skipped} übersprungen (ID bereits vorhanden)` : '')
                + `. Modus: ${result.mode === 'replace' ? 'ersetzen' : 'zusammenführen'}.`,
            ],
        });
        await loadSettings();
        syncSettingsUI(state.settings);
        applySettings(state.settings);
        await refreshTasks();
    } catch (error) {
        output(box, { lines: [describeError(error)], isError: true });
    }
}

let bound = false;

export function initAccountTab() {
    if (bound) return;
    bound = true;

    el('new-enrollment-btn').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const data = await api('/api/auth/enrollment-token', { method: 'POST' });
            output(el('enrollment-token-output'), {
                code: data.token,
                lines: [
                    `Gültig bis ${formatDateTime(data.expiresAt)}. Öffne die App auf dem neuen Gerät, `
                    + 'wähle "Neues Gerät anmelden" und gib diesen Token dort ein.',
                ],
            });
        } catch (error) {
            output(el('enrollment-token-output'), { lines: [describeError(error)], isError: true });
        } finally {
            button.disabled = false;
        }
    });

    el('regen-recovery-btn').addEventListener('click', async (event) => {
        if (!confirm('Neue Recovery-Codes erzeugen? Alle bisherigen werden dadurch ungültig.')) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const data = await api('/api/auth/recovery-codes', { method: 'POST' });
            outputCodes(
                el('recovery-codes-output'),
                data.codes,
                'Jeder Code funktioniert genau einmal. Sie werden nie wieder angezeigt.',
            );
            loadCredentials();
        } catch (error) {
            output(el('recovery-codes-output'), { lines: [describeError(error)], isError: true });
        } finally {
            button.disabled = false;
        }
    });

    el('revoke-sessions-btn').addEventListener('click', async (event) => {
        if (!confirm('Alle anderen Geräte abmelden?')) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await api('/api/auth/sessions/revoke-others', { method: 'POST' });
            loadSessions();
        } catch (error) {
            alert(describeError(error));
        } finally {
            button.disabled = false;
        }
    });

    el('export-btn').addEventListener('click', downloadExport);

    el('import-btn').addEventListener('click', () => el('import-file').click());
    el('import-file').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        // Reset so selecting the same file twice fires the event again.
        event.target.value = '';
        if (file) await runImport(file);
    });
}

/** Called whenever the account tab becomes visible. */
export function refreshAccountTab() {
    loadCredentials();
    loadSessions();
    loadAuthLog();
}
