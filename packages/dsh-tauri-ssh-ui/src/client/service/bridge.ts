/**
 * The desktop-bridge face (C-BRIDGE, S5 owns the shell commands): probing
 * whether this page sits inside the desktop's iframe invoke bridge, and
 * asking the shell to open (or focus) a machine's remote window. Both rides
 * go through `invokeBridgedTauri` — a timeout or rejection on the ping means
 * pure web, where the popup affordance simply never shows.
 * @module dsh-tauri-ssh-ui/client/service/bridge
 */

import type { RemoteBridge } from '../types/index.js'
import { invokeBridgedTauri } from 'dsh-tauri/client'
import { REMOTE_BRIDGE_PING_COMMAND, REMOTE_OPEN_WINDOW_COMMAND } from '../constants/index.js'

/** The real desktop bridge: Tauri commands over the iframe postMessage relay. */
export const desktopBridge: RemoteBridge = {
  probe: () => invokeBridgedTauri(REMOTE_BRIDGE_PING_COMMAND),
  openWindow: (machineId, url) => invokeBridgedTauri(REMOTE_OPEN_WINDOW_COMMAND, { machineId, url }),
}
