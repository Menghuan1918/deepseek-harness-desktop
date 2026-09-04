/**
 * Shared client constants of the SSH-machines settings page: the settings
 * slot protocol identifiers, the locale namespace, and the same-origin API
 * route the host half (`dsh-tauri-ssh`) mounts.
 * @module dsh-tauri-ssh-ui/client/constants
 */

/** Dictionary namespace owned by this plugin. */
export const SSH_LOCALE_NS = 'ssh'

/** The settings section slot this plugin registers into. */
export const SETTINGS_SECTION_SLOT = 'settings.section'

/** Registration id of this plugin's settings section (the host plugin's id). */
export const SETTINGS_SECTION_ID = 'dsh-tauri-ssh'

/** Order of this plugin's settings section among the other sections. */
export const SETTINGS_SECTION_ORDER = 50

/** The /api-ssh route the host plugin mounts (same-origin POST envelope). */
export const SSH_API_PATH = '/api-ssh'
