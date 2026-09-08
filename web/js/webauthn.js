/**
 * WebAuthn browser glue.
 *
 * The credential API speaks ArrayBuffers while the server speaks base64url
 * JSON, so the conversion happens here. Written by hand rather than pulled from
 * a package: it is about forty lines and keeps a security critical path free of
 * a third party dependency.
 */

function base64urlToBuffer(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** True when the browser can do passkeys at all in this context. */
export function isSupported() {
    return typeof window.PublicKeyCredential === 'function'
        && typeof navigator.credentials?.create === 'function'
        && window.isSecureContext;
}

/** Why passkeys are unavailable, phrased for the person looking at the screen. */
export function unsupportedReason() {
    if (!window.isSecureContext) {
        return 'Passkeys brauchen eine sichere Verbindung. Öffne die App über ihre https-Adresse.';
    }
    return 'Dieser Browser unterstützt keine Passkeys.';
}

export async function createCredential(optionsJSON) {
    const publicKey = {
        ...optionsJSON,
        challenge: base64urlToBuffer(optionsJSON.challenge),
        user: {
            ...optionsJSON.user,
            id: base64urlToBuffer(optionsJSON.user.id),
        },
        excludeCredentials: (optionsJSON.excludeCredentials || []).map((credential) => ({
            ...credential,
            id: base64urlToBuffer(credential.id),
        })),
    };

    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) throw new Error('no credential returned');

    return {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        response: {
            clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
            attestationObject: bufferToBase64url(credential.response.attestationObject),
            transports: typeof credential.response.getTransports === 'function'
                ? credential.response.getTransports()
                : [],
        },
    };
}

export async function getCredential(optionsJSON) {
    const publicKey = {
        ...optionsJSON,
        challenge: base64urlToBuffer(optionsJSON.challenge),
        allowCredentials: (optionsJSON.allowCredentials || []).map((credential) => ({
            ...credential,
            id: base64urlToBuffer(credential.id),
        })),
    };

    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error('no credential returned');

    return {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        response: {
            clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
            authenticatorData: bufferToBase64url(credential.response.authenticatorData),
            signature: bufferToBase64url(credential.response.signature),
            userHandle: credential.response.userHandle
                ? bufferToBase64url(credential.response.userHandle)
                : undefined,
        },
    };
}

/** The user dismissing the OS prompt is not an error worth shouting about. */
export function isCancellation(error) {
    return error?.name === 'NotAllowedError' || error?.name === 'AbortError';
}
