import type { Buffer } from 'node:buffer'
import type { Config } from '../storage/index.js'
/**
 * Per-machine connection manager: profile map, the disconnected/connecting/
 * connected state machine, TOFU host-key gating, remote-instance assurance,
 * and the tunnel lifecycle. Transport-agnostic — tests inject a fake
 * transport and never touch the network.
 * @module dsh-tauri-ssh/host/service/manager
 */

import type { MachineId, MachineProfile, MachineView, SshInstallResult, SshLink, SshMachineStatus, SshProgress, SshTestResult } from '../types/index.js'
import type { KnownHostsStore } from './host-keys.js'
import type { SshSession, SshTransport, SshTunnelHandle } from './transport.js'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { SshError } from '../types/index.js'
import { credentialsCopyCommand, describeExecFailure, DshMissingError, ensureRemoteInstance, firstLineOf, installCommandFor, probeDshCommand, readEnvCredentials } from './bootstrap.js'
import { fingerprintHostKey } from './host-keys.js'

/** One machine's live connection state. */
interface MachineState {
  /** Monotonic attempt counter; a disconnect invalidates in-flight connects. */
  generation: number
  /** Published connection phase; the status source of truth. */
  phase: 'disconnected' | 'connecting' | 'connected'
  /** In-flight connect promise; concurrent connects share it. */
  connecting?: Promise<SshLink>
  /** In-flight install promise; concurrent installs share it. */
  installing?: Promise<SshInstallResult>
  /** The authenticated SSH session, while connected. */
  session?: SshSession
  /** The local tunnel listener, while connected. */
  tunnel?: SshTunnelHandle
  /** The published link, while connected. */
  link?: SshLink
  /** Operator-facing description of the last failed transition. */
  lastError?: string
  /** Whether the last failure was "dsh not installed on the remote". */
  dshMissing?: boolean
  /** Live progress of the in-flight operation. */
  progress?: SshProgress
  /** Ring buffer of the in-flight install's streaming output (newest last). */
  installLog?: string[]
}

/** Manager dependencies (all transport seams injectable for tests). */
export interface SshManagerDeps {
  transport: SshTransport
  knownHosts: KnownHostsStore
  config: Config
  /** Publish one machine's status change (the service emits the seam event). */
  emitStatus: (machineId: MachineId, status: SshMachineStatus) => void
  /** Local dsh `.env` credentials to copy after an install (defaults to the host's own). */
  readEnvCredentials?: () => ReturnType<typeof readEnvCredentials>
}

/** The sentinel rethrown when an in-flight attempt loses to a disconnect. */
class AttemptCancelled extends Error {}

/**
 * The per-machine state machine. All public methods are safe to call
 * concurrently: connects dedupe on the in-flight promise, disconnects settle
 * a live link idempotently, and session-closed callbacks race-check their
 * ownership before tearing down. Every transition publishes through
 * `emitStatus` exactly when it happens; a superseded attempt never publishes.
 */
export class SshManager {
  private readonly profiles = new Map<MachineId, MachineProfile>()
  private readonly states = new Map<MachineId, MachineState>()

  /**
   * @param deps - transport, TOFU store, timing config, and the status publisher.
   */
  constructor(private readonly deps: SshManagerDeps) {}

  /**
   * Replace the profile map (settings changed). Machines whose profile
   * vanished are disconnected; live connections keep their established link
   * until the operator reconnects (a profile edit applies on next connect).
   * @param profiles - the new profile map keyed by machine id.
   */
  refreshProfiles(profiles: ReadonlyMap<MachineId, MachineProfile>): void {
    this.profiles.clear()
    for (const [id, profile] of profiles) this.profiles.set(id, profile)
    for (const id of this.states.keys()) {
      if (!this.profiles.has(id))
        void this.disconnect(id)
    }
  }

  /** Redacted views of every profile, in settings order. */
  profileViews(): MachineView[] {
    return [...this.profiles.values()].map(profileView)
  }

  /** Transport status of every known machine, in settings order. */
  statuses(): SshMachineStatus[] {
    return [...this.profiles.keys()].map(id => this.status(id))
  }

  /** Transport status of one machine; unknown ids report `disconnected`. */
  status(machineId: MachineId): SshMachineStatus {
    const state = this.states.get(machineId)
    const lastError = state?.lastError
    const progress = state?.progress
    return {
      machineId,
      state: state?.phase ?? 'disconnected',
      ...state?.link !== undefined ? { tunnelBaseUrl: state.link.tunnelBaseUrl } : {},
      ...lastError === undefined ? {} : { lastError },
      ...state?.dshMissing === true ? { dshMissing: true } : {},
      ...progress === undefined ? {} : { progress },
    }
  }

  /** The current tunnel link of one machine, when connected. */
  link(machineId: MachineId): SshLink | undefined {
    return this.states.get(machineId)?.link
  }

  /**
   * One-shot probe: authenticate, run `uname -srm`, close. Never starts the
   * remote instance and never leaves a connection behind.
   * @param machineId - the machine to probe.
   * @param signal - aborts the probe.
   * @returns the probe outcome.
   * @throws {SshError} `machine-not-found` for an unknown id.
   */
  async test(machineId: MachineId, signal?: AbortSignal): Promise<SshTestResult> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    state.progress = { phase: 'handshake' }
    this.emit(machineId)
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, key => this.checkHostKey(machineId, key), signal)
    }
    catch (error) {
      delete state.progress
      this.emit(machineId)
      return { ok: false, message: describeSshFailure(error) }
    }
    delete state.progress
    this.emit(machineId)
    try {
      const result = await session.exec('uname -srm')
      if (result.code !== 0) {
        return { ok: false, message: describeExecFailure(result.code, result.stderr) }
      }
      return { ok: true, banner: result.stdout.trim() }
    }
    catch (error) {
      return { ok: false, message: describeSshFailure(error) }
    }
    finally {
      await session.close()
    }
  }

  /**
   * Establish (or reuse) the machine link: SSH connection, remote-instance
   * assurance, and the local tunnel. Idempotent.
   * @param machineId - the machine to connect.
   * @param signal - aborts the connection attempt.
   * @returns the live link.
   * @throws {SshError} on any failure.
   */
  async connect(machineId: MachineId, signal?: AbortSignal): Promise<SshLink> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    if (state.link !== undefined)
      return state.link
    if (state.connecting === undefined) {
      state.phase = 'connecting'
      state.progress = { phase: 'handshake' }
      this.emit(machineId)
      const attempt = this.performConnect(machineId, profile, signal)
      state.connecting = attempt.finally(() => {
        // The slot is only ever replaced while undefined, so the settling
        // attempt always owns it at this point.
        delete this.states.get(machineId)?.connecting
      })
    }
    return state.connecting
  }

  /**
   * Tear down one machine's link, invalidating any in-flight connect.
   * Idempotent for an absent link; unknown ids resolve without writing
   * anything.
   * @param machineId - the machine to disconnect.
   */
  async disconnect(machineId: MachineId): Promise<void> {
    const state = this.states.get(machineId)
    if (state === undefined)
      return
    state.generation += 1
    delete state.lastError
    delete state.dshMissing
    delete state.progress
    delete state.installLog
    const tunnel = state.tunnel
    const session = state.session
    delete state.tunnel
    delete state.session
    delete state.link
    state.phase = 'disconnected'
    if (tunnel !== undefined)
      await tunnel.close().catch(() => undefined)
    if (session !== undefined)
      await session.close().catch(() => undefined)
    this.emit(machineId)
  }

  /**
   * Disconnect every machine (composition teardown).
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.states.keys()].map(id => this.disconnect(id)))
  }

  /** @throws {SshError} `machine-not-found` for an unknown id. */
  private requireProfile(machineId: MachineId): MachineProfile {
    const profile = this.profiles.get(machineId)
    if (profile === undefined) {
      throw new SshError('machine-not-found', machineId, `no SSH machine profile "${machineId}"`)
    }
    return profile
  }

  private ensureState(machineId: MachineId): MachineState {
    let state = this.states.get(machineId)
    if (state === undefined) {
      state = { generation: 0, phase: 'disconnected' }
      this.states.set(machineId, state)
    }
    return state
  }

  /** TOFU gate: accept a known fingerprint, remember a first sight, reject a mismatch. */
  private async checkHostKey(machineId: MachineId, hostKey: Buffer): Promise<boolean> {
    const fingerprint = fingerprintHostKey(hostKey)
    const verdict = await this.deps.knownHosts.verify(machineId, fingerprint)
    if (verdict === 'accepted')
      return true
    if (verdict === 'unknown') {
      await this.deps.knownHosts.accept(machineId, fingerprint)
      return true
    }
    return false
  }

  /**
   * One full connection attempt. Publishes exactly one terminal transition
   * (connected or disconnected) unless a disconnect superseded the attempt —
   * a superseded attempt closes its session and throws without publishing.
   */
  private async performConnect(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<SshLink> {
    const state = this.ensureState(machineId)
    const generation = state.generation
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, key => this.checkHostKey(machineId, key), signal)
    }
    catch (error) {
      if (generation === state.generation) {
        delete state.progress
        state.lastError = describeSshFailure(error)
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      throw new SshError('machine-connect-failed', machineId, describeSshFailure(error))
    }
    try {
      await ensureRemoteInstance(
        session,
        profile,
        this.deps.config.healthCheckTimeoutMs,
        this.deps.config.healthPollIntervalMs,
        this.deps.config.healthPollAttempts,
        (progress) => {
          if (generation === state.generation) {
            state.progress = progress
            this.emit(machineId)
          }
        },
      )
      const tunnel = await session.openTunnel(profile.remotePort)
      // A disconnect that landed anywhere above (bootstrap, tunnel opening)
      // must not publish a link; tear the tunnel down and abort the attempt.
      if (generation !== state.generation) {
        await tunnel.close().catch(() => undefined)
        throw new AttemptCancelled()
      }
      const link: SshLink = {
        machineId,
        tunnelBaseUrl: `http://127.0.0.1:${tunnel.localPort}`,
      }
      state.session = session
      state.tunnel = tunnel
      state.link = link
      delete state.progress
      state.phase = 'connected'
      session.onClosed(() => {
        const current = this.states.get(machineId)
        if (current?.session !== session)
          return
        current.lastError = 'SSH connection closed'
        const tunnel = current.tunnel
        delete current.session
        delete current.tunnel
        delete current.link
        current.phase = 'disconnected'
        void tunnel?.close().catch(() => undefined)
        this.emit(machineId)
      })
      this.emit(machineId)
      return link
    }
    catch (error) {
      await session.close().catch(() => undefined)
      if (error instanceof AttemptCancelled) {
        throw new SshError('machine-connect-failed', machineId, 'connection cancelled by disconnect')
      }
      if (generation === state.generation) {
        delete state.progress
        state.lastError = error instanceof Error ? error.message : String(error)
        if (error instanceof DshMissingError)
          state.dshMissing = true
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      throw new SshError(
        error instanceof DshMissingError ? 'machine-dsh-missing' : 'machine-bootstrap-failed',
        machineId,
        state.lastError ?? 'remote instance bootstrap failed',
      )
    }
  }

  /**
   * One-shot remote dsh install: authenticate, stream the official installer
   * (clone + pnpm install + build), resolve the installed binary, copy the
   * local API credentials into the remote `~/.dsh/.env`, then hand off to
   * {@link connect} automatically. Idempotent while in flight.
   * @param machineId - the machine to install on.
   * @param signal - aborts the attempt.
   * @returns the install outcome.
   * @throws {SshError} on any failure (connect, install, or probe).
   */
  async install(machineId: MachineId, signal?: AbortSignal): Promise<SshInstallResult> {
    const profile = this.requireProfile(machineId)
    const state = this.ensureState(machineId)
    if (state.installing === undefined) {
      state.progress = { phase: 'installing' }
      this.emit(machineId)
      const attempt = this.performInstall(machineId, profile, signal)
      state.installing = attempt.finally(() => {
        // The slot is only ever replaced while undefined, so the settling
        // attempt always owns it at this point.
        delete this.states.get(machineId)?.installing
      })
    }
    return state.installing
  }

  /**
   * One full install attempt. Publishes the terminal transition unless a
   * disconnect superseded the attempt; a successful install hands off to
   * {@link connect} (fire-and-forget — its outcome lands in the status).
   */
  private async performInstall(machineId: MachineId, profile: MachineProfile, signal?: AbortSignal): Promise<SshInstallResult> {
    const state = this.ensureState(machineId)
    const generation = state.generation
    let session: SshSession
    try {
      session = await this.deps.transport.connect(profile, key => this.checkHostKey(machineId, key), signal)
    }
    catch (error) {
      if (generation === state.generation) {
        delete state.progress
        state.lastError = describeSshFailure(error)
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      throw new SshError('machine-connect-failed', machineId, describeSshFailure(error))
    }
    try {
      const installTimeoutMs = this.deps.config.installTimeoutMs
      const result = await session.exec(installCommandFor(this.deps.config), {
        ...installTimeoutMs === undefined ? {} : { timeoutMs: installTimeoutMs },
        onData: (chunk) => {
          if (generation !== state.generation)
            return
          state.installLog = [...(state.installLog ?? []), chunk].slice(-40)
          state.progress = {
            phase: 'installing',
            log: state.installLog.join('').slice(-2000),
          }
        },
      })
      if (result.code !== 0) {
        const log = state.installLog?.join('').trim() ?? ''
        const tail = log === '' ? '(no output captured)' : log.split('\n').slice(-5).join(' | ')
        throw new Error(
          `dsh install failed on "${profile.host}": ${describeExecFailure(result.code, result.stderr)}; `
          + `installer output tail: ${tail}`,
        )
      }
      if (generation !== state.generation)
        throw new AttemptCancelled()
      const dshPath = firstLineOf((await session.exec(probeDshCommand())).stdout)
      if (dshPath === '') {
        throw new Error(
          `dsh install finished on "${profile.host}" but no dsh binary is reachable `
          + '(checked the login PATH, ~/.local/bin and ~/.dsh/source/current)',
        )
      }
      let credentialsCopied = false
      let credentialsError: string | undefined
      try {
        credentialsCopied = await this.copyCredentials(session)
      }
      catch (error) {
        credentialsError = error instanceof Error ? error.message : String(error)
      }
      await session.close().catch(() => undefined)
      if (generation === state.generation) {
        delete state.progress
        delete state.dshMissing
        delete state.installLog
        delete state.lastError
        state.phase = 'disconnected'
        this.emit(machineId)
        // The operator's intent behind "install" is "connect": hand off and
        // let the connect plane report its own progress/outcome.
        void this.connect(machineId).catch(() => undefined)
      }
      return {
        dshPath,
        credentialsCopied,
        ...credentialsError === undefined ? {} : { credentialsError },
      }
    }
    catch (error) {
      await session.close().catch(() => undefined)
      if (error instanceof AttemptCancelled) {
        throw new SshError('machine-install-failed', machineId, 'install cancelled by disconnect')
      }
      if (generation === state.generation) {
        delete state.progress
        delete state.installLog
        state.lastError = error instanceof Error ? error.message : String(error)
        state.phase = 'disconnected'
        this.emit(machineId)
      }
      throw new SshError('machine-install-failed', machineId, state.lastError ?? 'dsh install failed')
    }
  }

  /**
   * Copy the local API credentials into the remote `~/.dsh/.env`, unless the
   * remote already carries a key (kept untouched). A failure to read the
   * local `.env` is not an error — it just reports `false`.
   * @param session - the authenticated session (install connection).
   * @returns whether the credentials were copied.
   */
  private async copyCredentials(session: SshSession): Promise<boolean> {
    const credentials = (this.deps.readEnvCredentials ?? defaultEnvCredentials)()
    const apiKey = credentials.apiKey
    if (apiKey === undefined)
      return false
    const result = await session.exec(credentialsCopyCommand({
      apiKey,
      ...credentials.baseUrl === undefined ? {} : { baseUrl: credentials.baseUrl },
    }))
    if (result.code !== 0) {
      throw new Error(`writing remote credentials failed: ${describeExecFailure(result.code, result.stderr)}`)
    }
    return result.stdout.includes('copied')
  }

  private emit(machineId: MachineId): void {
    this.deps.emitStatus(machineId, this.status(machineId))
  }
}

/** Redacted wire view of one profile. */
export function profileView(profile: MachineProfile): MachineView {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    hasPassword: profile.password !== undefined,
    hasPassphrase: profile.passphrase !== undefined,
    remotePort: profile.remotePort,
    ...profile.startCommand === undefined ? {} : { startCommand: profile.startCommand },
    ...profile.color === undefined ? {} : { color: profile.color },
    ...profile.tintBorder === true ? { tintBorder: true } : {},
  }
}

/** One operator-facing fragment for an SSH transport failure. */
export function describeSshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === '')
    return 'SSH connection failed'
  return message
}

/** The default local `.env` read: the harness home (`$DSH_HOME`, else `~/.dsh`). */
function defaultEnvCredentials(): ReturnType<typeof readEnvCredentials> {
  return readEnvCredentials(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.env'))
}
