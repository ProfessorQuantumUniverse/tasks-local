import db from '../db.js';
import { noStore } from '../security.js';
import { requireSession } from '../auth/session.js';
import { getOrder, getPreferences, sanitizeOrder, sanitizePreferences } from '../settings.js';
import { REPEAT_TYPES, rowToTask } from './tasks.js';

/**
 * Portable JSON export and import.
 *
 * The export contains tasks and preferences only. Passkeys, sessions and
 * recovery codes are deliberately left out: an export is something the owner
 * may copy around or mail to themselves, and it must not be able to grant
 * access to anyone who reads it.
 */

const EXPORT_VERSION = 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IMPORT_TASKS = 5000;

function cleanTask(input) {
    if (!input || typeof input !== 'object') return null;

    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 500) : '';
    if (!title) return null;

    const id = typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 128
        ? input.id
        : `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const date = (value) => (typeof value === 'string' && DATE_PATTERN.test(value) ? value : null);
    const iso = (value) => {
        if (typeof value !== 'string') return new Date().toISOString();
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    };

    const progress = Number.isInteger(input.progress) ? Math.min(3, Math.max(0, input.progress)) : 0;
    const repeatType = REPEAT_TYPES.includes(input.repeatType) ? input.repeatType : 'none';

    return {
        id,
        title,
        due_date: date(input.dueDate),
        progress,
        repeat_type: repeatType,
        next_due_date: date(input.nextDueDate) ?? date(input.dueDate),
        important: input.important ? 1 : 0,
        created_at: iso(input.createdAt),
        updated_at: iso(input.updatedAt),
    };
}

export default async function dataRoutes(fastify) {
    fastify.addHook('preHandler', requireSession);
    fastify.addHook('onSend', (request, reply, payload, done) => {
        noStore(reply);
        done(null, payload);
    });

    fastify.get('/export', async (request, reply) => {
        const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all();
        const stamp = new Date().toISOString().slice(0, 10);

        reply.header('Content-Disposition', `attachment; filename="tasks-export-${stamp}.json"`);
        reply.type('application/json');

        return reply.send({
            version: EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            tasks: rows.map(rowToTask),
            preferences: getPreferences(),
            order: getOrder(),
        });
    });

    fastify.post(
        '/import',
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['data'],
                    additionalProperties: false,
                    properties: {
                        mode: { type: 'string', enum: ['merge', 'replace'] },
                        data: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                tasks: { type: 'array', maxItems: MAX_IMPORT_TASKS },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            const mode = request.body.mode || 'merge';
            const payload = request.body.data || {};

            const tasks = Array.isArray(payload.tasks)
                ? payload.tasks.slice(0, MAX_IMPORT_TASKS).map(cleanTask).filter(Boolean)
                : [];

            let imported = 0;
            let skipped = 0;

            const insert = db.prepare(
                'INSERT INTO tasks (id, title, due_date, progress, repeat_type, next_due_date, important, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
            const exists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');

            const tx = db.transaction(() => {
                if (mode === 'replace') {
                    db.prepare('DELETE FROM tasks').run();
                }

                for (const task of tasks) {
                    if (mode === 'merge' && exists.get(task.id)) {
                        skipped += 1;
                        continue;
                    }
                    insert.run(
                        task.id,
                        task.title,
                        task.due_date,
                        task.progress,
                        task.repeat_type,
                        task.next_due_date,
                        task.important,
                        task.created_at,
                        task.updated_at,
                    );
                    imported += 1;
                }

                if (payload.preferences && typeof payload.preferences === 'object') {
                    const clean = sanitizePreferences(payload.preferences);
                    db.prepare(
                        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                    ).run('preferences', JSON.stringify(clean));
                }

                if (payload.order !== undefined) {
                    const clean = sanitizeOrder(payload.order);
                    db.prepare(
                        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                    ).run('order', JSON.stringify(clean));
                }
            });
            tx();

            return reply.send({ ok: true, imported, skipped, mode });
        },
    );
}
