/**
 * Client-side mirrors of the S4-owned sync vocabulary, the S2-owned machine
 * event channel, and the S3-owned connection-state vocabulary this panel
 * consumes (the contracts are drafted by their owners; these shapes are the
 * panel's tolerant readers of them).
 * @module dsh-tauri-ssh-ui/client/types/sync
 */

/**
 * The connection-state vocabulary (C-STATE, S3-owned): the six lifecycle
 * states a machine row can report, plus the optional next-retry hint that
 * rides a `reconnecting` status.
 */
export type MachineLifecycleState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

/** Whether a raw value is one of the lifecycle states. */
export function isLifecycleState(value: unknown): value is MachineLifecycleState {
  return value === 'disconnected'
    || value === 'testing'
    || value === 'connecting'
    || value === 'connected'
    || value === 'reconnecting'
    || value === 'given-up'
}

/** One machine event from the polled `machine.events` channel (C-EVENT, S2-owned). */
export interface SshMachineEvent {
  seq: number
  ts: number
  machineId: string
  stage: string
  line: string
  terminal?: boolean
  reason?: string
}

/** One plugin sync candidate (the `sync.preview` plugins list member). */
export interface SyncPluginItem {
  name: string
  spec: string
  syncable: boolean
  reason?: string
}

/** One skill sync candidate (the `sync.preview` skills list member). */
export interface SyncSkillItem {
  name: string
  root: string
}

/** The `sync.preview` value. */
export interface SyncPreview {
  plugins: SyncPluginItem[]
  skills: SyncSkillItem[]
}

/** Outcome of exactly one synced item (the `sync.apply` items member). */
export interface SyncItemResult {
  kind: 'plugin' | 'skill'
  name: string
  root?: string
  ok: boolean
  error?: string
}

/** The `sync.apply` value. */
export interface SyncApplyResult {
  items: SyncItemResult[]
}

/** The desktop iframe bridge face (C-BRIDGE, S5-owned commands). */
export interface RemoteBridge {
  /** Probe whether the desktop invoke bridge answers (timeout/rejection = pure web). */
  probe: () => Promise<unknown>
  /** Ask the desktop shell to open (or focus) the machine's remote window. */
  openWindow: (machineId: string, url: string) => Promise<unknown>
}
