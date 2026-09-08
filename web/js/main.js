import state from './state.js';
import { api, describeError, onConnectionChange, onUnauthorized } from './api.js';
import { initAuth, resolveInitialPane, showLoginScreen, signOut } from './auth.js';
import {
    BOOTSTRAP_SETTINGS,
    applySettings,
    initSettingsModal,
    loadSettings,
    saveSettings,
    setRerenderHandler,
} from './settings.js';
import { addTask, refreshTasks, rerender } from './tasks.js';
import { initAccountTab, refreshAccountTab } from './account.js';
import { initDragGlobals, isDragging } from './dragdrop.js';
import { stopMatrixRain } from './effects.js';

/** Application bootstrap: session handling, polling and the task form. */

const POLL_INTERVAL_MS = 30_000;

const el = (id) => document.getElementById(id);

let pollTimer = null;
let signedIn = false;

// ── Connection state ──────────────────────────────────────────────────────

let banner = null;

function showConnectionBanner(show) {
    if (show) {
        if (banner) return;
        banner = document.createElement('div');
        banner.className = 'connection-banner';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined ms-16';
        icon.textContent = 'cloud_off';
        banner.append(icon, document.createTextNode(' Keine Verbindung zum Server'));
        document.body.appendChild(banner);
    } else if (banner) {
        banner.remove();
        banner = null;
    }
}

function updateSyncIndicator() {
    const indicator = el('sync-indicator');
    if (!indicator || !signedIn) return;

    if (!state.lastSyncedAt) {
        indicator.textContent = '';
        return;
    }

    const seconds = Math.round((Date.now() - state.lastSyncedAt.getTime()) / 1000);
    let text;
    if (seconds < 10) text = 'gerade synchronisiert';
    else if (seconds < 90) text = `synchronisiert vor ${seconds}s`;
    else text = `synchronisiert vor ${Math.round(seconds / 60)} min`;

    indicator.textContent = text;
    indicator.classList.toggle('offline', seconds > POLL_INTERVAL_MS / 1000 * 3);
}

// ── Polling ───────────────────────────────────────────────────────────────

function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
        // Re-rendering mid-drag would tear the card out from under the finger.
        if (document.hidden || isDragging()) return;
        if (document.getElementById('settings-modal')?.classList.contains('active')) return;
        await refreshTasks({ silent: true });
        updateSyncIndicator();
    }, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// ── Session transitions ───────────────────────────────────────────────────

async function enterApp() {
    signedIn = true;
    el('login-container').style.display = 'none';
    el('app').classList.add('active');

    try {
        await loadSettings();
    } catch (error) {
        console.warn('Einstellungen konnten nicht geladen werden', error);
        applySettings({ ...BOOTSTRAP_SETTINGS, ...state.settings });
    }

    initSettingsModal({
        onTabChange: (name) => {
            if (name === 'account') refreshAccountTab();
        },
    });
    initAccountTab();

    await refreshTasks();
    updateSyncIndicator();
    startPolling();
}

function leaveApp() {
    signedIn = false;
    stopPolling();
    stopMatrixRain();
    state.tasks = [];
    state.order = null;
    state.lastSyncedAt = null;

    el('app').classList.remove('active');
    el('login-container').style.display = 'block';
    document.getElementById('settings-modal')?.classList.remove('active');

    applySettings({ ...BOOTSTRAP_SETTINGS });
    showLoginScreen();
}

// ── Task form ─────────────────────────────────────────────────────────────

async function submitNewTask() {
    const titleInput = el('task-title');
    const dueInput = el('task-due');
    const repeatInput = el('task-repeat');

    const title = titleInput.value.trim();
    if (!title) {
        alert('Bitte gib einen Titel ein!');
        titleInput.focus();
        return;
    }

    const button = el('add-task-btn');
    button.disabled = true;
    try {
        await addTask({
            title,
            dueDate: dueInput.value || null,
            repeatType: repeatInput.value,
        });
        titleInput.value = '';
        dueInput.value = '';
        repeatInput.value = state.settings.defaultRepeatType || 'none';
        state.lastSyncedAt = new Date();
        updateSyncIndicator();
    } catch (error) {
        alert(describeError(error));
    } finally {
        button.disabled = false;
    }
}

// ── iOS gesture handling ──────────────────────────────────────────────────

function initIosGuards() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
        document.addEventListener(event, (e) => e.preventDefault(), { passive: false });
    });

    let previousY = 0;
    document.addEventListener('touchstart', (event) => {
        previousY = event.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        if (isDragging()) return;

        const scrollY = window.pageYOffset || document.documentElement.scrollTop;
        const maxScroll = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const deltaY = event.touches[0].clientY - previousY;

        // Block only the rubber-band at the very top or bottom.
        if ((scrollY <= 0 && deltaY > 0) || (scrollY >= maxScroll && deltaY < 0)) {
            event.preventDefault();
        }
        previousY = event.touches[0].clientY;
    }, { passive: false });
}

// ── Startup ───────────────────────────────────────────────────────────────

async function boot() {
    applySettings({ ...BOOTSTRAP_SETTINGS });
    setRerenderHandler(rerender);
    initDragGlobals();
    initIosGuards();

    onConnectionChange((online) => showConnectionBanner(!online));
    onUnauthorized(() => {
        if (signedIn) leaveApp();
    });

    await initAuth({ onSignedIn: enterApp });

    el('add-task-btn').addEventListener('click', submitNewTask);
    el('task-title').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submitNewTask();
    });

    el('logout-btn').addEventListener('click', async () => {
        await signOut();
        leaveApp();
    });

    el('lock-btn').addEventListener('click', () => {
        state.crossCategoryDragLocked = !state.crossCategoryDragLocked;
        const button = el('lock-btn');
        const icon = button.querySelector('.material-symbols-outlined');
        icon.textContent = state.crossCategoryDragLocked ? 'lock' : 'lock_open';
        button.classList.toggle('unlocked', !state.crossCategoryDragLocked);
        button.title = state.crossCategoryDragLocked
            ? 'Drag-Kategorien sperren'
            : 'Drag-Kategorien entsperrt';
        // Remember the choice the same way the settings toggle would.
        state.settings.crossDragDefault = !state.crossCategoryDragLocked;
        saveSettings();
    });

    // Refresh as soon as the tab comes back, rather than waiting for the timer.
    document.addEventListener('visibilitychange', async () => {
        if (document.hidden || !signedIn) return;
        await refreshTasks({ silent: true });
        updateSyncIndicator();
    });

    setInterval(updateSyncIndicator, 10_000);

    const authState = await resolveInitialPane();
    if (authState.authenticated) {
        await enterApp();
    }
}

boot().catch((error) => {
    console.error('Start fehlgeschlagen', error);
});

// Surface a stale session even if the very first request happened to succeed.
window.addEventListener('pageshow', async (event) => {
    if (!event.persisted || !signedIn) return;
    try {
        const authState = await api('/api/auth/state', { quiet401: true });
        if (!authState.authenticated) leaveApp();
    } catch {
        // Offline: leave the UI as it is, the banner already shows.
    }
});
