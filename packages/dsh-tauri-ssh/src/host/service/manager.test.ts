import type { MachineProfile } from '../types/index.js'
import type { RemoteInstallPlan } from './bootstrap.js'
import type { SshExecOptions, SshExecResult, SshSession, SshTransport, SshTunnelHandle } from './transport.js'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineId, SshError } from '../types/index.js'
import { SshMachineEvents } from './events.js'
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

/** A boot page whose manifest the bundle probe confirms. */
const BOOT_HTML = '<html><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>'

/** The layout entry the v2 install resolves (see {@link fakePlan}). */
const ENTRY = '$HOME/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

/** A literal linux/x64 plan (no network): the recommended pin with digest. */
function fakePlan(): RemoteInstallPlan {
  return {
    os: 'linux',
    arch: 'x64',
    matrix: { os: 'linux', arch: 'x64', dshKind: 'pkg-zip', nodeFilename: 'node-v22.22.0-linux-x64.tar.gz', dshZipName: 'deepseek-harness-pkg-linux.zip' },
    repo: 'dsh-tauri-desk/deepseek-harness-pkg',
    dshEntry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    dshVersion: '0.1.2-rc.1',
    node: {
      urls: ['https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz'],
      shasumUrls: ['https://nodejs.org/dist/v22.22.0/SHASUMS256.txt'],
      filename: 'node-v22.22.0-linux-x64.tar.gz',
      version: 'v22.22.0',
    },
    dsh: {
      kind: 'pkg-zip',
      urls: ['https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/dsh-0.1.2-rc.1-33729514615/deepseek-harness-pkg-linux.zip'],
      digest: 'sha256:6b7ecfeb',
      zipName: 'deepseek-harness-pkg-linux.zip',
      tag: 'dsh-0.1.2-rc.1-33729514615',
    },
    pnpm: { urls: ['https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz'], sha256: 'deaf'.repeat(16), version: '11.7.0' },
    notes: [],
  }
}

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
  private closedCallbacks: Array<() => void> = []

  constructor(
    public healthHealthy: (commandIndex: number) => boolean,
    public connectError?: Error,
    public startError?: Error,
    public installError?: Error,
  ) {}

  /** The uname answer the platform probe prints (default: linux x64). */
  unameResult = 'Linux 6.8.0-45-generic x86_64\n'
  /** The check-script answer: one missing component per line (default: none). */
  missingResult = ''
  /** Whether the launch answered REMOTE_NOT_INSTALLED instead of starting. */
  startNotInstalled = false

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult> {
    this.commands.push(command)
    this.options.push(options ?? {})
    const respond = (): SshExecResult => {
      if (this.connectError !== undefined)
        throw this.connectError
      if (command === 'uname -srm') {
        return { code: 0, stdout: this.unameResult, stderr: '' }
      }
      if (command.includes('echo node')) {
        return { code: 0, stdout: this.missingResult, stderr: '' }
      }
      if (command.includes('trap cleanup EXIT')) {
        // A successful script settles the missing set, like a real install.
        this.missingResult = this.installError !== undefined ? this.missingResult : ''
        if (this.installError !== undefined)
          return { code: 1, stdout: '::dsh install far', stderr: this.installError.message }
        return { code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' }
      }
      if (command.includes('test -f ')) {
        return { code: 0, stdout: 'ok\n', stderr: '' }
      }
      if (command.includes('grep -q \'^DEEPSEEK_API_KEY=\'')) {
        return { code: 0, stdout: this.credentialsAnswer, stderr: '' }
      }
      if (command.includes('dsh-remote.pid')) {
        if (this.startNotInstalled)
          return { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' }
        if (this.startError !== undefined)
          return { code: 127, stdout: '', stderr: this.startError.message }
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      const healthy = this.healthHealthy(this.commands.length - 1)
      if (command.includes('/dev/null')) {
        return healthy ? { code: 0, stdout: '200', stderr: '' } : { code: 7, stdout: '', stderr: 'refused' }
      }
      if (command.includes('curl')) {
        if (!healthy)
          return { code: 7, stdout: '', stderr: 'refused' }
        // The bundle probe (status-suffixed) answers JavaScript; the root
        // probe answers the boot page.
        return command.includes('-w')
          ? { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
          : { code: 0, stdout: BOOT_HTML, stderr: '' }
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
  const events = new SshMachineEvents()
  const plan = fakePlan()
  const manager = new SshManager({
    transport,
    knownHosts: tempKnownHosts(),
    config: overrides.config ?? config,
    events,
    planInstall: () => Promise.resolve(plan),
    ...overrides.readEnvCredentials === undefined ? {} : { readEnvCredentials: overrides.readEnvCredentials },
    emitStatus: (id, status) => {
      emits.push({ id, state: status.state, ...status.progress === undefined ? {} : { progress: status.progress } })
    },
  })
  manager.refreshProfiles(new Map([[profile.id, profile], [secondProfile.id, secondProfile]]))
  return { manager, transport, emits, events }
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
    expect(session.commands[1]).toBe('uname -srm')
    expect(session.commands[2]).toContain('echo node')
    expect(session.commands[3]).toContain('dsh-remote.pid')
    expect(session.commands[3]).toContain('--host 127.0.0.1')
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
    session.execGate = command => command.includes('dsh-remote.pid') ? startGate : undefined
    const { manager, emits } = boot({ sessionFactory: () => session })
    const pending = manager.connect(MachineId('m1'))
    // Wait until the start command is in flight, then supersede the attempt.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('dsh-remote.pid'))) {
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
    expect(result).toEqual({ ok: true, banner: 'Linux 6.8.0-45-generic x86_64' })
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

  it('marks dshMissing when the launch reports the runtime incomplete', async () => {
    const session = new FakeSession(index => index !== 0)
    session.startNotInstalled = true
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    const status = manager.status(MachineId('m1'))
    expect(status.dshMissing).toBe(true)
    expect(status.state).toBe('disconnected')
    expect(status.lastError).toContain('REMOTE_NOT_INSTALLED')
  })

  it('clears the dshMissing marker on disconnect', async () => {
    const session = new FakeSession(index => index !== 0)
    session.startNotInstalled = true
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
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
    // Session 1 = install (platform probe, missing check, install script,
    // entry check, credentials copy); session 2 = the automatic connect
    // (root probe refused, platform probe, missing check, launch, healthy).
    let sessions = 0
    const factory = () => {
      sessions += 1
      const session = new FakeSession(index => sessions === 2 && index >= 4)
      if (sessions === 1)
        session.missingResult = 'node\ndsh\npnpm\n'
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      readEnvCredentials: () => ({ apiKey: 'sk-test', baseUrl: 'https://api.example.com' }),
    })
    const result = await manager.install(MachineId('m1'))
    expect(result).toEqual({
      installed: ['node', 'dsh', 'pnpm'],
      dshRef: 'dsh-0.1.2-rc.1-33729514615',
      dshVersion: '0.1.2-rc.1',
      dshPath: ENTRY,
      credentialsCopied: true,
    })
    const installSession = transport.sessions[0]!
    expect(installSession.commands[0]).toBe('uname -srm')
    expect(installSession.commands[1]).toContain('echo node')
    expect(installSession.commands[2]).toContain('https://nodejs.org/dist/')
    expect(installSession.commands[3]).toContain('test -f')
    expect(installSession.commands[4]).toContain('DEEPSEEK_API_KEY')
    expect(installSession.options[2]!.timeoutMs).toBe(60000)
    expect(typeof installSession.options[2]!.onData).toBe('function')
    await until(() => manager.status(MachineId('m1')).state === 'connected', 'auto-connect')
    expect(transport.connectCalls).toBe(2)
  })

  it('publishes the installing phase with the streaming install log', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager } = boot({ sessionFactory: () => session })
    const pending = manager.install(MachineId('m1'))
    expect(manager.status(MachineId('m1')).progress).toEqual({ phase: 'installing' })
    // Wait until the install script is in flight, then feed the streaming tap.
    await until(() => session.commands.some(command => command.includes('trap cleanup EXIT')), 'install exec')
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    session.options[installIndex]?.onData?.('==> downloading node\n')
    session.options[installIndex]?.onData?.('::dsh verify ok')
    expect(manager.status(MachineId('m1')).progress).toEqual({
      phase: 'installing',
      log: '==> downloading node\n::dsh verify ok',
    })
    await pending
  })

  it('dedupes concurrent installs onto one attempt', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const [a, b] = await Promise.all([manager.install(MachineId('m1')), manager.install(MachineId('m1'))])
    expect(a).toEqual(b)
    // One install exec (the auto-connect reuses the same session instance,
    // so dedupe the transport's session list before counting commands).
    const installRuns = [...new Set(transport.sessions)]
      .flatMap(session => session.commands)
      .filter(command => command.includes('trap cleanup EXIT'))
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
      : Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? 'ok\n' : 'installed', stderr: '' })
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const result = await manager.install(MachineId('m1'))
    expect(result.credentialsCopied).toBe(false)
    expect(result.credentialsError).toContain('disk full')
  })

  it('fails loud with machine-install-failed when the install command fails', async () => {
    const session = new FakeSession(() => false)
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, options) => command.includes('trap cleanup EXIT')
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
    session.missingResult = 'node\n'
    const original = session.exec.bind(session)
    session.exec = (command, options) => {
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT')) {
        // The transport streams installer output before failing.
        options?.onData?.('==> downloading node\n')
        options?.onData?.('fatal: checksum mismatch')
        return Promise.resolve({ code: 11, stdout: '', stderr: 'verify failed' })
      }
      return original(command, options)
    }
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-install-failed',
      message: /installer output tail: ==> downloading node \| fatal: checksum mismatch/,
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
    session.missingResult = 'node\n'
    const { manager } = boot({
      sessionFactory: () => session,
      config: { ...config, installTimeoutMs: undefined as unknown as number },
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await manager.install(MachineId('m1'))
    const installIndex = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
    expect(session.options[installIndex]!.timeoutMs).toBeUndefined()
    expect(typeof session.options[installIndex]!.onData).toBe('function')
  })

  it('falls back to the local harness .env when no credentials reader is injected', async () => {
    const session = new FakeSession(() => false)
    const { manager } = boot({ sessionFactory: () => session })
    // No readEnvCredentials injection: the manager reads the host's own
    // $DSH_HOME/.env — whatever it holds, the install still completes.
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe(ENTRY)
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
      : Promise.resolve({ code: 0, stdout: command.includes('test -f ') ? 'ok\n' : 'installed', stderr: '' })
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
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (session.commands.some(command => command.includes('trap cleanup EXIT'))) {
          clearInterval(timer)
          resolve()
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    releaseInstall!()
    await expect(pending).rejects.toMatchObject({ code: 'machine-install-failed', message: /dsh install failed/ })
    expect(manager.status(MachineId('m1')).lastError).toBeUndefined()
    expect(manager.status(MachineId('m1')).progress).toBeUndefined()
  })

  it('fails loud when the install finished but the entry is not present', async () => {
    const session = new FakeSession(() => false)
    session.exec = (command, _options) => {
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT'))
        return Promise.resolve({ code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' })
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({
      code: 'machine-dsh-missing',
      message: /entry .* is not present/,
    })
  })

  it('clears dshMissing after a successful install and reconnects', async () => {
    let sessions = 0
    const factory = () => {
      sessions += 1
      const session = new FakeSession(index => sessions >= 2 && index >= 4)
      // The first (failed) connect finds the runtime incomplete; the install
      // and the auto-connect see it whole.
      if (sessions === 1)
        session.startNotInstalled = true
      return session
    }
    const { manager, transport } = boot({
      sessionFactory: factory,
      readEnvCredentials: () => ({ apiKey: 'sk-test' }),
    })
    await expect(manager.connect(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-bootstrap-failed' })
    expect(manager.status(MachineId('m1')).dshMissing).toBe(true)
    const result = await manager.install(MachineId('m1'))
    expect(result.dshPath).toBe('$HOME/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
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
    session.missingResult = 'node\n'
    session.execGate = command => command.includes('trap cleanup EXIT') ? installGate : undefined
    const { manager, transport } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    const pending = manager.install(MachineId('m1'))
    const installIndex = await new Promise<number>((resolve) => {
      const timer = setInterval(() => {
        const index = session.commands.findIndex(command => command.includes('trap cleanup EXIT'))
        if (index >= 0) {
          clearInterval(timer)
          resolve(index)
        }
      }, 1)
    })
    await manager.disconnect(MachineId('m1'))
    // Output arriving after the supersede must not touch the published log.
    session.options[installIndex]?.onData?.('stale output')
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
    session.missingResult = 'node\n'
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
    session.missingResult = 'node\n'
    session.exec = (command, _options) => {
      if (command.includes('echo node'))
        return Promise.resolve({ code: 0, stdout: 'node\n', stderr: '' })
      if (command.includes('trap cleanup EXIT'))
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile rejection
        // eslint-disable-next-line prefer-promise-reject-errors -- deliberately non-Error: covers install failure normalization
        return Promise.reject('pnpm blew up')
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    const { manager } = boot({ sessionFactory: () => session, readEnvCredentials: () => ({ apiKey: 'sk-test' }) })
    await expect(manager.install(MachineId('m1'))).rejects.toMatchObject({ code: 'machine-install-failed' })
    expect(manager.status(MachineId('m1')).lastError).toBe('pnpm blew up')
  })
})
