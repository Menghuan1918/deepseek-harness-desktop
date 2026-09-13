/**
 * State owner of the SSH-machines settings page. Everything goes through the
 * host plugin's same-origin `/api-ssh` route: machine.list serves the config
 * rows (secrets replaced by presence flags), the live statuses, and the
 * connection plane; machine.save/machine.remove are the CRUD writes. The
 * upstream settings RPC is deliberately NOT used for this namespace — its
 * configuration-client allowlist is hard-coded upstream, and the plugin must
 * stay zero-upstream-change. Framework-agnostic: tests inject a fake fetch.
 * @module dsh-tauri-ssh-ui/client/store
 */

import type { SshKey } from '../locales/index'
import type { MachineLifecycleState, SshMachineEvent, SyncApplyResult, SyncItemResult, SyncPreview } from '../types/index'
import { SSH_API_PATH } from '../constants/index'
import { isLifecycleState } from '../types/index'

/**
 * A published notice: `text` carries host-provided words verbatim (banner /
 * failure message); `key` is a store-generated literal rendered through the
 * locale table (params folded by `{name}` replacement at render time).
 */
export type MachinesNotice
  = | { kind: 'text', text: string }
    | { kind: 'key', key: SshKey, params?: Record<string, string> }

/** One redacted machine row (secret fields live only in the form). */
export interface MachineRow {
  id: string
  name: string
  host: string
  port: number
  user: string
  hasPassword: boolean
  hasPassphrase: boolean
  remotePort: number
  startCommand?: string
  /** Optional identity color (any CSS color) shown as the machine's pip. */
  color?: string
  /** Whether the identity color also tints the machine card's border. */
  tintBorder?: boolean
}

/** Secret values the operator typed into the form (write-only direction). */
export interface SecretValues {
  password?: string
  passphrase?: string
}

/** Live transport status of one machine, from the /api-ssh list. */
export interface MachineStatus {
  /** The C-STATE vocabulary (S3-owned); unknown wire values read as disconnected. */
  state: MachineLifecycleState
  /** While reconnecting: when the next retry fires (S3's optional hint). */
  nextRetryHint?: string
  tunnelBaseUrl?: string
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote" (offers install). */
  dshMissing?: boolean
  /** Live progress of the in-flight operation (phase codes translated by the UI). */
  progress?: { phase: 'handshake' | 'starting' | 'probing' | 'installing', attempt?: number, total?: number, log?: string }
}

/** Outcome of a machine.install call (the host's install result). */
export interface InstallResult {
  dshPath: string
  credentialsCopied: boolean
  credentialsError?: string
}

/** One machine row as the /api-ssh machine.list method returns it. */
export interface MachineListItem extends MachineRow, MachineStatus {}

/** The /api-ssh envelope (host plugin protocol). */
export type SshApiResponse
  = | { ok: true, value: unknown }
    | { ok: false, error: { code: string, message: string } }

/** The sync panel's slice of the page state. */
export interface SyncPanelState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** The selectable plugins and skills (null until a preview lands). */
  preview: SyncPreview | null
  /** Whether a sync.apply is in flight. */
  applying: boolean
  /** The latest apply outcome, one entry per requested item; null before the first. */
  results: SyncItemResult[] | null
}

/** Page state published to the component through the snapshot seam. */
export interface MachinesPageState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Redacted machine rows in settings order (the stored, editable set). */
  machines: MachineRow[]
  /** Read-only rows discovered from the host's ~/.ssh/config (aliases). */
  discovered: MachineRow[]
  /** Live status per machine id. */
  statuses: Record<string, MachineStatus>
  /** Streaming log lines per machine id (the S2 event channel; capped tail). */
  logs: Record<string, string[]>
  /** One in-flight connection-plane op per machine id. */
  busy: Record<string, 'test' | 'connect' | 'disconnect' | 'install'>
  /** The latest connection-plane outcome, shown in the banner. */
  notice: MachinesNotice | null
  /** The latest install outcome per machine id (shown under the card). */
  installResults: Record<string, InstallResult>
  /** The sync-to-remote panel state. */
  sync: SyncPanelState
}

/** The fetch seam (window.fetch in the browser, fakes in tests). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/** uSES-compatible snapshot store (getSnapshot returns a fresh object per update). */
export interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

/** Create a snapshot store around one mutable state object. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> & { update: (mutator: (state: T) => void) => void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (mutator) => {
      const next = { ...state }
      mutator(next)
      state = next
      for (const listener of listeners) listener()
    },
  }
}

/** Operator-facing description of any failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read one wire state through the C-STATE vocabulary; unknowns read as disconnected. */
function lifecycleStateOf(raw: unknown): MachineLifecycleState {
  return isLifecycleState(raw) ? raw : 'disconnected'
}

/** How many log lines one machine keeps (the streaming tail). */
const LOG_TAIL_LINES = 300

/** Parse one machine.events value; malformed entries are dropped, not fatal. */
export function machineEventsOf(value: unknown): SshMachineEvent[] {
  if (typeof value !== 'object' || value === null)
    return []
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events))
    return []
  const out: SshMachineEvent[] = []
  for (const entry of events) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const event = entry as Record<string, unknown>
    if (typeof event.seq !== 'number' || typeof event.machineId !== 'string' || typeof event.line !== 'string')
      continue
    if (event.ts !== undefined && typeof event.ts !== 'number')
      continue
    if (event.stage !== undefined && typeof event.stage !== 'string')
      continue
    out.push({
      seq: event.seq,
      ts: typeof event.ts === 'number' ? event.ts : 0,
      machineId: event.machineId,
      stage: typeof event.stage === 'string' ? event.stage : '',
      line: event.line,
      ...event.terminal === true ? { terminal: true } : {},
      ...typeof event.reason === 'string' ? { reason: event.reason } : {},
    })
  }
  return out
}

/** Parse one sync.preview value; null when the shape is wrong. */
export function syncPreviewOf(value: unknown): SyncPreview | null {
  if (typeof value !== 'object' || value === null)
    return null
  const raw = value as { plugins?: unknown, skills?: unknown }
  if (!Array.isArray(raw.plugins) || !Array.isArray(raw.skills))
    return null
  const plugins = raw.plugins.flatMap((entry): SyncPreview['plugins'] => {
    if (typeof entry !== 'object' || entry === null)
      return []
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.spec !== 'string')
      return []
    return [{
      name: item.name,
      spec: item.spec,
      syncable: item.syncable === true,
      ...typeof item.reason === 'string' ? { reason: item.reason } : {},
    }]
  })
  const skills = raw.skills.flatMap((entry): SyncPreview['skills'] => {
    if (typeof entry !== 'object' || entry === null)
      return []
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.root !== 'string')
      return []
    return [{ name: item.name, root: item.root }]
  })
  return { plugins, skills }
}

/** Parse one sync.apply value; null when the shape is wrong. */
export function syncApplyResultOf(value: unknown): SyncApplyResult | null {
  if (typeof value !== 'object' || value === null)
    return null
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items))
    return null
  const out: SyncItemResult[] = []
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || typeof item.ok !== 'boolean')
      continue
    if (item.kind !== 'plugin' && item.kind !== 'skill')
      continue
    out.push({
      kind: item.kind,
      name: item.name,
      ...typeof item.root === 'string' ? { root: item.root } : {},
      ok: item.ok,
      ...typeof item.error === 'string' ? { error: item.error } : {},
    })
  }
  return { items: out }
}

/**
 * The multi-select toggle: independent Set membership per key. This is the
 * semantic the sync items needed (the old panel behaved like a radio group —
 * picking one item silently dropped the others).
 */
export function toggleSelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  return next
}

/** Parse one /api-ssh envelope; non-ok envelopes throw. */
async function envelopeOf(response: Response): Promise<SshApiResponse> {
  return await response.json() as SshApiResponse
}

/** Build a redacted machine row from one machine.list item. */
export function machineRowOf(value: unknown): MachineRow | undefined {
  if (typeof value !== 'object' || value === null)
    return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '')
    return undefined
  if (typeof row.name !== 'string')
    return undefined
  if (typeof row.host !== 'string' || row.host === '')
    return undefined
  if (typeof row.user !== 'string')
    return undefined
  const port = typeof row.port === 'number' ? row.port : 22
  const remotePort = typeof row.remotePort === 'number' ? row.remotePort : 3080
  const startCommand = typeof row.startCommand === 'string' && row.startCommand !== ''
    ? row.startCommand
    : undefined
  const color = typeof row.color === 'string' && row.color !== '' ? row.color : undefined
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port,
    user: row.user,
    hasPassword: row.hasPassword === true,
    hasPassphrase: row.hasPassphrase === true,
    remotePort,
    ...startCommand === undefined ? {} : { startCommand },
    ...color === undefined ? {} : { color },
    ...row.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** The machine.save config row shape (config fields only). */
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

/** Map one form row onto the machine.save payload (id + row + write-only secrets). */
export function savePayloadOf(machine: MachineRow, secrets: SecretValues): { machineId: string, row: MachineSaveRow, secrets?: SecretValues } {
  const row: MachineSaveRow = {
    name: machine.name,
    host: machine.host,
    port: machine.port,
    user: machine.user,
    remotePort: machine.remotePort,
    ...machine.startCommand === undefined || machine.startCommand === '' ? {} : { startCommand: machine.startCommand },
    ...machine.color === undefined || machine.color === '' ? {} : { color: machine.color },
    ...machine.tintBorder === true ? { tintBorder: true } : {},
  }
  const typed: SecretValues = {}
  if (secrets.password !== undefined && secrets.password !== '')
    typed.password = secrets.password
  if (secrets.passphrase !== undefined && secrets.passphrase !== '')
    typed.passphrase = secrets.passphrase
  const payload: { machineId: string, row: MachineSaveRow, secrets?: SecretValues } = { machineId: machine.id, row }
  if (Object.keys(typed).length > 0)
    payload.secrets = typed
  return payload
}

/**
 * The page store: machine CRUD and the connection plane, all through
 * /api-ssh. Every mutation settles the published state; failures surface as
 * `state.error`/`state.notice` rather than throws.
 */
export class MachinesStore {
  /** The published page state. */
  readonly store: SnapshotStore<MachinesPageState> & { update: (mutator: (state: MachinesPageState) => void) => void }

  /** The consumed event cursor (machine.events seq high-water mark). */
  private lastEventSeq = 0

  /** Whether the host still gets asked for machine.events (off after first refusal). */
  private eventsSupported = true

  /**
   * @param fetchFn - the /api-ssh transport (window.fetch in the browser).
   */
  constructor(private readonly fetchFn: FetchFn) {
    this.store = createSnapshotStore<MachinesPageState>({
      status: 'idle',
      error: null,
      machines: [],
      discovered: [],
      statuses: {},
      logs: {},
      busy: {},
      notice: null,
      installResults: {},
      sync: { status: 'idle', error: null, preview: null, applying: false, results: null },
    })
  }

  /** Snapshot subscribe seam for useSyncExternalStore. */
  subscribe = (listener: () => void): () => void => this.store.subscribe(listener)

  /** Snapshot read seam for useSyncExternalStore. */
  getSnapshot = (): MachinesPageState => this.store.getSnapshot()

  /** POST one connection-plane method and return its value; failures throw. */
  private async callApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(SSH_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }),
    })
    const envelope = await envelopeOf(response)
    if (!envelope.ok)
      throw new Error(envelope.error.message)
    return envelope.value as T
  }

  /** Apply one machine.list payload to the published state. */
  private applyList(list: { items?: MachineListItem[], discovered?: MachineListItem[] }): void {
    const machines = (list.items ?? []).map(machineRowOf).filter((row): row is MachineRow => row !== undefined)
    const discovered = (list.discovered ?? []).map(machineRowOf).filter((row): row is MachineRow => row !== undefined)
    const statuses: Record<string, MachineStatus> = {}
    for (const item of [...(list.items ?? []), ...(list.discovered ?? [])]) {
      const status: MachineStatus = { state: lifecycleStateOf(item.state) }
      if (typeof item.nextRetryHint === 'string' && item.nextRetryHint !== '')
        status.nextRetryHint = item.nextRetryHint
      if (item.tunnelBaseUrl !== undefined)
        status.tunnelBaseUrl = item.tunnelBaseUrl
      if (item.lastError !== undefined)
        status.lastError = item.lastError
      if (item.dshMissing === true)
        status.dshMissing = true
      if (item.progress !== undefined)
        status.progress = item.progress
      statuses[item.id] = status
    }
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.machines = machines
      state.discovered = discovered
      state.statuses = statuses
    })
  }

  /** Refresh machines, secret flags, and live statuses from machine.list. */
  async load(): Promise<void> {
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      this.applyList(await this.callApi<{ items?: MachineListItem[], discovered?: MachineListItem[] }>('machine.list', {}))
    }
    catch (error) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  /** Silent refresh: same payload as load(), but never flips the loading banner. */
  async poll(): Promise<void> {
    try {
      this.applyList(await this.callApi<{ items?: MachineListItem[], discovered?: MachineListItem[] }>('machine.list', {}))
      await this.pollEvents()
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Pull machine.events past the cursor and fold the lines into the per-machine
   * logs. A host without the S2 channel (or any refusal) turns the channel off
   * for good — the panel then lives on the status progress fields alone, and
   * the polling loop never fails the page for it.
   */
  private async pollEvents(): Promise<void> {
    if (!this.eventsSupported)
      return
    let events: SshMachineEvent[]
    try {
      events = machineEventsOf(await this.callApi<unknown>('machine.events', {
        ...this.lastEventSeq === 0 ? {} : { after: this.lastEventSeq },
      }))
    }
    catch {
      this.eventsSupported = false
      return
    }
    if (events.length === 0)
      return
    this.lastEventSeq = Math.max(this.lastEventSeq, ...events.map(event => event.seq))
    const byMachine = new Map<string, string[]>()
    for (const event of events) {
      if (event.line === '')
        continue
      byMachine.set(event.machineId, [...(byMachine.get(event.machineId) ?? []), event.line])
    }
    if (byMachine.size === 0)
      return
    this.store.update((state) => {
      for (const [machineId, lines] of byMachine) {
        state.logs[machineId] = [...(state.logs[machineId] ?? []), ...lines].slice(-LOG_TAIL_LINES)
      }
    })
  }

  /**
   * Persist the form: machine.save per row (write-only secrets; absent fields
   * keep the stored value) and machine.remove for ids that vanished.
   * @param machines - the form's machine rows (id is the dict key).
   * @param secrets - secret values the operator typed, keyed by machine id.
   * @returns whether every write landed (failures surface as `state.error`).
   */
  async persist(machines: MachineRow[], secrets: Record<string, SecretValues>): Promise<boolean> {
    const previous = this.store.getSnapshot().machines
    const previousIds = new Set(previous.map(row => row.id))
    try {
      for (const machine of machines) {
        await this.callApi<Record<string, never>>('machine.save', savePayloadOf(machine, secrets[machine.id] ?? {}))
      }
      for (const id of previousIds) {
        if (!machines.some(row => row.id === id)) {
          await this.callApi<Record<string, never>>('machine.remove', { machineId: id })
        }
      }
      this.store.update((state) => {
        state.error = null
      })
      await this.load()
      return true
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
      return false
    }
  }

  /** Remove one machine immediately (config + secrets); returns success. */
  async remove(id: string): Promise<boolean> {
    try {
      await this.callApi<Record<string, never>>('machine.remove', { machineId: id })
      this.store.update((state) => {
        state.error = null
      })
      await this.load()
      return true
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
      return false
    }
  }

  /** Mark one machine busy; failures settle the banner error. */
  private async withBusy(id: string, op: 'test' | 'connect' | 'disconnect' | 'install', action: () => Promise<void>): Promise<void> {
    this.store.update((state) => {
      state.busy[id] = op
      state.notice = null
      state.error = null
    })
    try {
      await action()
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
    finally {
      this.store.update((state) => {
        delete state.busy[id]
      })
    }
  }

  /** One-shot probe: runs `uname -srm` on the machine, never starts the instance. */
  async test(id: string): Promise<void> {
    await this.withBusy(id, 'test', async () => {
      const result = await this.callApi<{ ok: boolean, banner?: string, message?: string }>('machine.test', { machineId: id })
      if (result.ok) {
        this.store.update((state) => {
          state.notice = result.banner === undefined || result.banner === ''
            ? { kind: 'key', key: 'notice.probe_ok' }
            : { kind: 'text', text: result.banner }
          // 探测是旁路健康检查：只在还没有状态记录时落 disconnected，
          // 绝不把一条已建立/进行中的连接打回断开（连接面由轮询真值维护）。
          if (state.statuses[id] === undefined)
            state.statuses[id] = { state: 'disconnected' }
        })
      }
      else {
        this.store.update((state) => {
          state.notice = result.message === undefined || result.message === ''
            ? { kind: 'key', key: 'notice.probe_failed' }
            : { kind: 'text', text: result.message }
          const current = state.statuses[id]
          // 失败只追加 lastError；已有的连接态原样保留（真断开由轮询呈现）。
          state.statuses[id] = current === undefined || current.state === 'disconnected'
            ? { state: 'disconnected', lastError: result.message ?? 'failed' }
            : { ...current, lastError: result.message ?? 'failed' }
        })
      }
    })
  }

  /** Connect the machine: ensures the remote dsh instance and opens the tunnel. */
  async connect(id: string): Promise<void> {
    await this.withBusy(id, 'connect', async () => {
      const link = await this.callApi<{ tunnelBaseUrl: string }>('machine.connect', { machineId: id })
      this.store.update((state) => {
        state.statuses[id] = { state: 'connected', tunnelBaseUrl: link.tunnelBaseUrl }
        state.notice = { kind: 'key', key: 'notice.connected', params: { url: link.tunnelBaseUrl } }
      })
    })
  }

  /** Tear down one machine's link. */
  async disconnect(id: string): Promise<void> {
    await this.withBusy(id, 'disconnect', async () => {
      await this.callApi<Record<string, never>>('machine.disconnect', { machineId: id })
      this.store.update((state) => {
        state.statuses[id] = { state: 'disconnected' }
        state.notice = { kind: 'key', key: 'notice.disconnected' }
      })
    })
  }

  /**
   * One-click remote dsh install: streams through the host's machine.install,
   * which auto-connects on success. A follow-up load picks up the auto-connect
   * status (the polling loop keeps refreshing while it is in flight).
   */
  async install(id: string): Promise<void> {
    await this.withBusy(id, 'install', async () => {
      const result = await this.callApi<InstallResult>('machine.install', { machineId: id })
      this.store.update((state) => {
        state.installResults[id] = result
      })
      await this.load()
    })
  }

  /** Load the sync selection list (local plugins and skills) from sync.preview. */
  async loadSyncPreview(): Promise<void> {
    this.store.update((state) => {
      state.sync.status = 'loading'
      state.sync.error = null
    })
    try {
      const preview = syncPreviewOf(await this.callApi<unknown>('sync.preview', {}))
      if (preview === null)
        throw new Error('malformed sync.preview payload')
      this.store.update((state) => {
        state.sync.status = 'ready'
        state.sync.preview = preview
      })
    }
    catch (error) {
      this.store.update((state) => {
        state.sync.status = 'error'
        state.sync.error = messageOf(error)
      })
    }
  }

  /**
   * Sync one selection to a machine. The per-item outcomes land in
   * `state.sync.results` even on partial failure — a request-level failure
   * (session unreachable) surfaces as `state.sync.error`.
   * @param machineId - the connected target machine.
   * @param plugins - the selected plugin refs.
   * @param skills - the selected skill refs.
   */
  async applySync(machineId: string, plugins: SyncPreview['plugins'], skills: SyncPreview['skills']): Promise<void> {
    this.store.update((state) => {
      state.sync.applying = true
      state.sync.error = null
    })
    try {
      const result = syncApplyResultOf(await this.callApi<unknown>('sync.apply', {
        machineId,
        plugins: plugins.map(plugin => ({ name: plugin.name, spec: plugin.spec })),
        skills: skills.map(skill => ({ name: skill.name, root: skill.root })),
      }))
      if (result === null)
        throw new Error('malformed sync.apply payload')
      this.store.update((state) => {
        state.sync.results = result.items
      })
    }
    catch (error) {
      this.store.update((state) => {
        state.sync.error = messageOf(error)
      })
    }
    finally {
      this.store.update((state) => {
        state.sync.applying = false
      })
    }
  }
}
