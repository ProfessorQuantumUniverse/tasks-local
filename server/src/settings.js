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

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * What each non-boolean preference is allowed to be.
 *
 * These values do not stay data: the browser writes them into CSS custom
 * properties and into class names, and an import file is a preference blob from
 * an untrusted source. Accepting "some string of at most N characters" would
 * mean whatever ends up in `--card-border-style` or `--filled-symbol` is
 * whatever the file said. The lists mirror the choices the settings UI offers
 * (web/index.html), so anything reachable through the app still round-trips.
 */

// Same list as the one routes/tasks.js validates repeatType against; kept here
// rather than imported so this module does not depend on a route.
const REPEAT_TYPES = ['none', 'daily', 'every2days', 'every3days', 'weekly', 'monthly'];

const CONSTRAINTS = {
    fontFamily: { enum: ['Exo 2', 'Orbitron', 'Audiowide', 'Nasalization', 'Rajdhani', 'Inter', 'Share Tech Mono', 'JetBrains Mono', 'Press Start 2P', 'VT323'] },
    accentColor: { pattern: HEX_COLOUR },
    cardBackground: { enum: ['jet', 'dark', 'deep', 'charcoal'] },
    animationSpeed: { enum: ['normal', 'slow', 'fast', 'off'] },
    backgroundPattern: { enum: ['none', 'dots', 'grid'] },
    borderStyle: { enum: ['solid', 'dashed', 'double'] },
    progressBoxShape: { enum: ['rounded', 'square', 'pill'] },
    accentGlow: { enum: ['normal', 'dim', 'intense', 'off'] },
    progressStyle: { enum: ['boxes', 'bar'] },
    filledBoxSymbol: { enum: ['✓', '✦', '★', '▓', '⚡', '●'] },
    importantPulseSpeed: { enum: ['slow', 'medium', 'fast'] },
    cardEntryAnim: { enum: ['pop', 'fade', 'slide', 'none'] },
    dateFormat: { enum: ['de', 'iso'] },
    defaultRepeatType: { enum: REPEAT_TYPES },
    firstDayOfWeek: { enum: ['monday', 'sunday'] },

    // Ranges match the sliders in the settings UI. Out-of-range numbers are
    // clamped rather than dropped, so a value from a slightly older or newer
    // export lands on the nearest legal one instead of silently resetting.
    fontSize: { min: 13, max: 19 },
    cardRadius: { min: 0, max: 28 },
    borderWidth: { min: 0, max: 4 },
    cardSpacing: { min: 8, max: 24 },
    taskTitleSize: { min: 16, max: 26 },
    dueDateWarningDays: { min: 1, max: 14 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Drop unknown keys, anything of the wrong type, and anything outside the set
 * of values the app itself can produce.
 */
export function sanitizePreferences(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_SETTINGS };

    const result = { ...DEFAULT_SETTINGS };
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const value = input[key];
        const rule = CONSTRAINTS[key];

        if (typeof fallback === 'boolean') {
            if (typeof value === 'boolean') result[key] = value;
        } else if (typeof fallback === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            const rounded = Math.round(value);
            result[key] = rule ? clamp(rounded, rule.min, rule.max) : rounded;
        } else if (typeof fallback === 'string') {
            if (typeof value !== 'string') continue;
            if (rule?.enum) {
                if (rule.enum.includes(value)) result[key] = value;
            } else if (rule?.pattern) {
                if (rule.pattern.test(value)) result[key] = value.toLowerCase();
            }
            // A string preference with no rule is a bug in this table, not a
            // reason to store an unchecked value: keep the default.
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
    // Sanitised on the way out as well: rows written by an older build predate
    // these rules, and nothing should reach the browser unchecked because of
    // when it happened to be stored.
    return sanitizePreferences(readJson('preferences') || {});
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
