import { randomUUID } from 'node:crypto';
import db from '../db.js';
import { noStore } from '../security.js';
import { requireSession } from '../auth/session.js';

/**
 * Task CRUD.
 *
 * Recurring tasks are rescheduled here rather than in the browser: the client
 * used to do it, which meant the rollover only happened on a device that
 * happened to be open, and two devices could race each other.
 */

const REPEAT_TYPES = ['none', 'daily', 'every2days', 'every3days', 'weekly', 'monthly'];
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const taskBody = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string', minLength: 1, maxLength: 500 },
        dueDate: { type: ['string', 'null'], pattern: DATE_PATTERN },
        repeatType: { type: 'string', enum: REPEAT_TYPES },
        progress: { type: 'integer', minimum: 0, maximum: 3 },
        important: { type: 'boolean' },
    },
};

export function rowToTask(row) {
    return {
        id: row.id,
        title: row.title,
        dueDate: row.due_date,
        progress: row.progress,
        repeatType: row.repeat_type,
        nextDueDate: row.next_due_date,
        important: !!row.important,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Local calendar date as YYYY-MM-DD, honouring the container's TZ. */
export function todayString(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function addDays(dateString, days) {
    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return todayString(date);
}

export function calculateNextDueDate(dateString, repeatType) {
    if (!dateString) return null;
    const [y, m, d] = dateString.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    switch (repeatType) {
        case 'daily': date.setDate(date.getDate() + 1); break;
        case 'every2days': date.setDate(date.getDate() + 2); break;
        case 'every3days': date.setDate(date.getDate() + 3); break;
        case 'weekly': date.setDate(date.getDate() + 7); break;
        case 'monthly': date.setMonth(date.getMonth() + 1); break;
        default: return dateString;
    }
    return todayString(date);
}

/**
 * Roll finished recurring tasks forward to their next occurrence.
 * Returns the number of tasks that changed.
 */
export function applyRecurringRollover() {
    const today = todayString();
    const rows = db
        .prepare(
            "SELECT * FROM tasks WHERE repeat_type != 'none' AND progress = 3 AND next_due_date IS NOT NULL AND next_due_date <= ?",
        )
        .all(today);

    if (rows.length === 0) return 0;

    const update = db.prepare(
        'UPDATE tasks SET progress = 0, due_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?',
    );
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
        for (const row of rows) {
            // Advance repeatedly so a task left untouched for a while lands on
            // an upcoming date rather than one still in the past.
            let next = row.next_due_date;
            let guard = 0;
            do {
                next = calculateNextDueDate(next, row.repeat_type);
                guard += 1;
            } while (next && next <= today && guard < 500);
            update.run(next, next, now, row.id);
        }
    });
    tx();

    return rows.length;
}

export default async function taskRoutes(fastify) {
    fastify.addHook('preHandler', requireSession);
    fastify.addHook('onSend', (request, reply, payload, done) => {
        noStore(reply);
        done(null, payload);
    });

    fastify.get('/', async (request, reply) => {
        applyRecurringRollover();
        const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
        return reply.send({
            tasks: rows.map(rowToTask),
            serverTime: new Date().toISOString(),
        });
    });

    fastify.post(
        '/',
        {
            schema: {
                body: {
                    ...taskBody,
                    required: ['title'],
                },
            },
        },
        async (request, reply) => {
            const now = new Date().toISOString();
            const id = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
            const dueDate = request.body.dueDate || null;
            const repeatType = request.body.repeatType || 'none';

            db.prepare(
                'INSERT INTO tasks (id, title, due_date, progress, repeat_type, next_due_date, important, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(id, request.body.title.trim(), dueDate, 0, repeatType, dueDate, 0, now, now);

            const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
            return reply.code(201).send({ task: rowToTask(row) });
        },
    );

    fastify.patch(
        '/:id',
        {
            schema: {
                body: {
                    ...taskBody,
                    properties: {
                        ...taskBody.properties,
                        // Set by the progress handler; accepted so an import or
                        // a manual correction can adjust it too.
                        nextDueDate: { type: ['string', 'null'], pattern: DATE_PATTERN },
                    },
                },
            },
        },
        async (request, reply) => {
            const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
            if (!row) return reply.code(404).send({ error: 'not_found' });

            const patch = request.body || {};
            const next = {
                title: patch.title !== undefined ? patch.title.trim() : row.title,
                due_date: patch.dueDate !== undefined ? patch.dueDate : row.due_date,
                progress: patch.progress !== undefined ? patch.progress : row.progress,
                repeat_type: patch.repeatType !== undefined ? patch.repeatType : row.repeat_type,
                next_due_date: patch.nextDueDate !== undefined ? patch.nextDueDate : row.next_due_date,
                important: patch.important !== undefined ? (patch.important ? 1 : 0) : row.important,
            };

            // Completing a repeating task schedules the next occurrence.
            if (
                patch.progress === 3
                && next.repeat_type !== 'none'
                && next.due_date
                && patch.nextDueDate === undefined
            ) {
                next.next_due_date = calculateNextDueDate(next.due_date, next.repeat_type);
            }

            // Moving the due date of a non-repeating task keeps the two in sync.
            if (patch.dueDate !== undefined && next.repeat_type === 'none') {
                next.next_due_date = patch.dueDate;
            }

            db.prepare(
                'UPDATE tasks SET title = ?, due_date = ?, progress = ?, repeat_type = ?, next_due_date = ?, important = ?, updated_at = ? WHERE id = ?',
            ).run(
                next.title,
                next.due_date,
                next.progress,
                next.repeat_type,
                next.next_due_date,
                next.important,
                new Date().toISOString(),
                request.params.id,
            );

            const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
            return reply.send({ task: rowToTask(updated) });
        },
    );

    /** Shift the due date one day into the future. */
    fastify.post('/:id/postpone', async (request, reply) => {
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
        if (!row) return reply.code(404).send({ error: 'not_found' });

        const base = row.due_date || todayString();
        const newDue = addDays(base, 1);

        db.prepare('UPDATE tasks SET due_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?').run(
            newDue,
            newDue,
            new Date().toISOString(),
            request.params.id,
        );

        const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
        return reply.send({ task: rowToTask(updated) });
    });

    fastify.delete('/:id', async (request, reply) => {
        const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(request.params.id);
        if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
        return reply.send({ ok: true });
    });
}

export { REPEAT_TYPES };
