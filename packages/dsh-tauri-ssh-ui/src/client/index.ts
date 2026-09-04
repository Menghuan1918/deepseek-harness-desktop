/**
 * SSH-machines settings page, browser half. Registers the `ssh` dictionary
 * and one `settings.section` entry; the page state lives in the injected
 * MachinesStore (machine CRUD and the connection plane, all through the host
 * plugin's /api-ssh route). Export discipline: thin apply, everything else
 * in feature modules.
 * @module dsh-tauri-ssh-ui/client
 */

import type { UiContext } from './types/index.js'
import { MachinesSection } from './components/machines-section.js'
import { SETTINGS_SECTION_ID, SETTINGS_SECTION_ORDER, SETTINGS_SECTION_SLOT, SSH_LOCALE_NS } from './constants/index.js'
import { en, zh } from './locales/index.js'
import { MachinesStore } from './store/index.js'

/** Required services: the settings slot seam and the locale seat. */
export const inject = ['slots', 'locale']

/**
 * Register the `ssh` dictionaries and the settings section, each once its
 * slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: UiContext): void {
  ctx.effect(() => ctx.locale.register(SSH_LOCALE_NS, { zh, en }), 'dsh-tauri-ssh-ui: dictionaries')
  const t = ctx.locale.bind(SSH_LOCALE_NS)
  const store = new MachinesStore((url, init) => fetch(url, init))
  ctx.slots.inject(SETTINGS_SECTION_SLOT, () => ctx.slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: SETTINGS_SECTION_ID,
    order: SETTINGS_SECTION_ORDER,
    label: () => t('nav'),
    locale: SSH_LOCALE_NS,
    inject: () => ({ store }),
  }, MachinesSection))
}

/** The dictionary key union, re-exported for the section props. */
export type { SshKey } from './locales/index.js'
