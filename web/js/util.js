import state from './state.js';

/** Formatting and date helpers shared by the card renderer. */

export function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}

export function getTodayString() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
}

export function formatDate(dateString) {
    if (!dateString) return '';
    if (state.settings.dateFormat === 'iso') return dateString;
    const [y, m, d] = dateString.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
}

export function formatDateTime(isoString) {
    if (!isoString) return '–';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '–';
    return date.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export function getDueDateInfo(dueDate) {
    if (!dueDate) return { badge: null, class: '' };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [y, m, d] = dueDate.split('-').map(Number);
    const due = new Date(y, m - 1, d);

    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
    const warnDays = state.settings.dueDateWarningDays || 3;

    if (diffDays < 0) return { badge: `${Math.abs(diffDays)}d überfällig`, class: 'overdue' };
    if (diffDays === 0) return { badge: 'Heute fällig', class: 'today' };
    if (diffDays === 1) return { badge: 'Morgen fällig', class: warnDays >= 1 ? 'warning' : '' };
    if (diffDays <= 7) return { badge: `In ${diffDays} Tagen`, class: diffDays <= warnDays ? 'warning' : '' };
    return { badge: `Fällig: ${formatDate(dueDate)}`, class: '' };
}

const REPEAT_LABELS = {
    none: '',
    daily: 'Täglich',
    every2days: 'Alle 2 Tage',
    every3days: 'Alle 3 Tage',
    weekly: 'Wöchentlich',
    monthly: 'Monatlich',
};

export function getRepeatLabel(repeatType) {
    return REPEAT_LABELS[repeatType] || '';
}

/**
 * Build an element with a leading Material icon.
 *
 * Used instead of innerHTML wherever a label is assembled, so no code path
 * turns a string into markup.
 */
export function iconLabel(iconName, text, { iconClass = 'ms-15', extraIconClass = '' } = {}) {
    const fragment = document.createDocumentFragment();
    const icon = document.createElement('span');
    icon.className = `material-symbols-outlined ${iconClass}${extraIconClass ? ` ${extraIconClass}` : ''}`;
    icon.textContent = iconName;
    fragment.appendChild(icon);
    if (text) fragment.appendChild(document.createTextNode(` ${text}`));
    return fragment;
}

export function vibrate(pattern) {
    if (state.settings.vibrationFeedback && navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}
