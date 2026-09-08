/**
 * Thin API client.
 *
 * Every call is same-origin and relies on the session cookie, so there is no
 * token to keep in JavaScript and nothing for an XSS to read out of storage.
 */

export class ApiError extends Error {
    constructor(status, code, message) {
        super(message || code || `HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

/** Raised when the request never reached the server. */
export class NetworkError extends Error {
    constructor(cause) {
        super('Verbindung zum Server fehlgeschlagen');
        this.name = 'NetworkError';
        this.cause = cause;
    }
}

const listeners = {
    unauthorized: new Set(),
    connection: new Set(),
};

export function onUnauthorized(handler) {
    listeners.unauthorized.add(handler);
}

export function onConnectionChange(handler) {
    listeners.connection.add(handler);
}

let online = true;

function setConnection(next) {
    if (next === online) return;
    online = next;
    listeners.connection.forEach((handler) => handler(online));
}

export function isOnline() {
    return online;
}

/**
 * @param {string} path      API path beginning with /api
 * @param {object} [options] method, body, and whether a 401 should be reported
 */
export async function api(path, { method = 'GET', body, signal, quiet401 = false } = {}) {
    let response;
    try {
        response = await fetch(path, {
            method,
            // Same-origin is the default, but being explicit documents that no
            // credentials are ever sent cross-origin.
            credentials: 'same-origin',
            headers: body === undefined
                ? { Accept: 'application/json' }
                : { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw error;
        setConnection(false);
        throw new NetworkError(error);
    }

    setConnection(true);

    if (response.status === 204) return null;

    let payload = null;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
    }

    if (!response.ok) {
        if (response.status === 401 && !quiet401) {
            listeners.unauthorized.forEach((handler) => handler());
        }
        throw new ApiError(response.status, payload?.error, payload?.error);
    }

    return payload;
}

/** Human readable German text for the error codes the API returns. */
export function describeError(error) {
    if (error instanceof NetworkError) {
        return 'Keine Verbindung zum Server.';
    }
    if (!(error instanceof ApiError)) {
        return 'Unerwarteter Fehler.';
    }
    switch (error.code) {
        case 'rate_limited':
            return 'Zu viele Versuche. Bitte warte einen Moment.';
        case 'enrollment_token_invalid':
            return 'Der Enrollment-Token ist ungültig, abgelaufen oder bereits benutzt.';
        case 'registration_failed':
            return 'Registrierung fehlgeschlagen. Versuche es erneut.';
        case 'authentication_failed':
            return 'Anmeldung fehlgeschlagen.';
        case 'recovery_failed':
            return 'Dieser Recovery-Code ist ungültig oder schon benutzt.';
        case 'setup_required':
            return 'Es ist noch kein Passkey registriert.';
        case 'last_credential':
            return 'Der letzte Passkey kann nicht entfernt werden.';
        case 'cross_origin_request_blocked':
        case 'missing_origin':
            return 'Anfrage blockiert. Öffne die App über ihre konfigurierte Adresse.';
        case 'unauthenticated':
            return 'Sitzung abgelaufen. Bitte melde dich neu an.';
        case 'invalid_request':
            return 'Ungültige Eingabe.';
        default:
            return 'Der Server hat die Anfrage abgelehnt.';
    }
}
