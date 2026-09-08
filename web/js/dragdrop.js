import state from './state.js';
import { vibrate } from './util.js';

/**
 * Drag and drop reordering, both pointer and touch.
 *
 * Behaviour is unchanged from the original single-file app: a full size ghost
 * clone follows the cursor or finger, a placeholder marks the drop position,
 * and on touch a long press starts the drag.
 */

const LONG_PRESS_MS = 750;
const SCROLL_ZONE_PX = 80;
const SCROLL_MAX_SPEED = 12;

const emptyDrag = () => ({
    element: null,
    section: null,
    placeholder: null,
    ghost: null,
    offsetX: 0,
    offsetY: 0,
});

let dragState = emptyDrag();
let compactDrag = emptyDrag();

/** True while a card is being dragged, by either input method. */
export function isDragging() {
    return !!(dragState.element || compactDrag.element);
}

let globalsBound = false;

export function initDragGlobals() {
    if (globalsBound) return;
    globalsBound = true;

    document.addEventListener('dragover', (event) => {
        if (!dragState.ghost) return;
        if (!event.clientX && !event.clientY) return;
        dragState.ghost.style.left = `${event.clientX - dragState.offsetX}px`;
        dragState.ghost.style.top = `${event.clientY - dragState.offsetY}px`;
    });
}

function makeGhost(card, rect) {
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    return ghost;
}

function makePlaceholder(rect) {
    const placeholder = document.createElement('div');
    placeholder.className = 'drag-placeholder';
    placeholder.style.height = `${rect.height}px`;
    return placeholder;
}

function insertionTarget(container, clientY) {
    const cards = [...container.querySelectorAll('.task-card:not(.dragging)')];
    for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) return card;
    }
    return null;
}

/**
 * Wire a section container as a drop target.
 * @param {(container: HTMLElement) => void} onDrop persists the new order
 */
export function attachSectionDrag(section, sectionName, { onDrop }) {
    section.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (!dragState.element) return;
        if (state.crossCategoryDragLocked && dragState.section !== sectionName) return;
        event.dataTransfer.dropEffect = 'move';

        if (dragState.placeholder?.parentNode) dragState.placeholder.remove();

        const before = insertionTarget(section, event.clientY);
        if (dragState.placeholder) {
            if (before) section.insertBefore(dragState.placeholder, before);
            else section.appendChild(dragState.placeholder);
        }
    });

    section.addEventListener('drop', (event) => {
        event.preventDefault();
        if (!dragState.element) return;
        if (state.crossCategoryDragLocked && dragState.section !== sectionName) return;

        if (dragState.placeholder && dragState.placeholder.parentNode === section) {
            section.insertBefore(dragState.element, dragState.placeholder);
        }
        if (dragState.placeholder?.parentNode) dragState.placeholder.remove();

        if (dragState.ghost) {
            const ghost = dragState.ghost;
            dragState.ghost = null;
            ghost.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
            ghost.style.transform = 'scale(0.88)';
            ghost.style.opacity = '0';
            setTimeout(() => ghost.remove(), 220);
        }

        onDrop();

        const dropped = dragState.element;
        dropped.classList.remove('dragging');
        dropped.classList.add('just-dropped');
        setTimeout(() => dropped.classList.remove('just-dropped'), 700);
    });
}

/** Wire a card as a drag source, for both pointer and touch input. */
export function attachCardDrag(card, sectionName, { onDrop }) {
    card.draggable = true;

    card.addEventListener('dragstart', (event) => {
        dragState.element = card;
        dragState.section = sectionName;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.dataset.taskId);
        document.body.classList.add('dragging-active');

        const rect = card.getBoundingClientRect();
        dragState.offsetX = event.clientX - rect.left;
        dragState.offsetY = event.clientY - rect.top;
        dragState.ghost = makeGhost(card, rect);

        // Suppress the browser's own washed-out drag image.
        const blank = document.createElement('canvas');
        blank.width = 1;
        blank.height = 1;
        event.dataTransfer.setDragImage(blank, 0, 0);

        card.classList.add('dragging');
        dragState.placeholder = makePlaceholder(rect);
    });

    card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        if (dragState.ghost) dragState.ghost.remove();
        if (dragState.placeholder?.parentNode) dragState.placeholder.remove();
        document.body.classList.remove('dragging-active');
        dragState = emptyDrag();
    });

    // ── Touch: long press to pick up ──────────────────────────────────────
    let longPressTimer = null;
    let startX = 0;
    let startY = 0;

    card.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;

        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            vibrate(30);
            // Drop any text selection before the card starts moving.
            window.getSelection()?.removeAllRanges();
            document.body.classList.add('dragging-active');

            compactDrag.element = card;
            compactDrag.section = sectionName;
            card.style.touchAction = 'none';

            const rect = card.getBoundingClientRect();
            compactDrag.offsetX = startX - rect.left;
            compactDrag.offsetY = startY - rect.top;
            compactDrag.ghost = makeGhost(card, rect);

            card.classList.add('dragging');
            compactDrag.placeholder = makePlaceholder(rect);
        }, LONG_PRESS_MS);
    }, { passive: true });

    card.addEventListener('touchmove', (event) => {
        if (compactDrag.element === card) {
            event.preventDefault();
            const touch = event.touches[0];

            if (compactDrag.ghost) {
                compactDrag.ghost.style.left = `${touch.clientX - compactDrag.offsetX}px`;
                compactDrag.ghost.style.top = `${touch.clientY - compactDrag.offsetY}px`;
            }

            // Locked: stay in the original section. Unlocked: whichever section
            // is currently under the finger.
            let section;
            if (state.crossCategoryDragLocked) {
                section = card.closest('.task-section');
            } else {
                const placeholder = compactDrag.placeholder;
                if (placeholder) placeholder.style.display = 'none';
                const below = document.elementFromPoint(touch.clientX, touch.clientY);
                if (placeholder) placeholder.style.display = '';
                section = below?.closest('.task-section') || card.closest('.task-section');
            }

            if (!section || !compactDrag.placeholder) return;

            if (compactDrag.placeholder.parentNode) compactDrag.placeholder.remove();
            const before = insertionTarget(section, touch.clientY);
            if (before) section.insertBefore(compactDrag.placeholder, before);
            else section.appendChild(compactDrag.placeholder);

            // Auto-scroll when the finger nears a viewport edge.
            const y = touch.clientY;
            if (y < SCROLL_ZONE_PX) {
                window.scrollBy(0, -Math.round(SCROLL_MAX_SPEED * (1 - y / SCROLL_ZONE_PX)));
            } else if (y > window.innerHeight - SCROLL_ZONE_PX) {
                window.scrollBy(0, Math.round(SCROLL_MAX_SPEED * ((y - window.innerHeight + SCROLL_ZONE_PX) / SCROLL_ZONE_PX)));
            }
            return;
        }

        if (longPressTimer !== null) {
            const touch = event.touches[0];
            if (Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }
    }, { passive: false });

    card.addEventListener('touchend', () => {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (compactDrag.element !== card) return;

        const placeholder = compactDrag.placeholder;
        const ghost = compactDrag.ghost;
        const moved = !!placeholder?.parentNode;

        if (ghost) {
            if (moved) {
                const rect = placeholder.getBoundingClientRect();
                ghost.style.transition = 'left 0.32s cubic-bezier(0.34,1.56,0.64,1), top 0.32s cubic-bezier(0.34,1.56,0.64,1), transform 0.25s ease, opacity 0.2s ease 0.22s';
                ghost.style.left = `${rect.left}px`;
                ghost.style.top = `${rect.top}px`;
                ghost.style.transform = 'rotate(0deg) scale(1)';
                ghost.style.opacity = '0';
            } else {
                ghost.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
                ghost.style.transform = 'scale(0.92)';
                ghost.style.opacity = '0';
            }
            setTimeout(() => ghost.remove(), 380);
        }

        if (placeholder?.parentNode) {
            placeholder.parentNode.insertBefore(card, placeholder);
            placeholder.remove();
        }

        card.classList.remove('dragging');
        card.style.touchAction = '';
        document.body.classList.remove('dragging-active');

        if (moved) onDrop();

        compactDrag = emptyDrag();
        card.classList.add('just-dropped');
        setTimeout(() => card.classList.remove('just-dropped'), 700);
    });

    card.addEventListener('touchcancel', () => {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        if (compactDrag.element !== card) return;
        if (compactDrag.ghost) compactDrag.ghost.remove();
        if (compactDrag.placeholder?.parentNode) compactDrag.placeholder.remove();
        card.classList.remove('dragging');
        card.style.touchAction = '';
        document.body.classList.remove('dragging-active');
        compactDrag = emptyDrag();
    });

    // A long press would otherwise open the context menu mid-drag.
    card.addEventListener('contextmenu', (event) => event.preventDefault());
}
