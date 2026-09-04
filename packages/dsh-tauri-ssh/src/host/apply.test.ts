import type z from 'schemastery'
import type { Config as SshRemoteConfig } from './storage/index.js'
import type { SshHostContext } from './types/index.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name, SshRemoteService } from './apply.js'
import { MACHINES_NAMESPACE } from './storage/index.js'
import { MachineId } from './types/index.js'

/** Scripted settings scope double. */
function scriptedSettings() {
  const doc: Record<string, unknown> = {}
  let lastNs = ''
  const watchers: Array<(next: unknown, prev: unknown) => void> = []
  const update = vi.fn(async (patch: Record<string, unknown>) => {
    doc[lastNs] = deepMerge((doc[lastNs] as Record<string, unknown> | undefined) ?? {}, patch)
    for (const watcher of watchers) watcher(doc, {})
  })
  const replace = vi.fn(async (section: Record<string, unknown>) => {
    doc[lastNs] = section
    for (const watcher of watchers) watcher(doc, {})
  })
  return {
    doc,
    update,
    replace,
    register: vi.fn((ns: string, _schema: z<unknown>, options?: { base?: unknown }) => {
      lastNs = ns
      const base = options?.base ?? {}
      const resolved = (): unknown => ({ ...(base as object), ...(doc[ns] as object | undefined) })
      return {
        get: () => resolved(),
        watch: (callback: (next: unknown, prev: unknown) => void) => {
          watchers.push(callback)
          return () => {}
        },
        update,
        replace,
      }
    }),
    set(ns: string, section: Record<string, unknown>): void {
      doc[ns] = section
      for (const watcher of watchers) watcher(doc, {})
    },
  }
}

/** Plain-object deep merge used by the scripted settings scope. */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof next[key] === 'object' && next[key] !== null && !Array.isArray(next[key])) {
      next[key] = deepMerge(next[key] as Record<string, unknown>, value as Record<string, unknown>)
    }
    else {
      next[key] = value
    }
  }
  return next
}

function scriptedHttpServer() {
  const routes: Array<{ kind: string, path: string, handler?: unknown }> = []
  return {
    routes,
    register: vi.fn((route: { kind: string, path: string, handler?: unknown }) => {
      routes.push(route)
      return () => {}
    }),
  }
}

/** Plugin config without the optional overrides; defaults are exercised separately. */
const baseConfig: SshRemoteConfig = {
  connectTimeoutMs: 15000,
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
  keepaliveIntervalMs: 10000,
  keepaliveCountMax: 3,
  reconnectInitialDelayMs: 1,
  reconnectMaxDelayMs: 2,
  reconnectMaxAttempts: 2,
}

// Every service construction points the credential/discovery layer at a
// scratch ssh directory — the developer's real ~/.ssh is never read.
let sshDir: string

beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), 'ssh-index-'))
})

afterEach(() => {
  rmSync(sshDir, { recursive: true, force: true })
})

/** One scripted context: cordis-shaped surface without real cordis types. */
function scriptedCtx(settings: unknown, webServer: unknown): { ctx: SshHostContext, disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    provide: vi.fn(),
    effect: vi.fn((callback: () => (() => void) | void) => {
      const disposer = callback()
      if (typeof disposer === 'function')
        disposers.push(disposer)
    }),
    settings,
    webServer,
  } as unknown as SshHostContext
  return { ctx, disposers }
}

/** Construct the service on scripted settings/webServer doubles. */
function construct(config: SshRemoteConfig = baseConfig): { ctx: SshHostContext, service: SshRemoteService, disposers: Array<() => void> } {
  const { ctx, disposers } = scriptedCtx(scriptedSettings(), scriptedHttpServer())
  return { ctx, service: new SshRemoteService(ctx, { ...config, sshDir }), disposers }
}

function boot(overrides: {
  settings?: ReturnType<typeof scriptedSettings>
  webServer?: ReturnType<typeof scriptedHttpServer>
  config?: Partial<SshRemoteConfig>
} = {}) {
  const settings = overrides.settings ?? scriptedSettings()
  const webServer = overrides.webServer ?? scriptedHttpServer()
  const { ctx } = scriptedCtx(settings, webServer)
  const config = {
    ...baseConfig,
    knownHostsPath: join(homedir(), '.dsh', 'ssh', 'known-hosts.json'),
    sshDir,
    ...overrides.config,
  }
  const service = new SshRemoteService(ctx, config)
  return { ctx, settings, webServer, service }
}

function machine(id: string): Record<string, unknown> {
  return {
    id,
    name: `machine-${id}`,
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    password: 'sekrit',
    remotePort: 3080,
  }
}

describe('ssh-remote plugin', () => {
  it('declares its plugin metadata', () => {
    expect(name).toBe('dsh-tauri-ssh')
    expect(inject).toEqual(['settings', 'webServer'])
    expect(apply).toEqual(expect.any(Function))
  })

  it('ships the cordis plugin descriptor as the default export', async () => {
    const descriptor = (await import('./apply.js')).default
    expect(descriptor).toMatchObject({
      name: 'dsh-tauri-ssh',
      inject: ['settings', 'webServer'],
      Config: expect.anything(),
    })
    expect(descriptor.apply).toEqual(expect.any(Function))
    // The loader reads Config/inject from the default object: a bare function
    // default would lose both (config defaults never apply, services not injected).
    expect(descriptor.apply).toBe(apply)
  })

  it('registers the namespace and mounts the /api-ssh route', () => {
    const { settings, webServer } = boot()
    expect(settings.register).toHaveBeenCalledWith(String(MACHINES_NAMESPACE), expect.anything(), { base: { machines: {} } })
    expect(webServer.routes).toMatchObject([{ kind: 'prefix', path: '/api-ssh' }])
    expect(webServer.routes[0]?.handler).toEqual(expect.any(Function))
  })

  it('loads machine profiles from the settings namespace', () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a') } })
    const { service } = boot({ settings })
    const views = service.profileViews()
    expect(views.map(view => view.id)).toEqual(['a'])
    expect(views[0]).toMatchObject({ name: 'machine-a', hasPassword: true })
    expect(views[0]).not.toHaveProperty('password')
  })

  it('refreshes the manager when the namespace changes', () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a'), b: machine('b') } })
    const { service } = boot({ settings })
    expect(service.profileViews()).toHaveLength(2)
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a') } })
    expect(service.profileViews().map(view => view.id)).toEqual(['a'])
  })

  it('rejects a dict key that disagrees with the profile id', () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { b: machine('a') } })
    expect(() => boot({ settings })).toThrow(/dict key must equal the profile id/)
  })

  it('exposes the manager connection plane', async () => {
    const { service } = boot()
    expect(service.status('ghost' as never)).toEqual({ machineId: 'ghost' as never, state: 'disconnected' })
    expect(service.profileViews()).toEqual([])
    await service.disconnect('a' as never)
  })

  it('forwards installs to the manager', async () => {
    const { service } = boot()
    const install = vi.spyOn(service.manager, 'install')
      .mockResolvedValue({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true })
    const result = await service.install(MachineId('a'))
    expect(install).toHaveBeenCalledWith(MachineId('a'), undefined)
    expect(result).toEqual({ installed: ['node'], dshRef: 'dsh-0.1.2-rc.1-1', dshVersion: '0.1.2-rc.1', dshPath: '/root/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', credentialsCopied: true })
  })

  it('saves a machine through the settings scope and refreshes the manager', async () => {
    const { service, settings } = boot()
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    }, { password: 'sekrit', passphrase: 'PHRASE' })
    expect(settings.update).toHaveBeenCalledWith({
      machines: {
        a: {
          id: 'a',
          name: 'alpha',
          host: '10.0.0.1',
          port: 22,
          user: 'root',
          remotePort: 3080,
          password: 'sekrit',
          passphrase: 'PHRASE',
        },
      },
    })
    const views = service.profileViews()
    expect(views.map(view => view.id)).toEqual(['a'])
    expect(views[0]).toMatchObject({ name: 'alpha', hasPassword: true })
  })

  it('keeps stored secrets on save unless rewritten', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a') } })
    const { service } = boot({ settings })
    await service.save('a' as never, {
      name: 'alpha-2',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({ name: 'alpha-2', hasPassword: true })
  })

  it('keeps stored secrets on save and stores the start command', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), {
      machines: { a: { ...machine('a'), passphrase: 'OLD-PHRASE' } },
    })
    const { service } = boot({ settings })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
      startCommand: 'dsh web --port 3080',
    }, { passphrase: 'NEW-PHRASE' })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({
      name: 'alpha',
      hasPassword: true,
      hasPassphrase: true,
      startCommand: 'dsh web --port 3080',
    })
  })

  it('keeps whichever stored secrets exist and rewrites only typed ones', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), {
      machines: { a: { ...machine('a'), password: undefined, passphrase: 'OLD-PHRASE' } },
    })
    const { service } = boot({ settings })
    await service.save('a' as never, {
      name: 'alpha',
      host: '10.0.0.1',
      port: 22,
      user: 'root',
      remotePort: 3080,
    }, { password: 'NEW-PW' })
    const views = service.profileViews()
    expect(views[0]).toMatchObject({ name: 'alpha', hasPassword: true, hasPassphrase: true })
    const stored = settings.doc[String(MACHINES_NAMESPACE)] as { machines: Record<string, Record<string, unknown>> }
    expect(stored.machines.a?.password).toBe('NEW-PW')
    expect(stored.machines.a?.passphrase).toBe('OLD-PHRASE')
  })

  it('discovers ~/.ssh/config aliases as read-only machines', async () => {
    writeFileSync(join(sshDir, 'config'), [
      'Host dev',
      '  HostName 10.0.0.9',
      '  User root',
      '  Port 2222',
      'Host ci',
      '  IdentityFile ~/.ssh/special',
      'Host *.example.com',
      'Host !banned',
    ].join('\n'))
    const { service } = boot()
    const views = await service.discoveredViews()
    expect(views.map(view => view.id)).toEqual(['ci', 'dev'])
    expect(views[1]).toMatchObject({
      id: 'dev',
      name: 'dev',
      host: 'dev',
      port: 2222,
      user: 'root',
      hasPassword: false,
      hasPassphrase: false,
      remotePort: 3080,
    })
    expect(service.profileViews()).toEqual([])
  })

  it('lists no discovered machines without a config file', async () => {
    const { service } = boot()
    expect(await service.discoveredViews()).toEqual([])
  })

  it('lets a manual machine shadow a config alias', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n')
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { dev: { ...machine('dev'), host: '10.1.1.1' } } })
    const { service } = boot({ settings })
    expect((await service.discoveredViews()).map(view => view.id)).toEqual([])
    expect(service.profileViews().map(view => view.id)).toEqual(['dev'])
  })

  it('syncs discovered aliases into the manager profile map', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n  Port 2222\n')
    const { service } = boot()
    await service.disconnect(MachineId('dev'))
    const views = service.manager.profileViews()
    expect(views.map(view => view.id)).toEqual(['dev'])
    expect(views[0]).toMatchObject({ host: 'dev', port: 2222, user: 'root' })
  })

  it('applies the configured remote port and start command template to discovered aliases', async () => {
    writeFileSync(join(sshDir, 'config'), 'Host dev\n  User root\n')
    const { service } = boot({ config: { remotePort: 3199, startCommand: '$HOME/.local/bin/dsh web --host 127.0.0.1 --port {port}' } })
    const views = await service.discoveredViews()
    expect(views[0]).toMatchObject({ id: 'dev', remotePort: 3199, startCommand: '$HOME/.local/bin/dsh web --host 127.0.0.1 --port 3199' })
  })

  it('applies the configured default start command to manual machines without their own', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a') } })
    const { service } = boot({ settings, config: { remotePort: 3080, startCommand: 'dsh web --port {port}' } })
    await service.disconnect('a' as never)
    const views = service.manager.profileViews()
    expect(views[0]).toMatchObject({ id: 'a', startCommand: 'dsh web --port 3080' })
  })

  it('keeps a manual start command over the configured default', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), {
      machines: { a: { ...machine('a'), startCommand: 'custom dsh web' } },
    })
    const { service } = boot({ settings, config: { remotePort: 3080, startCommand: 'dsh web --port {port}' } })
    await service.disconnect('a' as never)
    const views = service.manager.profileViews()
    expect(views[0]).toMatchObject({ id: 'a', startCommand: 'custom dsh web' })
  })

  it('removes a machine through the settings scope', async () => {
    const settings = scriptedSettings()
    settings.set(String(MACHINES_NAMESPACE), { machines: { a: machine('a'), b: machine('b') } })
    const { service } = boot({ settings })
    await service.remove('a' as never)
    expect(service.profileViews().map(view => view.id)).toEqual(['b'])
  })

  it('delegates test and connect to the manager', async () => {
    const { service } = boot()
    await expect(service.test('ghost' as never)).rejects.toMatchObject({ code: 'machine-not-found' })
    await expect(service.connect('ghost' as never)).rejects.toMatchObject({ code: 'machine-not-found' })
  })

  it('defaults the known-hosts path from DSH_HOME or the home directory', () => {
    const previous = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/tmp/dsh-home'
      expect(construct().service).toBeInstanceOf(SshRemoteService)
      delete process.env.DSH_HOME
      expect(construct().service).toBeInstanceOf(SshRemoteService)
    }
    finally {
      if (previous === undefined)
        delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('disposes the manager when the context tears down', () => {
    const { service, disposers } = construct()
    const dispose = vi.spyOn(service.manager, 'dispose').mockResolvedValue(undefined)
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('apply constructs the service', () => {
    const { ctx } = construct()
    expect(apply(ctx, baseConfig)).toBeInstanceOf(SshRemoteService)
  })
})
