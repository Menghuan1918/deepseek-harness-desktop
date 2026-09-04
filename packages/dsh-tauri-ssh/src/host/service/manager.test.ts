import type { MachineProfile } from '../types/index.js'
import type { SshExecOptions, SshExecResult, SshSession, SshTransport, SshTunnelHandle } from './transport.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineId, SshError } from '../types/index.js'
import { KnownHostsStore } from './host-keys.js'
import { SshManager } from './manager.js'

const profile: MachineProfile = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  password: 'sekrit',
  remotePort: 3080,
}

const secondProfile: MachineProfile = {
  ...profile,
  id: MachineId('m2'),
  name: 'beta',
}

const config = {
  connectTimeoutMs: 15000,
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
  installTimeoutMs: 60000,
}

/** The dsh-path answer a remote probe would print. */
const RESOLVED_DSH = '/usr/local/bin/dsh'

class FakeSession implements SshSession {
  commands: string[] = []
  options: SshExecOptions[] = []
  closed = false
  tunnel: SshTunnelHandle | undefined
  closeCalls = 0
  tunnelCloseCalls = 0
  closeError: Error | undefined
  tunnelCloseError: Error | undefined
  tunnelGate: Promise<void> | undefined
  tunnelStarted: (() => void) | undefined
  execGate: ((command: string, index: number) => Promise<void> | undefined) | undefined
  /** What the remote dsh probe answers; undefined = a binary is reachable. */
  dshProbeResult: string | undefined = RESOLVED_DSH
  private closedCallbacks: Array<() => void> = []

  constructor(
    public healthHealthy: (commandIndex: number) => boolean,
    public connectError?: Error,
    public startError?: Error,
    public installError?: Error,
  ) {}

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult> {
    this.commands.push(command)
    this.options.push(options ?? {})
    const respond = (): SshExecResult => {
      if (this.connectError !== undefined)
        throw this.connectError
      if (command.includes('command -v dsh')) {
        return { code: 0, stdout: this.dshProbeResult ?? '', stderr: '' }
      }
      if (command.includes('git clone')) {
        if (this.installError !== undefined)
          return { code: 1, stdout: '', stderr: this.installError.message }
        return { code: 0, stdout: 'installing...', stderr: '' }
      }
      if (command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')) {
        return { code: 0, stdout: this.credentialsAnswer, stderr: '' }
      }
      if (command.includes('curl') && !this.healthHealthy(this.commands.length - 1)) {
        return { code: 7, stdout: '', stderr: 'refused' }
      }
      if (command.includes('web --host') && this.startError !== undefined) {
        return { code: 127, stdout: '', stderr: this.startError.message }
      }
      return { code: 0, stdout: '200', stderr: '' }
    }
    const gate = this.execGate?.(command, this.commands.length - 1)
    if (gate === undefined)
      return Promise.resolve(respond())
    return gate.then(respond)
  }

  /** The stdout the credentials-copy command answers (default: copied). */
  credentialsAnswer = 'copied'

  async openTunnel(): Promise<SshTunnelHandle> {
    this.tunnelStarted?.()
    if (this.tunnelGate !== undefined)
      await this.tunnelGate
    this.tunnel = {
      localPort: 49152,
      close: async () => {
        this.tunnelCloseCalls += 1
        this.tunnel = undefined
        if (this.tunnelCloseError !== undefined)
          throw this.tunnelCloseError
      },
    }
    return this.tunnel
  }

  onClosed(callback: () => void): void {
    this.closedCallbacks.push(callback)
  }

  drop(): void {
    for (const callback of this.closedCallbacks.splice(0)) callback()
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.closed = true
    if (this.closeError !== undefined)
      throw this.closeError
  }
}

class FakeTransport implements SshTransport {
  sessions: FakeSession[] = []
  connectCalls = 0
  hostKeys: Array<{ key: Buffer, accepted: boolean }> = []
  rejectKeys = false

  constructor(private readonly sessionFactory: () => FakeSession) {}

  async connect(
    _profile: MachineProfile,
    hostKeyVerifier: (key: Buffer) => boolean | Promise<boolean>,
  ): Promise<SshSession> {
    this.connectCalls += 1
    const session = this.sessionFactory()
    this.sessions.push(session)
    if (this.rejectKeys)
      throw new Error('auth failed')
    if (session.connectError !== undefined)
      throw session.connectError
    const key = Buffer.from('host-key')
    this.hostKeys.push({ key, accepted: await hostKeyVerifier(key) })
    return session
  }
}

const roots: string[] = []

function tempKnownHosts(): KnownHostsStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-manager-'))
  roots.push(root)
  return new KnownHostsStore(join(root, 'known-hosts.json'))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function boot(overrides: Partial<{
  sessionFactory: () => FakeSession
  rejectKeys: boolean
  readEnvCredentials: () => { apiKey?: string, baseUrl?: string }
  config: typeof config
}> = {}) {
  const transport = new FakeTransport(overrides.sessionFactory ?? (() => new FakeSession(() => true)))
  transport.rejectKeys = overrides.rejectKeys ?? false
  const emits: Array<{ id: MachineId, state: string, progress?: { phase: string } }> = []
  const manager = new SshManager({
    transport,
    knownHosts: tempKnownHosts(),
    config: overrides.config ?? config,
    ...overrides.readEnvCredentials === undefined ? {} : { readEnvCredentials: overrides.readEnvCredentials },
    emitStatus: (id, status) => {
      emits.push({ id, state: status.state, ...status.progress === undefined ? {} : { progress: status.progress } })
    },
  })
  manager.refreshProfiles(new Map([[profile.id, profile], [secondProfile.id, secondProfile]]))
  return { manager, transport, emits }
}

describe('sshManager', () => {
  it('lists redacted profile views in settings order', () => {
    const { manager } = boot()
    const views = manager.profileViews()
    expect(views.map(view => view.id)).toEqual([MachineId('m1'), MachineId('m2')])
    expect(views[0]).toMatchObject({
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      hasPassword: true,
      hasPassphrase: false,
      remotePort: 3080,
    })
    expect(manager.statuses().map(status => status.machineId)).toEqual([MachineId('m1'), MachineId('m2')])
    expect(manager.statuses()[0]).toEqual({ machineId: MachineId('m1'), state: 'disconnected' })
  })

  it('reports unknown machines as disconnected without state', () => {
    const { manager } = boot()
    expect(manager.status(MachineId('ghost'))).toEqual({ machineId: MachineId('ghost'), state: 'disconnected' })
    expect(manager.link(MachineId('ghost'))).toBeUndefined()
  })

  it('connects a healthy machine and publishes the link', async () => {
    const { manager, transport, emits } = boot()
    const link = await manager.connect(MachineId('m1'))
    expect(link.tunnelBaseUrl).toBe('http://127.0.0.1:49152')
    expect(manager.link(MachineId('m1'))?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
    expect(manager.status(MachineId('m1')).state).toBe('connected')
    expect(transport.connectCalls).toBe(1)
    expect(transport.hostKeys[0]?.accepted).toBe(true)
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'connected'])
  })

  it('is idempotent for an already-connected machine', async () => {
    const { manager, transport } = boot()
    const first = await manager.connect(MachineId('m1'))
    const second = await manager.connect(MachineId('m1'))
    expect(second).toBe(first)
    expect(transport.connectCalls).toBe(1)
  })

  it('dedupes concurrent connects onto one attempt', async () => {
    const { manager, transport } = boot()
    const [a, b] = await Promise.all([manager.connect(MachineId('m1')), manager.connect(MachineId('m1'))])
    expect(a).toBe(b)
    expect(transport.connectCalls).toBe(1)
  })

  it('auto-starts the instance when the first probe fails', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager } = boot({ sessionFactory: () => session })
    await manager.connect(MachineId('m1'))
    expect(session.commands[0]).toContain('curl')
    expect(session.commands[1]).toContain('command -v dsh')
    expect(session.commands[2]).toContain(`${RESOLVED_DSH} web --host 127.0.0.1 --port 3080`)
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('publishes live progress phases while connecting', async () => {
    const session = new FakeSession(index => index !== 0)
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'handshake' })
    await pending
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    const phases = emits.filter(entry => entry.progress !== undefined).map(entry => entry.progress)
    expect(phases).toEqual([
      { phase: 'handshake' },
      { phase: 'starting' },
      { phase: 'probing', attempt: 1, total: 3 },
    ])
  })

  it('does not publish bootstrap progress once a disconnect superseded the attempt', async () => {
    let releaseStart: (() => void) | undefined
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const session = new FakeSession(index => index !== 0)
    session.execGate = command => command.includes('web --host') ? startGate : undefined
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    // Wait until the start command is in flight, then supersede the attempt.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('web --host'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    releaseStart!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed' })
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    // 'starting' fires before the start command (legitimately pre-disconnect);
    // the post-disconnect 'probing' phases must never be published.
    expect(emits.filter(entry => entry.progress?.phase === 'probing')).toEqual([])
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'connecting', 'disconnected'])
  })

  it('clears progress and reports the failure when connect fails', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow()
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.progress).toBeUndefined()
    expect(status.lastError).toBe('auth failed')
  })

  it('fails loud with machine-connect-failed on transport errors', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.connect(MachineId('m1'))).rejects.toThrow(SshError)
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toBe('auth failed')
  })

  it('fails loud with machine-bootstrap-failed when the instance never answers', async () => {
    const { manager } = boot({ sessionFactory: () => new FakeSession(() => false) })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('fails loud with machine-bootstrap-failed when the start command fails', async () => {
    const { manager } = boot({
      sessionFactory: () => new FakeSession(() => false, undefined, new Error('dsh: not found')),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
  })

  it('rejects unknown machine ids with machine-not-found', async () => {
    const { manager, transport } = boot()
    await expect(manager.connect(MachineId('ghost'))).rejects.toMatchObject({ code: 'machine-not-found' })
    await expect(manager.test(MachineId('ghost'))).rejects.toMatchObject({ code: 'machine-not-found' })
    expect(transport.connectCalls).toBe(0)
  })

  it('resolves idempotently for unknown machine ids on disconnect', async () => {
    const { manager } = boot()
    await manager.disconnect(MachineId('ghost'))
    expect(manager.status(MachineId('ghost')).state).toBe('disconnected')
  })

  it('disconnects a connected machine idempotently', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    await manager.disconnect(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.link(MachineId('m1'))).toBeUndefined()
    expect(session.closeCalls).toBe(1)
    expect(session.tunnelCloseCalls).toBe(1)
  })

  it('swallows teardown failures on disconnect', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.tunnelCloseError = new Error('listener busy')
    session.closeError = new Error('socket busy')
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('cancels an in-flight connect on disconnect', async () => {
    const { manager, emits } = boot({ rejectKeys: true })
    const pending = manager.connect(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'disconnected'])
  })

  it('cancels an in-flight connect that disconnects during bootstrap', async () => {
    let releaseProbe: (() => void) | undefined
    let markProbeStarted: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.exec = () => {
      markProbeStarted?.()
      return gate.then(() => ({ code: 0, stdout: '200', stderr: '' }))
    }
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await probeStarted
    await manager.disconnect(MachineId('m1'))
    releaseProbe!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('cancels an in-flight connect that disconnects during tunnel opening', async () => {
    let releaseTunnel: (() => void) | undefined
    let markTunnelStarted: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseTunnel = resolve
    })
    const tunnelStarted = new Promise<void>((resolve) => {
      markTunnelStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.tunnelGate = gate
    session.tunnelStarted = () => markTunnelStarted?.()
    session.tunnelCloseError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await tunnelStarted
    await manager.disconnect(MachineId('m1'))
    releaseTunnel!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed', message: /cancelled by disconnect/ })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('discards a tunnel failure that a disconnect superseded', async () => {
    let releaseTunnel: ((error: Error) => void) | undefined
    let markTunnelStarted: (() => void) | undefined
    const tunnelStarted = new Promise<void>((resolve) => {
      markTunnelStarted = resolve
    })
    const session = new FakeSession(() => true)
    session.tunnelGate = new Promise<never>((_, reject) => {
      releaseTunnel = reject
    })
    session.tunnelStarted = () => markTunnelStarted?.()
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    await tunnelStarted
    await manager.disconnect(MachineId('m1'))
    releaseTunnel!(new Error('tunnel setup failed'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(emits.map(entry => entry.state)).toEqual(['connecting', 'disconnected'])
  })

  it('marks the machine disconnected when the SSH session drops', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.drop()
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toBe('SSH connection closed')
    expect(manager.link(MachineId('m1'))).toBeUndefined()
  })

  it('ignores session-close callbacks that no longer own the state', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const oldSession = transport.sessions[0]!
    await manager.disconnect(MachineId('m1'))
    await manager.connect(MachineId('m1'))
    oldSession.drop()
    expect(manager.status(MachineId('m1')).state).toBe('connected')
  })

  it('swallows tunnel close failures when the session drops', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    const session = transport.sessions[0]!
    session.tunnelCloseError = new Error('listener busy')
    session.drop()
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
  })

  it('probes a machine with a remote banner', async () => {
    const session = new FakeSession(() => true)
    session.commands = []
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: true, banner: '200' })
    expect(session.commands).toEqual(['uname -srm'])
    expect(session.closed).toBe(true)
  })

  it('reports probe failures without throwing', async () => {
    const session = new FakeSession(() => true, undefined, undefined)
    session.exec = () => Promise.resolve({ code: 1, stdout: '', stderr: 'denied' })
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'exit 1: denied' })
  })

  it('reports transport failures during probes without throwing', async () => {
    const { manager } = boot({ rejectKeys: true })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'auth failed' })
  })

  it('reports exec failures during probes without throwing', async () => {
    const session = new FakeSession(() => true)
    session.exec = () => Promise.reject(new Error('channel reset'))
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'channel reset' })
  })

  it('reports non-Error probe failures without throwing', async () => {
    const session = new FakeSession(() => true)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a hostile non-Error rejection
    // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeSshFailure's String(error) arm
    session.exec = () => Promise.reject('plain string')
    const { manager } = boot({ sessionFactory: () => session })
    const result = await manager.test(MachineId('m1'))
    expect(result).toEqual({ ok: false, message: 'plain string' })
  })

  it('fails loud with an empty transport error message', async () => {
    const session = new FakeSession(() => true)
    // eslint-disable-next-line unicorn/error-message -- empty message on purpose: covers the 'SSH connection failed' fallback
    session.connectError = new Error('')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed', message: 'SSH connection failed' })
    const probe = await manager.test(MachineId('m1'))
    expect(probe).toEqual({ ok: false, message: 'SSH connection failed' })
  })

  it('fails loud with a non-Error bootstrap failure', async () => {
    const session = new FakeSession(() => false)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise a hostile non-Error rejection
    // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeSshFailure's String(error) arm
    session.exec = () => Promise.reject('channel reset')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBe('channel reset')
  })

  it('swallows close failures during a failed bootstrap', async () => {
    const session = new FakeSession(() => false)
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(session.closeCalls).toBe(1)
  })

  it('exposes the startCommand override in profile views', () => {
    const { manager } = boot()
    const overridden: MachineProfile = { ...profile, startCommand: 'dsh web --port 4000' }
    manager.refreshProfiles(new Map([[MachineId('m1'), overridden]]))
    expect(manager.profileViews()[0]?.startCommand).toBe('dsh web --port 4000')
  })

  it('rejects a mismatched host key (TOFU conflict)', async () => {
    const { manager, transport } = boot()
    await manager.connect(MachineId('m1'))
    transport.connect = async function (this: FakeTransport, _p: MachineProfile, verifier: (key: Buffer) => boolean | Promise<boolean>): Promise<SshSession> {
      const accepted = await verifier(Buffer.from('other-key'))
      if (!accepted)
        throw new Error('Host key verification failed')
      const session = new FakeSession(() => true)
      this.sessions.push(session)
      return session
    }
    await manager.disconnect(MachineId('m1'))
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
  })

  it('disconnects machines whose profile vanished on refresh', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    manager.refreshProfiles(new Map([[secondProfile.id, secondProfile]]))
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.status(MachineId('m2')).state).toBe('disconnected')
  })

  it('keeps a connected machine whose profile survives a refresh', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    manager.refreshProfiles(new Map([[profile.id, profile], [secondProfile.id, secondProfile]]))
    expect(manager.status(MachineId('m1')).state).toBe('connected')
    expect(manager.link(MachineId('m1'))).toBeDefined()
  })

  it('disposes every connection', async () => {
    const { manager } = boot()
    await manager.connect(MachineId('m1'))
    await manager.connect(MachineId('m2'))
    await manager.dispose()
    expect(manager.status(MachineId('m1')).state).toBe('disconnected')
    expect(manager.status(MachineId('m2')).state).toBe('disconnected')
  })

  it('marks dshMissing when the remote has no dsh binary', async () => {
    const session = new FakeSession(index => index !== 0)
    session.dshProbeResult = ''
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-dsh-missing' })
    const status = manager.status(MachineId('m1'))
    expect(status.dshMissing).toBe(true)
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toContain('dsh is not installed')
  })

  it('clears the dshMissing marker on disconnect', async () => {
    const session = new FakeSession(index => index !== 0)
    session.dshProbeResult = ''
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-dsh-missing' })
    await manager.disconnect(MachineId('m1'))
    expect(manager.status(MachineId('m1')).dshMissing).toBeUndefined()
  })
})

describe('sshManager install', () => {
  /** Wait until the published state satisfies the predicate (auto-connect races). */
  async function until(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2000
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  it('installs dsh end-to-end, copies credentials, and auto-connects', async () => {
    // Session 1 = install (installer, dsh probe, credentials copy); session 2
    // = the automatic connect (port probe refused, dsh probe, start, healthy).
    let sessions = 0
    const factory = () => {
      sessions += 1
      return new FakeSession(index => sessions === 2 && index === 3)
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      readEnvCredentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://api.example.com' }),
    })
    const result = await manager.install(MachineId('m1'))
    expect(result).toEqual({ dshPath: RESOLVED_DSH, credentialsCopied: true })
    const installSession = transport.sessions[0]!
    expect(installSession.commands[0]).toContain('git clone')
    expect(installSession.commands[0]).toContain('pnpm run build')
    expect(installSession.commands[1]).toContain('command -v dsh')
    expect(installSession.commands[2]).toContain('DEEPSEEK_API_KEY')
    expect(installSession.options[0]!.timeoutMs).toBe(60000)
    expect(typeof installSession.options[0]!.onData).toBe('function')
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect')
    expect(transport.connectCalls).toBe(2)
  })

  it('publishes the installing phase with the streaming install log', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.install(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'installing' })
    // Wait until the install command is in flight, then feed the streaming tap.
    await until(() => session.commands.length >= 1, 'install exec')
    session.options[0]?.onData?.('==> Checking dependencies\n')
    session.options[0]?.onData?.('git ... ok')
    expect(manager.status(MachineId('m1')).progress).toEqual({
      phase: 'installing',
      log: '==> Checking dependencies\ngit ... ok',
    })
    await pending
  })

  it('dedupes concurrent installs onto one attempt', async () => {
    const { manager, transport } = boot({ readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const [a, b] = await Promise.all([manager.install(MachineId('m1')), manager.install(MachineId('m1'))])
    expect(a).toEqual(b)
    // One install exec (the auto-connect session is separate).
    const installRuns = transport.sessions
      .flatMap(session => session.commands)
      .filter(command => command.includes('git clone'))
    expect(installRuns).toHaveLength(1)
  })

  it('skips the credentials copy when the local env has no key', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({}) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(session.commands.some(command => command.includes('DEEPSEEK_API_KEY'))).toBe(false)
  })

  it('keeps an existing remote key untouched', async () => {
    const session = new FakeSession(() => false)
    session.credentialsAnswer = 'existing'
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
  })

  it('reports a credentials write failure without failing the install', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'disk full' })
      : Promise.resolve({ code: 0, stdout: 'installed', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toContain('disk full')
  })

  it('fails loud with machine-install-failed when the install command fails', async () => {
    const session = new FakeSession(() => false)
    const original = session.exec.bind(session)
    session.exec = (command, options) => command.includes('git clone')
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'pnpm: not found' })
      : original(command, options)
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-install-failed',
      message: /pnpm: not found/,
    })
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.progress).toBeUndefined()
    expect(session.closed).toBe(true)
  })

  it('carries the installer output tail in a failed-install error', async () => {
    const session = new FakeSession(() => false)
    const original = session.exec.bind(session)
    session.exec = (command, options) => {
      if (command.includes('git clone')) {
        // The transport streams installer output before failing.
        options?.onData?.('==> cloning dsh source\n')
        options?.onData?.('fatal: repository not found')
        return Promise.resolve({ code: 1, stdout: '', stderr: 'clone failed' })
      }
      return original(command, options)
    }
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-install-failed',
      message: /installer output tail: ==> cloning dsh source \| fatal: repository not found/,
    })
  })

  it('fails loud with machine-connect-failed when the install connection fails', async () => {
    const { manager } = boot({ rejectKeys: true })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-connect-failed' })
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toBe('auth failed')
  })

  it('runs without an install timeout when the config omits it', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({
      sessionFactory: () => session,
      config: { ...config, installTimeoutMs: undefined as unknown as number },
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await manager.install(MachineId('m1'))
    expect(session.options[0]!.timeoutMs).toBeUndefined()
    expect(typeof session.options[0]!.onData).toBe('function')
  })

  it('falls back to the local harness .env when no credentials reader is injected', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session })
    // No readEnvCredentials injection: the manager reads the host's own
    // $DSH_HOME/.env — whatever it holds, the install still completes.
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(RESOLVED_DSH)
    expect(result.credentialsError).toBeUndefined()
  })

  it('reads the harness home from the DSH_HOME environment variable', async () => {
    const previous = process.env.DSH_HOME
    try {
      // Left branch of the ?? : DSH_HOME set.
      process.env.DSH_HOME = join(tmpdir(), 'dsh-home-custom')
      const withVar = new FakeSession(() => false)
      await boot({ sessionFactory: () => withVar }).manager.install(MachineId('m1'))
      // Right branch: DSH_HOME unset (falls back to ~/.dsh).
      delete process.env.DSH_HOME
      const withoutVar = new FakeSession(() => false)
      await boot({ sessionFactory: () => withoutVar }).manager.install(MachineId('m1'))
    }
    finally {
      if (previous === undefined)
        delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('does not publish install state once a disconnect superseded the connection', async () => {
    const { manager, emits } = boot({ rejectKeys: true })
    const pending = manager.install(MachineId('m1'))
    await manager.disconnect(MachineId('m1'))
    await expect(pending).rejects.toMatchObject({ code: 'machine-connect-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    // The install start and the disconnect both published 'disconnected';
    // the superseded attempt itself never published.
    expect(emits.map(entry => entry.state)).toEqual(['disconnected', 'disconnected'])
  })

  it('reports a non-Error credentials failure without failing the install', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers describeExecFailure's message tail
      ? Promise.reject('disk full')
      : Promise.resolve({ code: 0, stdout: 'installed', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toBe('disk full')
  })

  it('fails without publishing once a disconnect superseded an exec failure', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false, undefined, undefined, new Error('pnpm: not found'))
    session.execGate = command => command.includes('git clone') ? installGate : undefined
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('git clone'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    releaseInstall!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-install-failed', message: 'dsh install failed' })
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
  })

  it('fails loud when the install finished but no dsh binary is reachable', async () => {
    const session = new FakeSession(() => false)
    session.dshProbeResult = ''
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-install-failed',
      message: /no dsh binary is reachable/,
    })
  })

  it('clears dshMissing after a successful install and reconnects', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      const session = new FakeSession(index => sessions >= 2 && index === 3)
      // The first (failed) connect sees no dsh; the install and auto-connect do.
      if (sessions === 1)
        session.dshProbeResult = ''
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-dsh-missing' })
    expect(manager.status(MachineId('m1')).dshMissing).toBe(true)
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(RESOLVED_DSH)
    expect(manager.status(MachineId('m1')).dshMissing).toBeUndefined()
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect after install')
    // First (failed) connect + install + auto-connect.
    expect(transport.connectCalls).toBe(3)
  })

  it('does not auto-connect when a disconnect superseded the install', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const session = new FakeSession(() => false)
    session.execGate = command => command.includes('git clone') ? installGate : undefined
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('git clone'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    // Output arriving after the supersede must not touch the published log.
    session.options[0]?.onData?.('stale output')
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
    releaseInstall!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-install-failed', message: /cancelled by disconnect/ })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport.connectCalls).toBe(1)
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
  })

  it('returns the install result without connecting once a disconnect superseded the finish', async () => {
    let releaseCopy: (() => void) | undefined
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const session = new FakeSession(() => false)
    session.execGate = command => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'') ? copyGate : undefined
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await until(() => session.commands.some(command => command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')), 'credentials copy')
    await manager.disconnect(MachineId('m1'))
    releaseCopy!()
    const result = await pending
    expect(result.credentialsCopied).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(transport.connectCalls).toBe(1)
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
  })

  it('swallows a session close failure at the end of a successful install', async () => {
    const session = new FakeSession(() => false)
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(true)
    expect(result.credentialsError).toBeUndefined()
  })

  it('swallows a close failure during a failed install', async () => {
    const session = new FakeSession(() => false, undefined, undefined, new Error('pnpm: not found'))
    session.closeError = new Error('close refused')
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    expect(session.closeCalls).toBe(1)
  })

  it('swallows a failed auto-connect after a successful install', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      // The install session is fine; the automatic connect session fails auth.
      return sessions === 1
        ? new FakeSession(() => false)
        : new FakeSession(() => true, new Error('auth failed'))
    }
    const { manager, transport } = boot({ sessionFactory: factory, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(true)
    await until(() => transport.connectCalls === 2, 'auto-connect attempt')
    const status = manager.status(MachineId('m1'))
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toBe('auth failed')
  })

  it('reports a non-Error install failure in the status', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => command.includes('git clone')
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
      // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers install failure normalization
      ? Promise.reject('pnpm blew up')
      : Promise.resolve({ code: 0, stdout: '', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBe('pnpm blew up')
  })
})
