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

import { SSH_API_PATH } from '../constants/index.js'

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
  state: 'disconnected' | 'connecting' | 'connected'
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
  /** One in-flight connection-plane op per machine id. */
  busy: Record<string, 'test' | 'connect' | 'disconnect' | 'install'>
  /** The latest connection-plane outcome, shown in the banner. */
  notice: string | null
  /** The latest install outcome per machine id (shown under the card). */
  installResults: Record<string, InstallResult>
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
      busy: {},
      notice: null,
      installResults: {},
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
      const status: MachineStatus = { state: item.state }
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
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Persist the form: machine.save per row (write-only secrets; absent fields
   * keep the stored value) and machine.remove for ids that vanished.
   * @param machines - the form's machine rows (id is the dict key).
   * @param secrets - secret values the operator typed, keyed by machine id.
   */
  async persist(machines: MachineRow[], secrets: Record<string, SecretValues>): Promise<void> {
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
    }
    catch (error) {
      this.store.update((state) => {
        state.error = messageOf(error)
      })
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
          state.notice = result.banner ?? 'ok'
          state.statuses[id] = { state: 'disconnected' }
        })
      }
      else {
        this.store.update((state) => {
          state.notice = result.message ?? 'failed'
          state.statuses[id] = { state: 'disconnected', lastError: result.message ?? 'failed' }
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
        state.notice = link.tunnelBaseUrl
      })
    })
  }

  /** Tear down one machine's link. */
  async disconnect(id: string): Promise<void> {
    await this.withBusy(id, 'disconnect', async () => {
      await this.callApi<Record<string, never>>('machine.disconnect', { machineId: id })
      this.store.update((state) => {
        state.statuses[id] = { state: 'disconnected' }
        state.notice = 'disconnected'
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
}
