/**
 * Public type vocabulary of the SSH remote-machine plugin: the `MachineId`
 * brand, the stored machine profile, its redacted view, connection status,
 * the tunnel link, the typed failure vocabulary, and the structural host
 * services the plugin consumes (the DSH packages providing them are private
 * to the harness, so the plugin declares just the surface it touches).
 * @module dsh-tauri-ssh/host/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type z from 'schemastery'

/** Identifies one SSH machine profile. A generated uuid, never the host name: hosts are not unique. */
export type MachineId = string & { readonly __machineId: unique symbol }

/**
 * Brand a string as a {@link MachineId}.
 * @param id - the raw machine id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
// eslint-disable-next-line ts/no-redeclare -- 品牌类型惯用法：值与类型同名
export function MachineId(id: string): MachineId {
  return id as MachineId
}

/**
 * One stored SSH machine profile: the `ssh-machines` settings-namespace
 * value shape. Credentials are deliberately sparse: authentication runs on
 * the host's own `~/.ssh` (config aliases, `IdentityFile`s, default keys),
 * so only the optional fallback secrets live here. Secret fields are
 * schema-declared `role('secret')` positions — they never ride a redacted
 * wire surface, only the owner scope's resolved in-process value.
 */
export interface MachineProfile {
  /** Stable profile id (generated uuid). */
  id: MachineId
  /** Display name (duplicates allowed). */
  name: string
  /** SSH server host name, IP literal, or a `~/.ssh/config` `Host` alias. */
  host: string
  /** SSH server TCP port; a config `Port` override wins when present. */
  port: number
  /** Login user name; empty means "resolve from config or the OS user". */
  user: string
  /** Password credential; secret. Optional fallback when no key works. */
  password?: string
  /** Passphrase unlocking the `~/.ssh` identity files; secret. Optional. */
  passphrase?: string
  /** TCP port the remote `dsh web` instance listens on (loopback). */
  remotePort: number
  /** Command that starts the remote instance; defaults to `dsh web --host 127.0.0.1 --port <remotePort>`. */
  startCommand?: string
  /** Optional identity color (any CSS color) shown as the machine's pip in the UI. */
  color?: string
  /** Whether the identity color also tints the machine card's border in the UI. */
  tintBorder?: boolean
}

/**
 * Redacted view of one machine profile: secrets replaced by presence flags.
 * This is the only profile shape that may cross a wire surface.
 */
export interface MachineView {
  id: MachineId
  name: string
  host: string
  port: number
  user: string
  /** Whether the profile currently holds a password (the value itself never rides). */
  hasPassword: boolean
  /** Whether the profile currently holds a key passphrase (the value itself never rides). */
  hasPassphrase: boolean
  remotePort: number
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

/** One machine row as the settings page writes it: config fields only, no secrets. */
export interface MachineSaveRow {
  name: string
  host: string
  port: number
  user: string
  remotePort: number
  startCommand?: string
  color?: string
  tintBorder?: boolean
}

/** Secret values the settings page writes (write-only direction; absent = keep stored). */
export interface MachineSecretWrite {
  password?: string
  passphrase?: string
}

/**
 * Live connection state of one machine — the C-STATE vocabulary consumed by
 * the status dot (S4) and the switcher (S5).
 *
 * - `disconnected` — not connected (never tried, or a deliberate disconnect);
 * - `testing` — a one-shot `machine.test` probe is in flight;
 * - `connecting` — a user-initiated connect is in flight;
 * - `connected` — the tunnel link is live;
 * - `reconnecting` — an established connection dropped and the automatic
 *   retry loop owns the machine (a scheduled retry is announced through
 *   {@link SshMachineStatus.nextRetryAt});
 * - `given-up` — terminal failure state: either the first connect never
 *   succeeded or the reconnect budget ran out. `lastError` carries the
 *   reason; the same word is used for both sources on purpose (switchers
 *   need not distinguish them). A fresh `connect` attempt exits it.
 */
export type SshConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

/** Which credential the transport last authenticated with. */
export type SshAuthMethod = 'agent' | 'key' | 'password'

/** One progress phase of a connection-plane operation, shown live in the UI. */
export type SshProgressPhase = 'handshake' | 'starting' | 'probing' | 'installing'

/** Structured progress of an in-flight connection-plane operation. */
export interface SshProgress {
  phase: SshProgressPhase
  /** Progress position (e.g. health-probe attempt number). */
  attempt?: number
  /** Progress total (e.g. health-probe attempt budget). */
  total?: number
  /** Recent streaming output of the operation (the install log), newest last. */
  log?: string
}

/** Transport-level status of one machine. */
export interface SshMachineStatus {
  machineId: MachineId
  state: SshConnectionState
  /** Local loopback URL of the SSH tunnel to the remote instance; present while connected. */
  tunnelBaseUrl?: string
  /** Operator-facing failure description of the last failed transition; absent while healthy. */
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote" (offers install). */
  dshMissing?: boolean
  /** Live progress of the in-flight operation; absent while idle. */
  progress?: SshProgress
  /** Epoch milliseconds of the next scheduled reconnect retry; present while `reconnecting` waits. */
  nextRetryAt?: number
  /** Which credential the live (or last successful) connection authenticated with. */
  authMethod?: SshAuthMethod
}

/** A live machine link: the id and the tunnel base URL. */
export interface SshLink {
  machineId: MachineId
  /** `http://127.0.0.1:<localPort>` — loopback only, never exposed to remote clients. */
  tunnelBaseUrl: string
}

/** Outcome of a one-shot connection test. */
export type SshTestResult
  = | { ok: true, banner: string }
    | { ok: false, message: string }

/** One bootstrap stage of the remote-instance assurance pipeline (S3 adds the connection-lifecycle stages on the same channel). */
export type SshMachineStage
  = | 'probe'
    | 'download'
    | 'verify'
    | 'install'
    | 'launch'
    | 'ready'
    | 'failed'

/** Terminal verdict of a machine event, when it settles an operation. */
export type SshMachineTerminal = 'success' | 'failed'

/**
 * One machine-scoped event of the `/api-ssh` `machine.events` channel: a
 * displayable log line tagged with its pipeline stage. `seq` is per-machine
 * and monotonically increasing; consumers poll with the last seen seq.
 */
export interface SshMachineEvent {
  /** Per-machine sequence number, starting at 1. */
  seq: number
  /** Wall-clock timestamp of the event (ISO-8601). */
  ts: string
  /** The machine the event is about. */
  machineId: MachineId
  /** The pipeline stage the line belongs to. */
  stage: SshMachineStage
  /** The displayable log line. */
  line: string
  /** Terminal verdict, present only on the settling event of an operation. */
  terminal?: SshMachineTerminal
  /** Failure reason, present on `terminal: 'failed'` events. */
  reason?: string
}

/** The `machine.events` response: the drained slice plus the poll cursor. */
export interface SshMachineEventsPage {
  events: SshMachineEvent[]
  /** The next event's seq; poll again with `sinceSeq = nextSeq - 1`. */
  nextSeq: number
}

/** Outcome of a one-shot remote dsh install. */
export interface SshInstallResult {
  /** Components freshly installed this run (a subset of node/dsh/pnpm). */
  installed: string[]
  /** The pinned DSH release actually installed (`<tag>` or `npm:<version>`). */
  dshRef: string
  /** The resolved DSH semver. */
  dshVersion: string
  /** Absolute path of the installed `dsh` entry as the remote sees it. */
  dshPath: string
  /** Whether the local DEEPSEEK_API_KEY was copied to the remote `~/.dsh/.env`. */
  credentialsCopied: boolean
  /** Operator-facing description when the credentials copy itself failed. */
  credentialsError?: string
}

/** Closed failure vocabulary of the ssh primitives. */
export type SshErrorCode
  = | 'machine-not-found'
    | 'machine-connect-failed'
    | 'machine-bootstrap-failed'
    | 'machine-dsh-missing'
    | 'machine-install-failed'
    | 'machine-ssh-error'
    | 'machine-reconnecting'

/**
 * Connection-lifecycle stages this plugin feeds into the machine-level event
 * channel (C-EVENT). The channel itself — `/api-ssh` `machine.events` — is
 * owned by S2; these are the stages S3 appends to its stage enum, so the
 * merged vocabulary is S2's bootstrap stages plus `auth` and `reconnect`.
 */
export const SSH_CONNECTION_EVENT_STAGES = ['auth', 'reconnect'] as const

/** One connection-lifecycle stage of the machine event channel (S3's slice). */
export type SshConnectionEventStage = typeof SSH_CONNECTION_EVENT_STAGES[number]

/**
 * One machine event: a displayable, secret-free line on the machine's log
 * stream. `outcome` marks the line that closes a lifecycle run.
 */
export interface SshMachineEvent {
  machineId: MachineId
  stage: SshConnectionEventStage
  /** Operator-facing text line; never carries secret values. */
  text: string
  /** Terminal outcome, present on the line that closes a run. */
  outcome?: 'success' | 'failure'
}

/**
 * Pluggable sink for {@link SshMachineEvent}s — the seam where the event
 * routing lands. Today the default sink is a no-op; when S2's `machine.events`
 * channel merges, the plugin assembly wires a sink that forwards into it.
 */
export interface SshMachineEventSink {
  emit: (event: SshMachineEvent) => void
}

/** Typed failure thrown by ssh primitives so consumers map business codes without string matching. */
export class SshError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param machineId - the machine the failure is about.
   * @param message - operator-facing description.
   */
  constructor(readonly code: SshErrorCode, readonly machineId: MachineId, message: string) {
    super(message)
    this.name = 'SshError'
  }
}

/** The webserver route shape this plugin registers (a subset of the harness's WebRoute). */
export interface HostWebRoute {
  kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The settings namespace scope this plugin registers (a subset of dsh-settings' SettingsScope). */
export interface HostSettingsScope<T> {
  /** The current resolved namespace value. */
  get: () => T
  /** Subscribe to value changes; returns an unsubscribe. */
  watch: (callback: (next: T, prev: T) => void) => () => void
  /** Merge a patch into the user section and persist (schema-validated). */
  update: (patch: object) => Promise<void>
  /** Replace the user section wholesale (absent keys re-inherit defaults). */
  replace: (section: object) => Promise<void>
}

/** The settings service surface this plugin needs. */
export interface HostSettings {
  register: <T>(ns: string, schema: z<T>, options?: { base?: T, applies?: 'live' | 'restart' }) => HostSettingsScope<T>
}

/** The webserver service surface this plugin needs. */
export interface HostWebServer {
  register: (route: HostWebRoute) => () => void
}

/**
 * The host context this plugin's apply receives: the settings seam (namespace)
 * and the webserver (route mount), plus the teardown-effect seat. Structural —
 * the harness's real context duck-types onto it.
 */
export interface SshHostContext {
  settings: HostSettings
  webServer: HostWebServer
  /** Register a teardown effect (narrow cordis surface). */
  effect: (execute: () => () => void, label?: string) => unknown
}
