import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from './config.js';
import { credentialCount, pruneExpired } from './db.js';
import { enforceSameOrigin, extraSecurityHeaders, helmetOptions } from './security.js';
import { buildStaticIndex, registerStatic } from './static.js';
import { issueEnrollmentToken } from './auth/enrollment.js';
import authRoutes from './routes/auth.js';
import taskRoutes from './routes/tasks.js';
import settingsRoutes from './routes/settings.js';
import dataRoutes from './routes/data.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');

const fastify = Fastify({
    logger: {
        level: config.logLevel,
        // Never let a cookie or authorization header reach the log file.
        redact: {
            paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            remove: true,
        },
        serializers: {
            req(request) {
                return {
                    method: request.method,
                    url: request.url,
                    remoteAddress: request.ip,
                };
            },
        },
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimit,
    ajv: {
        customOptions: {
            // Fastify's defaults quietly strip unknown properties and coerce
            // types. Both are turned off so a body that does not match the
            // schema is rejected outright instead of being silently reshaped.
            removeAdditional: false,
            coerceTypes: false,
            useDefaults: false,
        },
    },
    routerOptions: {
        ignoreTrailingSlash: true,
    },
});

// ── Global error handling ─────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
    // Plugins may throw plain objects rather than Errors, so read the status
    // from either shape before deciding this is an unexpected failure.
    const status = error.statusCode || error.status || 500;

    if (status >= 500) {
        request.log.error({ err: error }, 'request failed');
        return reply.code(500).send({ error: 'internal_error' });
    }

    // Schema validation failures are safe to name but not to detail.
    if (error.validation) {
        return reply.code(400).send({ error: 'invalid_request' });
    }

    // Plugins that build their own payload (rate limiting) carry the code in
    // `error`; Fastify's own errors carry it in `code`.
    const code = typeof error.error === 'string' ? error.error : error.code;
    return reply.code(status).send({ error: code || 'request_failed' });
});

fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
});

async function start() {
    await fastify.register(helmet, helmetOptions);
    await fastify.register(cookie, {
        // Cookies here are opaque random tokens verified against the database,
        // so there is nothing to sign.
        parseOptions: {},
    });

    await fastify.register(rateLimit, {
        global: true,
        max: 300,
        timeWindow: '1 minute',
        // request.ip already honours the trusted proxy configuration.
        keyGenerator: (request) => request.ip,
        addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
        addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': true },
        // statusCode must be part of the payload: without it the thrown object
        // reaches the error handler with no status and is reported as a 500.
        errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited' }),
    });

    fastify.addHook('onRequest', enforceSameOrigin);
    fastify.addHook('onSend', extraSecurityHeaders);

    // ── API ───────────────────────────────────────────────────────────────
    await fastify.register(authRoutes, { prefix: '/api/auth' });
    await fastify.register(taskRoutes, { prefix: '/api/tasks' });
    await fastify.register(settingsRoutes, { prefix: '/api/settings' });
    await fastify.register(dataRoutes, { prefix: '/api/data' });

    fastify.get('/healthz', { config: { rateLimit: false } }, async (request, reply) => reply
        .header('Cache-Control', 'no-store')
        .send({ status: 'ok' }));

    // ── Static frontend ───────────────────────────────────────────────────
    // Registered last so that /api/* is matched by the routes above.
    const staticIndex = await buildStaticIndex(webRoot);
    registerStatic(fastify, staticIndex);
    fastify.log.info({ files: staticIndex.size }, 'static assets indexed');

    // ── First run ─────────────────────────────────────────────────────────
    if (credentialCount() === 0) {
        const { token, expiresAt } = issueEnrollmentToken({ label: 'first-run', ttlMinutes: 60 });
        fastify.log.warn(
            '\n'
            + '='.repeat(72)
            + '\n  SETUP REQUIRED - no passkey is registered yet.\n'
            + `  Open ${config.origin} and enter this one-time enrollment token:\n\n`
            + `      ${token}\n\n`
            + `  Valid until ${expiresAt}.\n`
            + '  Generate a new one with:  docker compose exec app node src/cli.js enroll\n'
            + '='.repeat(72),
        );
    }

    pruneExpired();
    const pruneTimer = setInterval(pruneExpired, 15 * 60 * 1000);
    pruneTimer.unref();

    await fastify.listen({ host: config.host, port: config.port });

    fastify.log.info(
        {
            origin: config.origin,
            rpID: config.rpID,
            cookieSecure: config.cookie.secure,
            sessionTtlDays: config.session.ttlDays,
        },
        'tasks server ready',
    );
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
        fastify.log.info(`${signal} received, shutting down`);
        try {
            await fastify.close();
        } finally {
            process.exit(0);
        }
    });
}

start().catch((error) => {
    fastify.log.error({ err: error }, 'failed to start');
    process.exit(1);
});
