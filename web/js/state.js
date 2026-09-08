/**
 * Shared mutable state.
 *
 * One object every module imports, rather than a web of cross-imports. Nothing
 * here is persisted directly; the API is the source of truth and these fields
 * are the last thing it told us.
 */
export const state = {
    /** Full preferences object, always server merged with the defaults. */
    settings: {},
    /** Defaults as delivered by the API, used by the reset button. */
    defaults: {},
    /** Flat list of task ids in the user's manual order, or null. */
    order: null,
    /** Most recent task list, kept so a settings change can re-render. */
    tasks: [],
    /** false lets cards be dragged between date sections. */
    crossCategoryDragLocked: true,
    /** Timestamp of the last successful sync, for the footer indicator. */
    lastSyncedAt: null,
};

export default state;
