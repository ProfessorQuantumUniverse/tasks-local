import state from './state.js';
import { api, describeError } from './api.js';
import { saveCustomOrder } from './settings.js';
import { launchConfetti } from './effects.js';
import { attachCardDrag, attachSectionDrag } from './dragdrop.js';
import {
    formatDate,
    getDueDateInfo,
    getRepeatLabel,
    iconLabel,
} from './util.js';

/** Task list: fetching, rendering and mutating. */

const SECTION_LABELS = {
    urgent: '⚠ Überfällig',
    near: '📅 Bald fällig',
    far: '🗓 Später',
    nodate: '📌 Kein Datum',
};

const HEX_VALS = { 0: '0x00', 1: '0x55', 2: '0xAA', 3: '0xFF' };

// Static markup with no interpolated values.
const EMPTY_STATE_HTML = `
    <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
        </svg>
        <p>Noch keine Aufgaben. Erstelle deine erste!</p>
    </div>
`;

function container() {
    return document.getElementById('tasks-container');
}

function notifyError(error) {
    // Deliberately not a silent console log: a failed write must be visible.
    alert(describeError(error));
}

// ── Fetching ──────────────────────────────────────────────────────────────

/** Order tasks the way the app shows them when no manual order is set. */
function chronological(tasks) {
    const sorted = [...tasks].sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
    });
    if (state.settings.reverseSortOrder) sorted.reverse();
    return sorted;
}

/**
 * Cheap fingerprint of what is currently on screen.
 *
 * Polling would otherwise rebuild the list every 30 seconds, replaying the
 * card entry animation even when nothing changed.
 */
function signatureOf(tasks) {
    return tasks
        .map((t) => `${t.id}:${t.updatedAt}:${t.progress}:${t.important ? 1 : 0}:${t.dueDate || ''}:${t.title}`)
        .join('|');
}

let renderedSignature = null;

export async function refreshTasks({ silent = false } = {}) {
    try {
        const data = await api('/api/tasks');
        const sorted = chronological(data.tasks);
        state.lastSyncedAt = new Date();

        if (renderedSignature !== null && signatureOf(sorted) === renderedSignature) {
            state.tasks = sorted;
            return true;
        }

        state.tasks = sorted;
        displayTasks(sorted);
        return true;
    } catch (error) {
        if (!silent) {
            const target = container();
            if (target && state.tasks.length === 0) {
                target.textContent = '';
                const message = document.createElement('div');
                message.className = 'credential-empty';
                message.textContent = describeError(error);
                target.appendChild(message);
            }
        }
        return false;
    }
}

/** Re-render from the cached list, e.g. after a settings change. */
export function rerender() {
    if (state.tasks.length > 0 || container()) displayTasks(state.tasks);
}

// ── Mutations ─────────────────────────────────────────────────────────────

function replaceTask(task) {
    const index = state.tasks.findIndex((entry) => entry.id === task.id);
    if (index >= 0) state.tasks[index] = task;
    else state.tasks.push(task);
    displayTasks(chronological(state.tasks));
}

function removeTask(taskId) {
    state.tasks = state.tasks.filter((entry) => entry.id !== taskId);
    if (state.order) state.order = state.order.filter((id) => id !== taskId);
    displayTasks(state.tasks);
}

export async function addTask({ title, dueDate, repeatType }) {
    const data = await api('/api/tasks', {
        method: 'POST',
        body: { title, dueDate: dueDate || null, repeatType },
    });
    state.tasks.push(data.task);
    displayTasks(chronological(state.tasks));
    return data.task;
}

async function patchTask(taskId, patch) {
    const data = await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patch });
    replaceTask(data.task);
    return data.task;
}

async function toggleImportant(taskId) {
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) return;
    try {
        await patchTask(taskId, { important: !task.important });
    } catch (error) {
        notifyError(error);
    }
}

async function updateProgress(taskId, boxNumber) {
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (!task) return;

    // Clicking the box you are already at steps back one.
    const newProgress = (task.progress || 0) >= boxNumber ? boxNumber - 1 : boxNumber;

    try {
        await patchTask(taskId, { progress: newProgress });
    } catch (error) {
        notifyError(error);
        return;
    }

    setTimeout(() => {
        const boxes = container()?.querySelectorAll(
            `[data-task-id="${CSS.escape(taskId)}"] .progress-box`,
        );
        const target = boxes?.[boxNumber - 1];
        if (target) {
            target.classList.add('just-filled');
            setTimeout(() => target.classList.remove('just-filled'), 400);
        }
    }, 50);

    if (newProgress === 3) {
        setTimeout(() => showCompletionModal(taskId), 350);
    }
}

async function postponeTask(taskId) {
    try {
        const data = await api(`/api/tasks/${encodeURIComponent(taskId)}/postpone`, { method: 'POST' });
        replaceTask(data.task);
    } catch (error) {
        notifyError(error);
    }
}

export async function deleteTask(taskId, skipConfirm = false) {
    if (!skipConfirm && state.settings.confirmDelete
        && !confirm('Möchtest du diese Aufgabe wirklich löschen?')) {
        return;
    }

    if (!skipConfirm && state.settings.deletionDelay) {
        showUndoToast(taskId);
        return;
    }

    try {
        await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        removeTask(taskId);
    } catch (error) {
        notifyError(error);
    }
}

// ── Undo toast ────────────────────────────────────────────────────────────

function showUndoToast(taskId) {
    document.querySelector('.undo-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'undo-toast';

    let countdown = 3;
    let cancelled = false;

    const text = document.createElement('span');
    const undoBtn = document.createElement('button');
    undoBtn.className = 'undo-btn';
    undoBtn.textContent = 'Rückgängig';
    undoBtn.addEventListener('click', () => {
        cancelled = true;
        clearInterval(timer);
        toast.remove();
    });

    toast.append(text, undoBtn);
    document.body.appendChild(toast);

    const update = () => { text.textContent = `Wird gelöscht in ${countdown}s… `; };
    update();

    const timer = setInterval(async () => {
        countdown -= 1;
        if (countdown > 0) {
            update();
            return;
        }
        clearInterval(timer);
        toast.remove();
        if (cancelled) return;
        try {
            await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
            removeTask(taskId);
        } catch (error) {
            notifyError(error);
        }
    }, 1000);
}

// ── Completion modal ──────────────────────────────────────────────────────

function showCompletionModal(taskId) {
    const modal = document.getElementById('completion-modal');
    if (!modal) return;
    modal.classList.add('active');

    // Cloning drops listeners left over from a previous completion.
    const oldDone = document.getElementById('modal-done-btn');
    const oldDelete = document.getElementById('modal-delete-btn');
    const doneBtn = oldDone.cloneNode(true);
    const deleteBtn = oldDelete.cloneNode(true);
    oldDone.parentNode.replaceChild(doneBtn, oldDone);
    oldDelete.parentNode.replaceChild(deleteBtn, oldDelete);

    doneBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        if (state.settings.showConfetti) launchConfetti();
    });

    deleteBtn.addEventListener('click', async () => {
        modal.classList.remove('active');
        await deleteTask(taskId, true);
    });
}

// ── Order persistence ─────────────────────────────────────────────────────

function persistOrderFromDom() {
    const cards = [...container().querySelectorAll('.task-card')];
    state.order = cards.map((card) => card.dataset.taskId);
    saveCustomOrder();
    ensureResortButton();
}

function makeResortButton() {
    const button = document.createElement('button');
    button.className = 'resort-btn';
    button.appendChild(iconLabel('sort', 'Chronologisch sortieren'));
    button.addEventListener('click', async () => {
        state.order = null;
        await saveCustomOrder();
        displayTasks(chronological(state.tasks));
    });
    return button;
}

function ensureResortButton() {
    const target = container();
    if (target.querySelector('.resort-btn')) return;
    target.insertBefore(makeResortButton(), target.firstChild);
}

// ── Rendering ─────────────────────────────────────────────────────────────

export function displayTasks(tasks) {
    state.tasks = tasks;
    const target = container();
    if (!target) return;

    renderedSignature = signatureOf(tasks);

    let ordered = tasks;
    if (!state.order && state.settings.autoSortNew) {
        ordered = [...tasks].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    }

    const badge = document.getElementById('task-count-badge');
    if (badge) {
        badge.textContent = String(ordered.length);
        badge.style.display = state.settings.showTaskCount ? 'inline' : 'none';
    }

    target.textContent = '';

    if (ordered.length === 0) {
        target.innerHTML = EMPTY_STATE_HTML;
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const oneMonthOut = new Date(today);
    oneMonthOut.setMonth(oneMonthOut.getMonth() + 1);

    const sections = { urgent: [], near: [], far: [], nodate: [] };
    ordered.forEach((task) => {
        if (!task.dueDate) {
            sections.nodate.push(task);
            return;
        }
        // Parsed component-wise so the date does not shift by timezone.
        const [y, m, d] = task.dueDate.split('-').map(Number);
        const due = new Date(y, m - 1, d);
        if (due <= today) sections.urgent.push(task);
        else if (due <= oneMonthOut) sections.near.push(task);
        else sections.far.push(task);
    });

    // The manual order is one flat list across all sections; a task missing
    // from it (just created) sinks to the bottom of its own section.
    if (state.order) {
        const rank = new Map(state.order.map((id, index) => [id, index]));
        Object.keys(sections).forEach((key) => {
            sections[key].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
        });
    }

    if (state.order !== null) target.appendChild(makeResortButton());

    const urgentEl = sections.urgent.length ? createSectionEl('urgent', sections.urgent) : null;
    const nearEl = sections.near.length ? createSectionEl('near', sections.near) : null;
    const farEl = sections.far.length ? createSectionEl('far', sections.far) : null;
    const nodateEl = sections.nodate.length ? createSectionEl('nodate', sections.nodate) : null;

    const hasAfterUrgent = nearEl || farEl || nodateEl;
    const hasBeforeFar = urgentEl || nearEl;

    if (urgentEl) target.appendChild(urgentEl);

    if (urgentEl && hasAfterUrgent) {
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        target.appendChild(separator);
    }

    if (nearEl) target.appendChild(nearEl);

    if (farEl && hasBeforeFar) {
        const separator = document.createElement('div');
        separator.className = 'date-separator long-term';
        const label = document.createElement('span');
        label.textContent = '+ 1 Monat';
        separator.appendChild(label);
        target.appendChild(separator);
    }

    if (farEl) target.appendChild(farEl);
    if (nodateEl) target.appendChild(nodateEl);
}

function createSectionEl(sectionName, tasks) {
    const section = document.createElement('div');
    section.className = 'task-section';
    section.dataset.section = sectionName;

    const countBadge = document.createElement('div');
    countBadge.className = 'section-count-badge';
    const label = document.createElement('span');
    label.className = 'section-count-label';
    label.textContent = SECTION_LABELS[sectionName] || sectionName;
    const num = document.createElement('span');
    num.className = 'section-count-num';
    num.textContent = String(tasks.length);
    countBadge.append(label, num);
    section.appendChild(countBadge);

    attachSectionDrag(section, sectionName, { onDrop: persistOrderFromDom });

    tasks.forEach((task) => section.appendChild(createTaskCard(task, sectionName)));
    return section;
}

function createTaskCard(task, sectionName) {
    const progress = task.progress || 0;
    const dueInfo = getDueDateInfo(task.dueDate);
    const repeatLabel = getRepeatLabel(task.repeatType);
    const progressPercent = Math.round((progress / 3) * 100);

    const card = document.createElement('div');
    card.className = 'task-card'
        + (task.important ? ' important' : '')
        + (progress === 3 ? ' progress-complete' : '');
    card.dataset.taskId = task.id;
    card.dataset.section = sectionName;

    attachCardDrag(card, sectionName, { onDrop: persistOrderFromDom });

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'task-header';

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.title;
    header.appendChild(title);

    if (dueInfo.badge) {
        const badge = document.createElement('div');
        badge.className = `task-due-badge${dueInfo.class ? ` ${dueInfo.class}` : ''}`;
        badge.textContent = dueInfo.badge;
        header.appendChild(badge);
    }

    const importantBtn = document.createElement('button');
    importantBtn.className = `important-btn${task.important ? ' active' : ''}`;
    importantBtn.title = task.important ? 'Wichtig (klicken zum Entfernen)' : 'Als wichtig markieren';
    const star = document.createElement('span');
    star.className = `material-symbols-outlined ms-20${task.important ? ' ms-filled' : ''}`;
    star.textContent = 'star';
    importantBtn.appendChild(star);
    importantBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleImportant(task.id);
    });
    header.appendChild(importantBtn);

    card.appendChild(header);

    // ── Progress text ──
    const progressText = document.createElement('div');
    progressText.className = `progress-text${progress === 3 ? ' complete' : ''}`;
    if (progress === 3) {
        if (state.settings.hexProgress) {
            progressText.textContent = '0xFF — Abgeschlossen!';
            progressText.classList.add('mono');
        } else {
            progressText.appendChild(
                iconLabel('celebration', 'Abgeschlossen!', { iconClass: 'ms-20', extraIconClass: 'ms-green' }),
            );
        }
    } else {
        progressText.textContent = state.settings.hexProgress
            ? `${HEX_VALS[progress]} erledigt`
            : `${progressPercent}% erledigt`;
        if (state.settings.hexProgress) progressText.classList.add('mono');
    }
    card.appendChild(progressText);

    // ── Progress control ──
    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';

    if (state.settings.progressStyle === 'bar') {
        const wrapper = document.createElement('div');
        wrapper.className = 'progress-bar-wrapper';
        const fill = document.createElement('div');
        fill.className = 'progress-bar-fill';
        fill.style.width = `${progressPercent}%`;
        wrapper.appendChild(fill);
        wrapper.addEventListener('click', (event) => {
            const ratio = (event.clientX - wrapper.getBoundingClientRect().left) / wrapper.offsetWidth;
            const zone = ratio < 0.34 ? 1 : ratio < 0.67 ? 2 : 3;
            updateProgress(task.id, zone);
        });
        progressContainer.appendChild(wrapper);
    } else {
        for (let i = 1; i <= 3; i += 1) {
            const box = document.createElement('div');
            box.className = `progress-box${progress >= i ? ' filled' : ''}`;
            box.addEventListener('click', () => updateProgress(task.id, i));
            progressContainer.appendChild(box);
        }
    }
    card.appendChild(progressContainer);

    // ── Footer ──
    const footer = document.createElement('div');
    footer.className = 'task-footer';

    const footerLeft = document.createElement('div');
    footerLeft.className = 'task-footer-left';

    if (repeatLabel) {
        const repeatBadge = document.createElement('div');
        repeatBadge.className = 'task-repeat-badge';
        repeatBadge.appendChild(iconLabel('autorenew', repeatLabel, { extraIconClass: 'ms-green' }));
        footerLeft.appendChild(repeatBadge);
    }

    const postponeBtn = document.createElement('button');
    postponeBtn.className = 'postpone-btn';
    postponeBtn.appendChild(iconLabel('fast_forward', '+1 Tag'));
    postponeBtn.addEventListener('click', () => postponeTask(task.id));
    footerLeft.appendChild(postponeBtn);

    footer.appendChild(footerLeft);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = `delete-btn${progress === 3 ? ' visible' : ''}`;
    deleteBtn.appendChild(iconLabel('delete', 'Löschen'));
    deleteBtn.addEventListener('click', () => deleteTask(task.id));
    footer.appendChild(deleteBtn);

    card.appendChild(footer);

    const created = document.createElement('div');
    created.className = 'task-created-date';
    const createdDay = task.createdAt ? task.createdAt.split('T')[0] : null;
    created.textContent = `Erstellt: ${createdDay ? formatDate(createdDay) : '–'}`;
    card.appendChild(created);

    const updated = document.createElement('div');
    updated.className = 'task-updated-date';
    const updatedDay = task.updatedAt ? task.updatedAt.split('T')[0] : null;
    updated.textContent = `Bearbeitet: ${updatedDay ? formatDate(updatedDay) : '–'}`;
    card.appendChild(updated);

    return card;
}
