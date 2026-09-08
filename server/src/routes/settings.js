import { noStore } from '../security.js';
import { requireSession } from '../auth/session.js';
import {
    DEFAULT_SETTINGS,
    getOrder,
    getPreferences,
    setOrder,
    setPreferences,
} from '../settings.js';

export default async function settingsRoutes(fastify) {
    fastify.addHook('preHandler', requireSession);
    fastify.addHook('onSend', (request, reply, payload, done) => {
        noStore(reply);
        done(null, payload);
    });

    fastify.get('/', async (request, reply) => reply.send({
        preferences: getPreferences(),
        order: getOrder(),
        // Sent along so the browser never needs its own copy of the defaults.
        defaults: DEFAULT_SETTINGS,
    }));

    fastify.put(
        '/preferences',
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['preferences'],
                    additionalProperties: false,
                    properties: { preferences: { type: 'object' } },
                },
            },
        },
        async (request, reply) => reply.send({ preferences: setPreferences(request.body.preferences) }),
    );

    fastify.put(
        '/order',
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['order'],
                    additionalProperties: false,
                    properties: {
                        order: {
                            type: ['array', 'null'],
                            maxItems: 5000,
                            items: { type: 'string', maxLength: 128 },
                        },
                    },
                },
            },
        },
        async (request, reply) => reply.send({ order: setOrder(request.body.order) }),
    );
}
