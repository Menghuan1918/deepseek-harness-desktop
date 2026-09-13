import type { AddressInfo } from 'node:net'
import type { MachineProfile } from '../types/index'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Server, connect as tcpConnect } from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index'
import { classifyConnectFailure, describeConnectFailure, loginShell, shQuote, Ssh2Transport } from './transport'

const profile: MachineProfile = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  password: 'sekrit',
  remotePort: 3080,
}

/** The profile minus its stored password (exactOptionalPropertyTypes-safe). */
function withoutPassword(profile: MachineProfile): MachineProfile {
  const { password: _password, ...rest } = profile
  return rest
}

/** A credential resolver double: password rides the profile, keys come from the plan. */
class StubResolver {
  constructor(private readonly plan: {
    host?: string
    port?: number
    username?: string
    keys?: Array<{ privateKey: string, passphrase?: string }>
  } = {}) {}

  async resolve(input: MachineProfile): Promise<{
    host: string
    port: number
    username: string
    password?: string
    keys: Array<{ privateKey: string, passphrase?: string }>
  }> {
    const password = input.password === undefined || input.password === '' ? undefined : input.password
    return {
      host: this.plan.host ?? input.host,
      port: this.plan.port ?? input.port,
      username: this.plan.username ?? input.user,
      keys: this.plan.keys ?? [],
      ...password === undefined ? {} : { password },
    }
  }
}

type HostVerifier = (key: Buffer, verify: (valid: boolean) => void) => void

/** Transport options with the agent step disabled — deterministic chains. */
const noAgent = { keepaliveIntervalMs: 10_000, keepaliveCountMax: 3, agentSocket: '' }

class FakeClient extends EventEmitter {
  connectConfig: Record<string, unknown> | undefined
  hostKeyAccepted: boolean | undefined
  ended = false
  execError: Error | undefined
  forwardError: Error | undefined
  /** When true, an opened exec stream never emits close (a hung command). */
  execHang = false
  /** When set, the exec stream emits this error instead of data/close. */
  streamError: Error | undefined
  /** The auth descriptor the fake server "accepted" (null = auth rejected). */
  acceptedAuth: unknown

  constructor(
    private readonly mode: 'ready' | 'error',
    private readonly errorMessage: string,
  ) {
    super()
  }

  connect(config: Record<string, unknown>): this {
    this.connectConfig = config
    const hostVerifier = config.hostVerifier as HostVerifier | undefined
    const authHandler = config.authHandler as AuthHandler | undefined
    const finish = (): void => {
      if (this.mode === 'error') {
        const emitError = (): void => queueMicrotask(() => this.emit('error', new Error(this.errorMessage)))
        // A real server drives the auth chain before declaring failure, so
        // the transport's passwordOffered bookkeeping is set by the time the
        // error lands; the fake mirrors that.
        if (authHandler === undefined) {
          emitError()
          return
        }
        authHandler(null, false, () => emitError())
      }
      else if (authHandler === undefined) {
        queueMicrotask(() => this.emit('ready'))
      }
      else {
        // A real server drives the auth chain itself; the fake accepts the
        // first offered descriptor (or stores null when the chain gives up)
        // and only then reports ready.
        authHandler(null, false, (descriptor) => {
          this.acceptedAuth = descriptor
          queueMicrotask(() => this.emit('ready'))
        })
      }
    }
    if (hostVerifier === undefined) {
      finish()
    }
    else {
      hostVerifier(Buffer.from('host-key-bytes'), (valid) => {
        this.hostKeyAccepted = valid
        finish()
      })
    }
    return this
  }

  exec(_command: string, callback: (error: Error | undefined, stream?: unknown) => void): this {
    queueMicrotask(() => {
      if (this.execError !== undefined) {
        callback(this.execError)
        return
      }
      const stream = new EventEmitter() as EventEmitter & { exitCode?: number | null }
      this.lastStream = stream
      callback(undefined, stream)
      if (this.execHang)
        return
      if (this.streamError !== undefined) {
        queueMicrotask(() => {
          stream.emit('error', this.streamError)
          stream.emit('close', null)
        })
        return
      }
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('hello'))
        stream.emit('stderr', Buffer.from('oops'))
        stream.emit('close', 0)
      })
    })
    return this
  }

  /** The most recent exec stream (so end() can close it like a real channel). */
  lastStream: EventEmitter | undefined

  forwardOut(
    _srcIP: string,
    _srcPort: number,
    _dstIP: string,
    _dstPort: number,
    callback: (error: Error | undefined, channel?: unknown) => void,
  ): this {
    queueMicrotask(() => {
      if (this.forwardError !== undefined) {
        callback(this.forwardError)
        return
      }
      callback(undefined, new PassThrough())
    })
    return this
  }

  end(): void {
    this.ended = true
    // A real connection close settles the open channel too.
    if (this.lastStream !== undefined)
      this.lastStream.emit('close', null)
    this.emit('close')
  }
}

const { fakeClientFactory, fakeClientInstances } = vi.hoisted(() => {
  const instances: FakeClient[] = []
  function fakeClientFactory(mode: 'ready' | 'error', message: string): FakeClient {
    const client = new FakeClient(mode, message)
    instances.push(client)
    return client
  }
  return {
    fakeClientFactory,
    fakeClientInstances: instances,
  }
})

vi.mock('ssh2', () => {
  return {
    Client: vi.fn(fakeClientFactory),
  }
})

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

function lastClient(): FakeClient {
  const client = fakeClientInstances[fakeClientInstances.length - 1]
  if (client === undefined)
    throw new Error('no fake client created')
  return client
}

type AuthHandler = (methodsLeft: unknown, partialSuccess: boolean, callback: (value: unknown) => void) => void

/** The authHandler the transport installed on the last fake client. */
function authHandlerOf(client: FakeClient): AuthHandler {
  const handler = client.connectConfig?.authHandler
  if (typeof handler !== 'function')
    throw new Error('no authHandler in connect config')
  return handler as AuthHandler
}

/** Build a constructable once-implementation for the mocked Client (arrows cannot be `new`-ed). */
function errorClientOnce(message: string): () => FakeClient {
  return function () {
    return fakeClientFactory('error', message)
  }
}

/** Drive one authHandler round and return what it asks for next. */
function nextAuth(handler: AuthHandler): Promise<unknown> {
  return new Promise(resolve => handler(null, false, resolve))
}

describe('shQuote / loginShell', () => {
  it('wraps commands in a login-shell sh -c', () => {
    expect(loginShell('echo hi')).toBe('sh -lc \'echo hi\'')
  })

  it('escapes embedded single quotes', () => {
    expect(shQuote('it\'s')).toBe(`'it'\\''s'`)
    expect(loginShell('echo it\'s')).toBe('sh -lc \'echo it\'\\\'\'s\'')
  })
})

describe('ssh2Transport', () => {
  it('connects with password auth and resolves on ready', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    const session = await transport.connect(profile, () => true)
    expect(session).toBeDefined()
    const client = lastClient()
    expect(client.connectConfig).toMatchObject({
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      readyTimeout: 15000,
    })
    expect(client.hostKeyAccepted).toBe(true)
    await session.close()
    expect(client.ended).toBe(true)
  })

  it('tries the ssh-agent first, then keys, then the stored password, then gives up', async () => {
    const resolver = new StubResolver({
      keys: [{ privateKey: 'KEY-A' }],
    })
    const transport = new Ssh2Transport(15000, resolver, { ...noAgent, agentSocket: '/tmp/agent.sock' })
    const session = await transport.connect(profile, () => true)
    const client = lastClient()
    const handler = authHandlerOf(client)
    // The fake server accepted the first offer (the agent); the rest of the
    // chain is what ssh2 would try next had it been refused.
    expect(client.acceptedAuth).toEqual({ type: 'agent', username: 'root', agent: '/tmp/agent.sock' })
    expect(await nextAuth(handler)).toEqual({ type: 'publickey', username: 'root', key: 'KEY-A' })
    expect(await nextAuth(handler)).toEqual({ type: 'password', username: 'root', password: 'sekrit' })
    expect(await nextAuth(handler)).toBe(false)
    await session.close()
  })

  it('tries the resolved keys first, then the stored password, then gives up', async () => {
    const resolver = new StubResolver({
      keys: [{ privateKey: 'KEY-A' }, { privateKey: 'KEY-B', passphrase: 'PASS' }],
    })
    const transport = new Ssh2Transport(15000, resolver, noAgent)
    const session = await transport.connect(profile, () => true)
    const client = lastClient()
    const handler = authHandlerOf(client)
    expect(client.acceptedAuth).toEqual({ type: 'publickey', username: 'root', key: 'KEY-A' })
    expect(await nextAuth(handler)).toEqual({ type: 'publickey', username: 'root', key: 'KEY-B', passphrase: 'PASS' })
    expect(await nextAuth(handler)).toEqual({ type: 'password', username: 'root', password: 'sekrit' })
    expect(await nextAuth(handler)).toBe(false)
    await session.close()
  })

  it('tries only keys when no password is stored', async () => {
    const resolver = new StubResolver({ keys: [{ privateKey: 'KEY', passphrase: 'PASS' }] })
    const transport = new Ssh2Transport(15000, resolver, noAgent)
    const session = await transport.connect(withoutPassword(profile), () => true)
    const client = lastClient()
    const handler = authHandlerOf(client)
    expect(client.acceptedAuth).toEqual({ type: 'publickey', username: 'root', key: 'KEY', passphrase: 'PASS' })
    expect(await nextAuth(handler)).toBe(false)
    await session.close()
  })

  it('gives up immediately when nothing resolves', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    const session = await transport.connect(withoutPassword(profile), () => true)
    expect(lastClient().acceptedAuth).toBe(false)
    await session.close()
  })

  it('reads SSH_AUTH_SOCK when no agent socket is injected', async () => {
    const previous = process.env.SSH_AUTH_SOCK
    try {
      process.env.SSH_AUTH_SOCK = '/tmp/from-env.sock'
      const transport = new Ssh2Transport(15000, new StubResolver(), { keepaliveIntervalMs: 10_000, keepaliveCountMax: 3 })
      const session = await transport.connect(profile, () => true)
      expect(lastClient().acceptedAuth).toEqual({ type: 'agent', username: 'root', agent: '/tmp/from-env.sock' })
      await session.close()
    }
    finally {
      if (previous === undefined)
        delete process.env.SSH_AUTH_SOCK
      else
        process.env.SSH_AUTH_SOCK = previous
    }
  })

  it('configures the keepalive watchdog from the injected options', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver(), { keepaliveIntervalMs: 25_000, keepaliveCountMax: 7, agentSocket: '' })
    const session = await transport.connect(profile, () => true)
    expect(lastClient().connectConfig).toMatchObject({ keepaliveInterval: 25_000, keepaliveCountMax: 7 })
    await session.close()
  })

  it('defaults the keepalive watchdog to 10 s and 3 missed beats', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver(), { agentSocket: '' })
    const session = await transport.connect(profile, () => true)
    expect(lastClient().connectConfig).toMatchObject({ keepaliveInterval: 10_000, keepaliveCountMax: 3 })
    await session.close()
  })

  it('reports the winning auth method on the session', async () => {
    const resolver = new StubResolver({ keys: [{ privateKey: 'KEY-A' }] })
    const transport = new Ssh2Transport(15000, resolver, { ...noAgent, agentSocket: '/tmp/agent.sock' })
    const session = await transport.connect(profile, () => true)
    // The fake server accepted the agent offer, so the session reports it.
    expect(lastClient().acceptedAuth).toMatchObject({ type: 'agent' })
    expect(session.authMethod).toBe('agent')
    await session.close()
  })

  it('connects to the resolver-resolved host, port, and user', async () => {
    const resolver = new StubResolver({ host: '10.0.0.9', port: 2222, username: 'deploy' })
    const transport = new Ssh2Transport(15000, resolver)
    const session = await transport.connect(profile, () => true)
    expect(lastClient().connectConfig).toMatchObject({ host: '10.0.0.9', port: 2222, username: 'deploy' })
    await session.close()
  })

  it('rejects when the resolver fails', async () => {
    const failing = {
      async resolve() {
        throw new Error('config read failed')
      },
    }
    const transport = new Ssh2Transport(15000, failing as never)
    await expect(transport.connect(profile, () => true)).rejects.toThrow('config read failed')
  })

  it('rejects on transport errors', async () => {
    const { Client } = await import('ssh2')
    vi.mocked(Client).mockImplementationOnce(errorClientOnce('ECONNREFUSED'))
    const transport = new Ssh2Transport(15000, new StubResolver())
    await expect(transport.connect(profile, () => true)).rejects.toThrow('ECONNREFUSED')
  })

  it('rejects when already aborted', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const controller = new AbortController()
    controller.abort()
    await expect(transport.connect(profile, () => true, controller.signal)).rejects.toThrow()
  })

  it('aborts an in-flight handshake', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const controller = new AbortController()
    const pending = transport.connect(profile, () => true, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('propagates a string abort reason', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(transport.connect(profile, () => true, controller.signal)).rejects.toThrow('caller gave up')
  })

  it('propagates an arbitrary abort reason', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const controller = new AbortController()
    controller.abort({ code: 'custom' })
    await expect(transport.connect(profile, () => true, controller.signal)).rejects.toThrow('This operation was aborted')
  })

  it('accepts a synchronous verifier verdict', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => false)
    expect(lastClient().hostKeyAccepted).toBe(false)
    await session.close()
  })

  it('accepts an asynchronous verifier verdict through the callback', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, async () => true)
    expect(lastClient().hostKeyAccepted).toBe(true)
    await session.close()
  })

  it('rejects when an asynchronous verifier fails', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, async () => {
      throw new Error('verifier blew up')
    })
    expect(lastClient().hostKeyAccepted).toBe(false)
    await session.close()
  })

  it('collects exec output and exit code', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const result = await session.exec('uname -srm')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.stderr).toBe('oops')
    await session.close()
  })

  it('rejects exec when the channel cannot open', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().execError = new Error('channel open failure')
    await expect(session.exec('x')).rejects.toThrow('channel open failure')
    await session.close()
  })

  it('rejects exec with a deadline even when the channel cannot open', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().execError = new Error('channel open failure')
    await expect(session.exec('x', { timeoutMs: 1000 })).rejects.toThrow('channel open failure')
    await session.close()
  })

  it('clears the deadline when a command finishes normally', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const result = await session.exec('x', { timeoutMs: 1000 })
    expect(result.code).toBe(0)
    await session.close()
  })

  it('rejects exec when the stream itself errors', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().streamError = new Error('stream reset')
    await expect(session.exec('x')).rejects.toThrow('stream reset')
    await session.close()
  })

  it('rejects exec on a stream error with a deadline pending', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().streamError = new Error('stream reset')
    await expect(session.exec('x', { timeoutMs: 1000 })).rejects.toThrow('stream reset')
    await session.close()
  })

  it('streams stdout through the onData tap', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const chunks: string[] = []
    const result = await session.exec('x', { onData: chunk => chunks.push(chunk) })
    expect(chunks).toEqual(['hello'])
    expect(result.stdout).toBe('hello')
    await session.close()
  })

  it('times out a hung command and closes the connection', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().execHang = true
    await expect(session.exec('slow', { timeoutMs: 10 })).rejects.toThrow(/timed out after 10 ms/)
    expect(lastClient().ended).toBe(true)
  })

  it('forwards the remote port to a loopback listener', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080)
    expect(tunnel.localPort).toBeGreaterThan(0)
    await tunnel.close()
    await session.close()
  })

  it('pipes real socket traffic through the tunnel', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080)
    const socket = tcpConnect(tunnel.localPort, '127.0.0.1')
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    socket.write('ping')
    socket.end()
    socket.resume()
    await new Promise<void>(resolve => socket.once('close', () => resolve()))
    await tunnel.close()
    await session.close()
  })

  it('destroys open sockets when the tunnel closes', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080)
    const socket = tcpConnect(tunnel.localPort, '127.0.0.1')
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    await new Promise(resolve => setTimeout(resolve, 20))
    await tunnel.close()
    await new Promise<void>(resolve => socket.once('close', () => resolve()))
    await session.close()
  })

  it('destroys the client socket when the tunnel channel fails', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080)
    lastClient().forwardError = new Error('tunnel closed')
    const socket = tcpConnect(tunnel.localPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    await new Promise<void>(resolve => socket.once('close', () => resolve()))
    await tunnel.close()
    await session.close()
  })

  it('rejects the tunnel when the local listener fails to bind', async () => {
    const net = await import('node:net')
    vi.mocked(net.createServer).mockImplementationOnce(() => {
      const server = new Server()
      queueMicrotask(() => server.emit('error', new Error('EADDRINUSE')))
      return server
    })
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    await expect(session.openTunnel(3080)).rejects.toThrow('EADDRINUSE')
    await session.close()
  })

  it('fires the closed callback once when the connection drops', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    const callback = vi.fn()
    session.onClosed(callback)
    lastClient().emit('close')
    expect(callback).toHaveBeenCalledTimes(1)
    lastClient().emit('close')
    expect(callback).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it('fires the closed callback immediately for an already-closed session', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    const session = await transport.connect(profile, () => true)
    lastClient().emit('close')
    const callback = vi.fn()
    session.onClosed(callback)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('rebinds the preferred local port for a reconnect-stable tunnel URL', async () => {
    // Reserve a port, then release it: the tunnel must bind exactly it.
    const holder = new Server()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', () => resolve()))
    const freePort = (holder.address() as AddressInfo).port
    await new Promise<void>(resolve => holder.close(() => resolve()))
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080, freePort)
    expect(tunnel.localPort).toBe(freePort)
    await tunnel.close()
    await session.close()
  })

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    // Keep a listener on the port so the preferred bind fails.
    const holder = new Server()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', () => resolve()))
    const takenPort = (holder.address() as AddressInfo).port
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    const session = await transport.connect(profile, () => true)
    const tunnel = await session.openTunnel(3080, takenPort)
    expect(tunnel.localPort).not.toBe(takenPort)
    expect(tunnel.localPort).toBeGreaterThan(0)
    await tunnel.close()
    await session.close()
    await new Promise<void>(resolve => holder.close(() => resolve()))
  })
})

describe('classifyConnectFailure', () => {
  it('classifies network-level failures as unreachable', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      const error = Object.assign(new Error(`connect ${code} 10.0.0.1:22`), { code })
      expect(classifyConnectFailure(error, false)).toBe('unreachable')
      expect(classifyConnectFailure(error, true)).toBe('unreachable')
    }
    expect(classifyConnectFailure(new Error('Timed out while waiting for handshake'), false)).toBe('unreachable')
    expect(classifyConnectFailure(new Error('Connection closed prematurely'), true)).not.toBe('unreachable')
  })

  it('splits exhausted auth into key-rejected and password-rejected', () => {
    const error = new Error('All configured authentication methods failed')
    expect(classifyConnectFailure(error, false)).toBe('key-rejected')
    expect(classifyConnectFailure(error, true)).toBe('password-rejected')
  })

  it('leaves everything else as other', () => {
    expect(classifyConnectFailure(new Error('Host key verification failed'), false)).toBe('other')
    expect(classifyConnectFailure('plain string', true)).toBe('other')
  })
})

describe('describeConnectFailure', () => {
  it('gives each class an operator-distinct, actionable message', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' })
    const messages = [
      describeConnectFailure('key-rejected', new Error('All configured authentication methods failed')),
      describeConnectFailure('password-rejected', new Error('All configured authentication methods failed')),
      describeConnectFailure('unreachable', refused),
    ]
    expect(new Set(messages).size).toBe(3)
    expect(messages[0]).toContain('check your keys or store a password')
    expect(messages[1]).toContain('update the stored password')
    expect(messages[2]).toContain('host unreachable')
    expect(messages[2]).toContain('ECONNREFUSED')
  })

  it('wraps transport failures with the classified message', async () => {
    const { Client } = await import('ssh2')
    vi.mocked(Client).mockImplementationOnce(errorClientOnce('connect ECONNREFUSED 127.0.0.1:1'))
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    await expect(transport.connect(profile, () => true)).rejects.toThrow(/host unreachable: .*ECONNREFUSED/)
  })

  it('keeps the auth-failure message distinguishable when the chain exhausts', async () => {
    const { Client } = await import('ssh2')
    vi.mocked(Client).mockImplementationOnce(errorClientOnce('All configured authentication methods failed'))
    const transport = new Ssh2Transport(15000, new StubResolver(), noAgent)
    // With a stored password in the chain the message points at the password.
    await expect(transport.connect(profile, () => true)).rejects.toThrow(/stored password was rejected/)
    vi.mocked(Client).mockImplementationOnce(errorClientOnce('All configured authentication methods failed'))
    // Without one it points at the keys/agent.
    await expect(transport.connect(withoutPassword(profile), () => true)).rejects.toThrow(/no key or ssh-agent was accepted/)
  })
})
