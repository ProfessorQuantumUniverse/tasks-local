import config from './config.js';

/**
 * Cross-site request forgery defence.
 *
 * Two independent layers guard state-changing requests:
 *  1. The session cookie is SameSite=Lax, so a cross-site form or fetch does
 *     not carry it in the first place.
 *  2. This check, which requires the request to prove same-origin intent.
 *
 * Modern browsers always attach `Origin` to non-GET requests, so a missing
 * origin on a write is treated as hostile rather than waved through.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function enforceSameOrigin(request, reply, done) {
    if (SAFE_METHODS.has(request.method)) {
        done();
        return;
    }

    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];

    if (origin) {
        if (origin !== config.origin) {
            reply.code(403).send({ error: 'cross_origin_request_blocked' });
            return;
        }
        done();
        return;
    }

    // No Origin header. Only accept it when the browser explicitly says the
    // request did not come from another site.
    if (fetchSite === 'same-origin' || fetchSite === 'none') {
        done();
        return;
    }

    reply.code(403).send({ error: 'missing_origin' });
}

/**
 * Content Security Policy.
 *
 * Everything the page needs is served from this origin, so no external host is
 * allowed at all. That also means a successful HTML injection cannot pull in a
 * remote script or exfiltrate to a third party endpoint.
 */
export const contentSecurityPolicy = {
    useDefaults: false,
    directives: {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
        'object-src': ["'none'"],
        'worker-src': ["'none'"],
        ...(config.cookie.secure ? { 'upgrade-insecure-requests': [] } : {}),
    },
};

export const helmetOptions = {
    contentSecurityPolicy,
    crossOriginEmbedderPolicy: false, // not needed, and breaks nothing here
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    originAgentCluster: true,
    hidePoweredBy: true,
    strictTransportSecurity: config.hstsEnabled
        ? { maxAge: 63072000, includeSubDomains: true, preload: false }
        : false,
};

/** Headers helmet does not cover. */
export function extraSecurityHeaders(request, reply, payload, done) {
    reply.header(
        'Permissions-Policy',
        // publickey-credentials-get must stay enabled for WebAuthn itself.
        'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), ' +
        'geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), ' +
        'usb=(), xr-spatial-tracking=(), interest-cohort=()',
    );
    done(null, payload);
}

/** Never cache anything the API returns. */
export function noStore(reply) {
    reply.header('Cache-Control', 'no-store, max-age=0');
    reply.header('Pragma', 'no-cache');
}
