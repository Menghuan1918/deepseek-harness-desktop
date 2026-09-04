import type { MachineProfile } from '../types/index.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Server, connect as tcpConnect } from 'node:net'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MachineId } from '../types/index.js'
import { loginShell, shQuote, Ssh2Transport } from './transport.js'

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

  constructor(
    private readonly mode: 'ready' | 'error',
    private readonly errorMessage: string,
  ) {
    super()
  }

  connect(config: Record<string, unknown>): this {
    this.connectConfig = config
    const hostVerifier = config.hostVerifier as HostVerifier | undefined
    const finish = (): void => {
      if (this.mode === 'error') {
        queueMicrotask(() => this.emit('error', new Error(this.errorMessage)))
      }
      else {
        queueMicrotask(() => this.emit('ready'))
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
    const transport = new Ssh2Transport(15000, new StubResolver())
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

  it('tries the resolved keys first, then the stored password, then gives up', async () => {
    const resolver = new StubResolver({
      keys: [{ privateKey: 'KEY-A' }, { privateKey: 'KEY-B', passphrase: 'PASS' }],
    })
    const transport = new Ssh2Transport(15000, resolver)
    const session = await transport.connect(profile, () => true)
    const client = lastClient()
    const handler = authHandlerOf(client)
    expect(await nextAuth(handler)).toEqual({ type: 'publickey', username: 'root', key: 'KEY-A' })
    expect(await nextAuth(handler)).toEqual({ type: 'publickey', username: 'root', key: 'KEY-B', passphrase: 'PASS' })
    expect(await nextAuth(handler)).toEqual({ type: 'password', username: 'root', password: 'sekrit' })
    expect(await nextAuth(handler)).toBe(false)
    await session.close()
  })

  it('tries only keys when no password is stored', async () => {
    const resolver = new StubResolver({ keys: [{ privateKey: 'KEY', passphrase: 'PASS' }] })
    const transport = new Ssh2Transport(15000, resolver)
    const session = await transport.connect(withoutPassword(profile), () => true)
    const handler = authHandlerOf(lastClient())
    expect(await nextAuth(handler)).toEqual({ type: 'publickey', username: 'root', key: 'KEY', passphrase: 'PASS' })
    expect(await nextAuth(handler)).toBe(false)
    await session.close()
  })

  it('gives up immediately when nothing resolves', async () => {
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(withoutPassword(profile), () => true)
    expect(await nextAuth(authHandlerOf(lastClient()))).toBe(false)
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
    vi.mocked(Client).mockImplementationOnce(() => fakeClientFactory('error', 'ECONNREFUSED'))
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
    const transport = new Ssh2Transport(15000, new StubResolver())
    const session = await transport.connect(profile, () => true)
    lastClient().emit('close')
    const callback = vi.fn()
    session.onClosed(callback)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
