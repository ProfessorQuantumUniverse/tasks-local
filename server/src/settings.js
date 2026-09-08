import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from './db.js';

/**
 * User preferences.
 *
 * The defaults file is the single source of truth for which keys exist and what
 * type each one has; the browser receives it from the API rather than keeping a
 * second copy that could drift.
 */

const here = dirname(fileURLToPath(import.meta.url));
const defaultsPath = join(here, '..', '..', 'shared', 'settings-defaults.json');

export const DEFAULT_SETTINGS = Object.freeze(JSON.parse(readFileSync(defaultsPath, 'utf8')));

const MAX_STRING_LENGTH = 120;

/**
 * Drop unknown keys and anything of the wrong type.
 *
 * A preference blob is stored verbatim and later fed straight into the DOM, so
 * only values shaped like the defaults are allowed through.
 */
export function sanitizePreferences(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_SETTINGS };

    const result = { ...DEFAULT_SETTINGS };
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const value = input[key];

        if (typeof fallback === 'boolean') {
            if (typeof value === 'boolean') result[key] = value;
        } else if (typeof fallback === 'number') {
            if (typeof value === 'number' && Number.isFinite(value)) {
                result[key] = Math.round(value);
            }
        } else if (typeof fallback === 'string') {
            if (typeof value === 'string' && value.length <= MAX_STRING_LENGTH) {
                result[key] = value;
            }
        }
    }
    return result;
}

/** The custom order is a flat list of task ids. */
export function sanitizeOrder(input) {
    if (input === null || input === undefined) return null;
    if (!Array.isArray(input)) return null;
    const ids = input
        .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
        .slice(0, 5000);
    return ids.length > 0 ? ids : null;
}

function readJson(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try {
        return JSON.parse(row.value);
    } catch {
        return null;
    }
}

function writeJson(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        JSON.stringify(value),
    );
}

export function getPreferences() {
    return { ...DEFAULT_SETTINGS, ...(readJson('preferences') || {}) };
}

export function setPreferences(input) {
    const clean = sanitizePreferences(input);
    writeJson('preferences', clean);
    return clean;
}

export function getOrder() {
    return readJson('order');
}

export function setOrder(input) {
    const clean = sanitizeOrder(input);
    writeJson('order', clean);
    return clean;
}
