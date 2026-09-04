import type { MachineView, SshTestResult } from '../types/index.js'
import type { SshApiHost, SshApiResponse } from './index.js'
import { Buffer } from 'node:buffer'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { MachineId, SshError } from '../types/index.js'
import { createSshApiHandler, isLoopbackPeer } from './index.js'

const view: MachineView = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}

function fakeHost(overrides: Partial<SshApiHost> = {}): SshApiHost {
  return {
    profileViews: () => [view],
    discoveredViews: async () => [],
    status: () => ({ machineId: MachineId('m1'), state: 'disconnected' }),
    test: async (): Promise<SshTestResult> => ({ ok: true, banner: 'Linux alpha' }),
    connect: async () => ({ tunnelBaseUrl: 'http://127.0.0.1:45678' }),
    disconnect: async () => {},
    install: async () => ({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }),
    save: async () => {},
    remove: async () => {},
    ...overrides,
  }
}

/** Drive one request through the handler and collect the response. */
async function call(
  host: SshApiHost,
  body: string,
  options: { method?: string, address?: string } = {},
): Promise<{ status: number, body: SshApiResponse }> {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: options.address ?? '127.0.0.1', configurable: true })
  const req = new IncomingMessage(socket)
  req.method = options.method ?? 'POST'
  const res = new ServerResponse(req)
  let status = 0
  let payload = ''
  res.writeHead = ((code: number) => {
    status = code
    return res
  }) as typeof res.writeHead
  res.end = ((chunk?: unknown) => {
    payload = String(chunk ?? '')
    return res
  }) as typeof res.end
  // Feed the body through the readable stream.
  req.push(Buffer.from(body))
  req.push(null)
  await createSshApiHandler(host)(req, res)
  return { status, body: JSON.parse(payload) as SshApiResponse }
}

describe('isLoopbackPeer', () => {
  it('accepts loopback addresses and rejects everything else', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('192.168.1.5')).toBe(false)
    expect(isLoopbackPeer(undefined)).toBe(false)
  })
})

describe('/api-ssh handler', () => {
  it('refuses non-loopback peers', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }), { address: '10.0.0.9' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses non-POST methods', async () => {
    const { status, body } = await call(fakeHost(), '', { method: 'GET' })
    expect(status).toBe(405)
    expect(body).toMatchObject({ ok: false, error: { code: 'method-not-allowed' } })
  })

  it('rejects malformed JSON and missing methods', async () => {
    const bad = await call(fakeHost(), 'not json')
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const missing = await call(fakeHost(), JSON.stringify({ payload: {} }))
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('lists machines with live status', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1', lastError: 'boom' }),
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        items: [{
          ...view,
          state: 'connected',
          tunnelBaseUrl: 'http://127.0.0.1:1',
          lastError: 'boom',
        }],
        discovered: [],
      },
    })
  })

  it('lists discovered config aliases with their live status', async () => {
    const host = fakeHost({
      discoveredViews: async () => [{
        id: MachineId('dev'),
        name: 'dev',
        host: 'dev',
        port: 22,
        user: '',
        hasPassword: false,
        hasPassphrase: false,
        remotePort: 3080,
      }],
      status: (id: MachineId) => id === MachineId('dev')
        ? { machineId: id, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:2' }
        : { machineId: id, state: 'disconnected' },
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        items: [{ ...view, state: 'disconnected' }],
        discovered: [{
          id: 'dev',
          name: 'dev',
          host: 'dev',
          port: 22,
          user: '',
          hasPassword: false,
          hasPassphrase: false,
          remotePort: 3080,
          state: 'connected',
          tunnelBaseUrl: 'http://127.0.0.1:2',
        }],
      },
    })
  })

  it('rides the live progress of an in-flight operation on list rows', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }),
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: {
        items: [{
          ...view,
          state: 'connecting',
          progress: { phase: 'probing', attempt: 2, total: 30 },
        }],
        discovered: [],
      },
    })
  })

  it('lists machines without link fields while disconnected', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list' }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { items: [{ ...view, state: 'disconnected' }], discovered: [] } })
  })

  it('rejects request bodies over the 64 KiB bound', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.list', payload: { pad: 'x'.repeat(70 * 1024) } }))
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('tests a machine', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { ok: true, banner: 'Linux alpha' } })
  })

  it('connects a machine and returns the tunnel URL', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:45678' } })
  })

  it('saves a machine with write-only secrets', async () => {
    const save = vi.fn(async () => {})
    const host = fakeHost({ save })
    const { status, body } = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: {
          name: 'alpha',
          host: '10.0.0.1',
          port: 22,
          user: 'root',
          remotePort: 3000,
          startCommand: 'dsh web --port 3000',
        },
        secrets: { password: 'PW', passphrase: 'PHRASE' },
      },
    }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      {
        name: 'alpha',
        host: '10.0.0.1',
        port: 22,
        user: 'root',
        remotePort: 3000,
        startCommand: 'dsh web --port 3000',
      },
      { password: 'PW', passphrase: 'PHRASE' },
    )
  })

  it('rejects malformed machine.save payloads', async () => {
    const save = vi.fn(async () => {})
    const host = fakeHost({ save })
    const missingRow = await call(host, JSON.stringify({ method: 'machine.save', payload: { machineId: 'm1' } }))
    expect(missingRow.body).toEqual({ ok: false, error: { code: 'internal', message: 'missing row' } })
    const badName = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: '', host: 'x', user: 'u' } },
    }))
    expect(badName.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: name' } })
    const badUserType = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 7 } },
    }))
    expect(badUserType.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: user' } })
    const badHost = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: '', user: 'u' } },
    }))
    expect(badHost.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid row: host' } })
    const badSecrets = await call(host, JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 'u' }, secrets: 'nope' },
    }))
    expect(badSecrets.body).toEqual({ ok: false, error: { code: 'internal', message: 'invalid secrets' } })
    expect(save).not.toHaveBeenCalled()
  })

  it('applies row defaults for absent numeric fields', async () => {
    const save = vi.fn(async () => {})
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: { machineId: 'm1', row: { name: 'a', host: 'x', user: 'u', startCommand: '' } },
    }))
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      undefined,
    )
  })

  it('drops absent secret fields', async () => {
    const save = vi.fn(async () => {})
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: { name: 'a', host: 'x', user: 'u' },
        secrets: { passphrase: 'PHRASE' },
      },
    }))
    expect(save).toHaveBeenCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { passphrase: 'PHRASE' },
    )
    await call(fakeHost({ save }), JSON.stringify({
      method: 'machine.save',
      payload: {
        machineId: 'm1',
        row: { name: 'a', host: 'x', user: 'u' },
        secrets: { password: 'P' },
      },
    }))
    expect(save).toHaveBeenLastCalledWith(
      MachineId('m1'),
      { name: 'a', host: 'x', port: 22, user: 'u', remotePort: 3080 },
      { password: 'P' },
    )
  })

  it('removes a machine', async () => {
    const remove = vi.fn(async () => {})
    const host = fakeHost({ remove })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.remove', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
    expect(remove).toHaveBeenCalledWith(MachineId('m1'))
  })

  it('disconnects a machine', async () => {
    const host = fakeHost()
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.disconnect', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: {} })
  })

  it('installs dsh on a machine and returns the outcome', async () => {
    const install = vi.fn(async () => ({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }))
    const host = fakeHost({ install })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.install', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({
      ok: true,
      value: { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true },
    })
    expect(install).toHaveBeenCalledWith(MachineId('m1'), expect.any(AbortSignal))
  })

  it('surfaces install failures on the envelope', async () => {
    const host = fakeHost({
      install: async () => { throw new SshError('machine-install-failed', MachineId('m1'), 'pnpm: not found') },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.install', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'machine-install-failed', message: 'pnpm: not found' } })
  })

  it('carries the dshMissing marker on list rows', async () => {
    const host = fakeHost({
      status: () => ({ machineId: MachineId('m1'), state: 'disconnected', dshMissing: true }),
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.list' }))
    expect(body).toMatchObject({ ok: true })
    const value = (body as { ok: true, value: { items: Array<Record<string, unknown>> } }).value
    expect(value.items[0]).toMatchObject({ dshMissing: true })
  })

  it('maps business failures onto the envelope', async () => {
    const host = fakeHost({
      test: async () => { throw new SshError('machine-connect-failed', MachineId('m1'), 'auth failed') },
    })
    const { status, body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(status).toBe(200)
    expect(body).toEqual({ ok: false, error: { code: 'machine-connect-failed', message: 'auth failed' } })
  })

  it('maps plain failures onto internal', async () => {
    const host = fakeHost({
      connect: async () => { throw new Error('tunnel broken') },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'tunnel broken' } })
  })

  it('maps non-Error failures onto internal', async () => {
    const host = fakeHost({

      test: async () => {
        // eslint-disable-next-line no-throw-literal -- deliberately non-Error: covers failureOf's String(error) arm
        throw 'boom'
      },
    })
    const { body } = await call(host, JSON.stringify({ method: 'machine.test', payload: { machineId: 'm1' } }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
  })

  it('requires a machineId on actions', async () => {
    const { body } = await call(fakeHost(), JSON.stringify({ method: 'machine.test', payload: {} }))
    expect(body).toEqual({ ok: false, error: { code: 'internal', message: 'missing machineId' } })
  })

  it('rejects unknown methods', async () => {
    const { status, body } = await call(fakeHost(), JSON.stringify({ method: 'machine.warp' }))
    expect(status).toBe(404)
    expect(body).toMatchObject({ ok: false, error: { code: 'unknown-method' } })
  })
})
