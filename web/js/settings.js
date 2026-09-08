import state from './state.js';
import { api } from './api.js';
import { hexToRgb } from './util.js';
import { startMatrixRain, stopMatrixRain } from './effects.js';

/**
 * Preferences: applying them to the DOM, and the settings modal.
 *
 * The defaults live on the server and arrive with the first GET, so this file
 * never carries a second copy that could drift from it.
 */

const CARD_BG_MAP = { jet: '#0a0a0a', dark: '#111111', deep: '#050505', charcoal: '#141414' };

const FONT_STACK_MAP = {
    'Exo 2': "'Exo 2', sans-serif",
    Orbitron: "'Orbitron', sans-serif",
    Audiowide: "'Audiowide', sans-serif",
    Nasalization: "'Nasalization', sans-serif",
    Rajdhani: "'Rajdhani', sans-serif",
    Inter: "'Inter', sans-serif",
    'Share Tech Mono': "'Share Tech Mono', monospace",
    'JetBrains Mono': "'JetBrains Mono', monospace",
    'Press Start 2P': "'Press Start 2P', monospace",
    VT323: "'VT323', monospace",
};

/** Enough of a theme for the login screen, before any API call has happened. */
export const BOOTSTRAP_SETTINGS = {
    accentColor: '#00ff88',
    fontFamily: 'Exo 2',
    fontSize: 16,
    cardRadius: 20,
    borderWidth: 2,
    cardBackground: 'jet',
    cardSpacing: 16,
    taskTitleSize: 20,
    animationSpeed: 'normal',
    backgroundPattern: 'none',
    accentGlow: 'normal',
    borderStyle: 'solid',
    progressBoxShape: 'rounded',
    filledBoxSymbol: '✓',
    importantPulseSpeed: 'medium',
    cardEntryAnim: 'pop',
    dateFormat: 'de',
    dueDateWarningDays: 3,
    vibrationFeedback: true,
};

let onRerender = () => {};

/** Let the task renderer register itself without creating an import cycle. */
export function setRerenderHandler(handler) {
    onRerender = handler;
}

export function applySettings(s) {
    const root = document.documentElement;
    root.style.setProperty('--accent', s.accentColor);
    root.style.setProperty('--accent-rgb', hexToRgb(s.accentColor));
    root.style.setProperty('--font-ui', FONT_STACK_MAP[s.fontFamily] || "'Exo 2', sans-serif");
    root.style.setProperty('--font-size-base', `${s.fontSize}px`);
    root.style.setProperty('--card-radius', `${s.cardRadius}px`);
    root.style.setProperty('--card-border-w', `${s.borderWidth}px`);
    root.style.setProperty('--card-bg', CARD_BG_MAP[s.cardBackground] || '#0a0a0a');
    root.style.setProperty('--card-spacing', `${s.cardSpacing}px`);
    root.style.setProperty('--title-size', `${s.taskTitleSize}px`);

    const { body } = document;
    body.classList.toggle('pref-no-hover-lift', !s.hoverLift);
    body.classList.toggle('pref-no-glow', !s.cardGlow);
    body.classList.toggle('pref-no-progress-text', !s.showProgressText);
    body.classList.toggle('pref-no-repeat-badge', !s.showRepeatBadge);
    body.classList.toggle('pref-no-postpone', !s.showPostponeBtn);
    body.classList.toggle('pref-no-due-badge', !s.showDueBadge);
    body.classList.toggle('pref-urgent-red', !!s.urgentRedTint);
    body.classList.toggle('pref-focus-mode', !!s.focusMode);
    body.classList.toggle('pref-compact', !!s.compactMode);
    body.classList.toggle('pref-glass', !!s.glassmorphism);
    body.classList.toggle('pref-section-count', !!s.sectionCountBadge);
    body.classList.toggle('pref-show-created', !!s.showCreatedDate);

    body.classList.remove('pref-bg-dots', 'pref-bg-grid');
    if (s.backgroundPattern === 'dots') body.classList.add('pref-bg-dots');
    else if (s.backgroundPattern === 'grid') body.classList.add('pref-bg-grid');

    body.classList.remove('pref-anim-off', 'pref-anim-slow', 'pref-anim-fast');
    if (s.animationSpeed === 'off') body.classList.add('pref-anim-off');
    else if (s.animationSpeed === 'slow') body.classList.add('pref-anim-slow');
    else if (s.animationSpeed === 'fast') body.classList.add('pref-anim-fast');

    state.crossCategoryDragLocked = !s.crossDragDefault;
    const lockBtn = document.getElementById('lock-btn');
    if (lockBtn) {
        const lockIcon = lockBtn.querySelector('.material-symbols-outlined');
        if (lockIcon) lockIcon.textContent = state.crossCategoryDragLocked ? 'lock' : 'lock_open';
        lockBtn.classList.toggle('unlocked', !state.crossCategoryDragLocked);
    }

    const repeatSelect = document.getElementById('task-repeat');
    if (repeatSelect && repeatSelect.value === 'none' && s.defaultRepeatType) {
        repeatSelect.value = s.defaultRepeatType;
    }

    root.style.setProperty('--card-border-style', s.borderStyle || 'solid');
    const shapeMap = { rounded: '12px', square: '0px', pill: '50px' };
    root.style.setProperty('--progress-box-radius', shapeMap[s.progressBoxShape] || '12px');
    root.style.setProperty('--filled-symbol', `"${s.filledBoxSymbol || '✓'}"`);
    const pulseSpeedMap = { slow: '3.5s', medium: '2s', fast: '0.9s' };
    root.style.setProperty('--pulse-duration', pulseSpeedMap[s.importantPulseSpeed] || '2s');

    body.classList.toggle('pref-neon', !!s.neonGlow);
    body.classList.toggle('pref-scanlines', !!s.scanlines);
    body.classList.toggle('pref-urgent-blink', !!s.urgentBlink);
    body.classList.toggle('pref-tilt', !!s.cardTiltOnHover);
    body.classList.toggle('pref-matrix', !!s.matrixBg);
    body.classList.toggle('pref-show-updated', !!s.showLastUpdated);

    body.classList.remove('pref-glow-off', 'pref-glow-dim', 'pref-glow-intense');
    if (s.accentGlow === 'off') body.classList.add('pref-glow-off');
    else if (s.accentGlow === 'dim') body.classList.add('pref-glow-dim');
    else if (s.accentGlow === 'intense') body.classList.add('pref-glow-intense');

    body.classList.remove('pref-entry-pop', 'pref-entry-fade', 'pref-entry-slide');
    if (s.cardEntryAnim === 'pop') body.classList.add('pref-entry-pop');
    else if (s.cardEntryAnim === 'fade') body.classList.add('pref-entry-fade');
    else if (s.cardEntryAnim === 'slide') body.classList.add('pref-entry-slide');

    if (s.matrixBg) startMatrixRain();
    else stopMatrixRain();
}

// Range sliders fire on every pixel; collapse the writes into one request.
let saveTimer = null;
let savePending = false;

export function saveSettings({ immediate = false } = {}) {
    savePending = true;
    if (saveTimer) clearTimeout(saveTimer);

    const flush = async () => {
        saveTimer = null;
        if (!savePending) return;
        savePending = false;
        try {
            await api('/api/settings/preferences', {
                method: 'PUT',
                body: { preferences: state.settings },
            });
        } catch (error) {
            // A failed preference write is not worth interrupting the user for;
            // the next change retries and the connection banner already shows.
            console.warn('Einstellungen konnten nicht gespeichert werden', error);
        }
    };

    if (immediate) return flush();
    saveTimer = setTimeout(flush, 400);
    return Promise.resolve();
}

export async function saveCustomOrder() {
    try {
        await api('/api/settings/order', { method: 'PUT', body: { order: state.order } });
    } catch (error) {
        console.warn('Reihenfolge konnte nicht gespeichert werden', error);
    }
}

export async function loadSettings() {
    const data = await api('/api/settings');
    state.defaults = data.defaults;
    state.settings = { ...data.defaults, ...data.preferences };
    state.order = Array.isArray(data.order) ? data.order : null;
    applySettings(state.settings);
    return state.settings;
}

// ── Settings modal ────────────────────────────────────────────────────────

const SELECT_BINDINGS = [
    ['s-fontFamily', 'fontFamily', false],
    ['s-cardBackground', 'cardBackground', false],
    ['s-animationSpeed', 'animationSpeed', false],
    ['s-backgroundPattern', 'backgroundPattern', false],
    ['s-progressStyle', 'progressStyle', true],
    ['s-dateFormat', 'dateFormat', false],
    ['s-defaultRepeatType', 'defaultRepeatType', false],
    ['s-firstDayOfWeek', 'firstDayOfWeek', false],
    ['s-borderStyle', 'borderStyle', false],
    ['s-progressBoxShape', 'progressBoxShape', true],
    ['s-filledBoxSymbol', 'filledBoxSymbol', true],
    ['s-importantPulseSpeed', 'importantPulseSpeed', false],
    ['s-cardEntryAnim', 'cardEntryAnim', false],
    ['s-accentGlow', 'accentGlow', false],
];

const RANGE_BINDINGS = [
    ['s-fontSize', 'fontSize', false, 'px'],
    ['s-cardRadius', 'cardRadius', false, 'px'],
    ['s-borderWidth', 'borderWidth', false, 'px'],
    ['s-cardSpacing', 'cardSpacing', false, 'px'],
    ['s-taskTitleSize', 'taskTitleSize', false, 'px'],
    ['s-dueDateWarningDays', 'dueDateWarningDays', true, 'd'],
];

const TOGGLE_BINDINGS = [
    ['s-cardGlow', 'cardGlow', false],
    ['s-hoverLift', 'hoverLift', false],
    ['s-showProgressText', 'showProgressText', false],
    ['s-showRepeatBadge', 'showRepeatBadge', false],
    ['s-showPostponeBtn', 'showPostponeBtn', false],
    ['s-showDueBadge', 'showDueBadge', false],
    ['s-showCreatedDate', 'showCreatedDate', false],
    ['s-urgentRedTint', 'urgentRedTint', false],
    ['s-confirmDelete', 'confirmDelete', false],
    ['s-showConfetti', 'showConfetti', false],
    ['s-showTaskCount', 'showTaskCount', true],
    ['s-crossDragDefault', 'crossDragDefault', false],
    ['s-autoSortNew', 'autoSortNew', false],
    ['s-focusMode', 'focusMode', true],
    ['s-compactMode', 'compactMode', false],
    ['s-reverseSortOrder', 'reverseSortOrder', true],
    ['s-glassmorphism', 'glassmorphism', false],
    ['s-sectionCountBadge', 'sectionCountBadge', true],
    ['s-neonGlow', 'neonGlow', false],
    ['s-scanlines', 'scanlines', false],
    ['s-cardTiltOnHover', 'cardTiltOnHover', false],
    ['s-urgentBlink', 'urgentBlink', false],
    ['s-deletionDelay', 'deletionDelay', false],
    ['s-vibrationFeedback', 'vibrationFeedback', false],
    ['s-hexProgress', 'hexProgress', true],
    ['s-matrixBg', 'matrixBg', false],
    ['s-showLastUpdated', 'showLastUpdated', false],
];

export function syncSettingsUI(s) {
    const g = (id) => document.getElementById(id);

    SELECT_BINDINGS.forEach(([id, key]) => {
        const el = g(id);
        if (el && s[key] !== undefined) el.value = s[key];
    });

    RANGE_BINDINGS.forEach(([id, key, , unit]) => {
        const range = g(id);
        const label = g(`${id}-val`);
        if (range) range.value = s[key];
        if (label) label.textContent = `${s[key]}${unit}`;
    });

    const colorEl = g('s-accentColor');
    if (colorEl) colorEl.value = s.accentColor;

    TOGGLE_BINDINGS.forEach(([id, key]) => {
        const toggle = g(id);
        if (toggle) toggle.classList.toggle('on', !!s[key]);
    });
}

let modalInitialised = false;

export function initSettingsModal({ onTabChange } = {}) {
    if (modalInitialised) return;
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    modalInitialised = true;

    const openBtn = document.getElementById('settings-btn');
    const closeBtn = document.getElementById('settings-close-btn');
    const resetBtn = document.getElementById('settings-reset-btn');

    openBtn.addEventListener('click', () => {
        modal.classList.add('active');
        syncSettingsUI(state.settings);
    });
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.classList.remove('active');
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') modal.classList.remove('active');
    });

    resetBtn.addEventListener('click', async () => {
        if (!confirm('Alle Einstellungen zurücksetzen?')) return;
        state.settings = { ...state.defaults };
        await saveSettings({ immediate: true });
        applySettings(state.settings);
        syncSettingsUI(state.settings);
        onRerender();
    });

    document.querySelectorAll('.settings-tab-btn').forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.tab;
            document.querySelectorAll('.settings-tab-btn').forEach((other) => {
                other.classList.toggle('active', other.dataset.tab === name);
            });
            document.querySelectorAll('.settings-tab-pane').forEach((pane) => {
                pane.classList.toggle('active', pane.dataset.tab === name);
            });
            if (onTabChange) onTabChange(name);
        });
    });

    const onSettingChange = (key, value, needsRerender = false) => {
        state.settings[key] = value;
        applySettings(state.settings);
        if (needsRerender) onRerender();
        saveSettings();
    };

    SELECT_BINDINGS.forEach(([id, key, rerender]) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => onSettingChange(key, el.value, rerender));
    });

    RANGE_BINDINGS.forEach(([id, key, rerender, unit]) => {
        const el = document.getElementById(id);
        const valEl = document.getElementById(`${id}-val`);
        if (!el) return;
        el.addEventListener('input', () => {
            const value = parseInt(el.value, 10);
            if (valEl) valEl.textContent = `${value}${unit}`;
            onSettingChange(key, value, rerender);
        });
    });

    const colorEl = document.getElementById('s-accentColor');
    if (colorEl) colorEl.addEventListener('input', () => onSettingChange('accentColor', colorEl.value));

    document.querySelectorAll('.color-preset').forEach((btn) => {
        // The swatch colour used to be an inline style attribute; setting it
        // through the CSSOM keeps the CSP free of 'unsafe-inline'.
        if (btn.dataset.color) btn.style.background = btn.dataset.color;
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            const input = document.getElementById('s-accentColor');
            if (input) input.value = color;
            onSettingChange('accentColor', color);
        });
    });

    TOGGLE_BINDINGS.forEach(([id, key, rerender]) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('click', () => {
                const next = !state.settings[key];
                el.classList.toggle('on', next);
                onSettingChange(key, next, rerender);
            });
        }
    });
}
