import type { FetchFn, MachineRow, SshApiResponse } from './index.js'
import { describe, expect, it, vi } from 'vitest'
import { machineRowOf, MachinesStore, savePayloadOf } from './index.js'

type FetchMock = ReturnType<typeof vi.fn<FetchFn>>

function fakeFetch(envelope: SshApiResponse): FetchMock {
  return vi.fn<FetchFn>(async () => ({ json: async () => envelope }) as unknown as Response)
}

function boot(envelope: SshApiResponse = { ok: true, value: { items: [] } }) {
  const fetchFn = fakeFetch(envelope)
  const store = new MachinesStore(fetchFn)
  return { store, fetchFn }
}

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: true,
  hasPassphrase: false,
  remotePort: 3080,
}
const machineB: MachineRow = {
  ...machineA,
  id: 'b',
  name: 'beta',
  host: '10.0.0.2',
  port: 2222,
  user: 'deploy',
  hasPassword: false,
  hasPassphrase: true,
  remotePort: 3000,
  startCommand: 'dsh web --host 127.0.0.1 --port 3000',
}

describe('machineRowOf', () => {
  it('parses a well-formed redacted row', () => {
    expect(machineRowOf(machineA)).toEqual(machineA)
    expect(machineRowOf(machineB)).toEqual(machineB)
  })

  it('rejects malformed rows', () => {
    expect(machineRowOf(undefined)).toBeUndefined()
    expect(machineRowOf('x')).toBeUndefined()
    expect(machineRowOf({ ...machineA, id: '' })).toBeUndefined()
    expect(machineRowOf({ ...machineA, id: 5 })).toBeUndefined()
    expect(machineRowOf({ ...machineA, name: 5 })).toBeUndefined()
    expect(machineRowOf({ ...machineA, host: '' })).toBeUndefined()
    expect(machineRowOf({ ...machineA, user: 5 })).toBeUndefined()
  })

  it('falls back to defaults for absent numeric fields and optional startCommand', () => {
    const row = machineRowOf({ ...machineA, port: undefined, remotePort: undefined, startCommand: '', hasPassword: undefined })
    expect(row).toMatchObject({ port: 22, remotePort: 3080, hasPassword: false })
    expect(row).not.toHaveProperty('startCommand')
  })

  it('accepts an empty user (resolved from ~/.ssh config or the OS user)', () => {
    const row = machineRowOf({ ...machineA, user: '' })
    expect(row).toMatchObject({ user: '' })
  })
})

describe('savePayloadOf', () => {
  it('builds the config row and carries only typed secrets', () => {
    expect(savePayloadOf(machineB, { passphrase: 'PHRASE', password: '' })).toEqual({
      machineId: 'b',
      row: {
        name: 'beta',
        host: '10.0.0.2',
        port: 2222,
        user: 'deploy',
        remotePort: 3000,
        startCommand: 'dsh web --host 127.0.0.1 --port 3000',
      },
      secrets: { passphrase: 'PHRASE' },
    })
    expect(savePayloadOf(machineA, {})).toEqual({
      machineId: 'a',
      row: { name: 'alpha', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
    })
    expect(savePayloadOf({ ...machineA, startCommand: '' }, {})).not.toHaveProperty('row.startCommand')
  })
})

describe('machinesStore', () => {
  it('loads machines, secret flags, and live statuses from machine.list', async () => {
    const { store } = boot({
      ok: true,
      value: {
        items: [
          { ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' },
          { ...machineB, state: 'disconnected', lastError: 'auth failed' },
          { ...machineA, id: 'c', name: 'gamma', state: 'disconnected' },
        ],
      },
    })
    await store.load()
    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.machines.map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(state.machines[0]).toMatchObject({ hasPassword: true, hasPassphrase: false })
    expect(state.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    expect(state.statuses.b).toEqual({ state: 'disconnected', lastError: 'auth failed' })
    expect(state.statuses.c).toEqual({ state: 'disconnected' })
  })

  it('carries the live progress of in-flight operations', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }] },
    })
    await store.load()
    expect(store.getSnapshot().statuses.a)
      .toEqual({ state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } })
  })

  it('polls without flipping the loading banner', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] },
    })
    await store.load()
    fetchFn.mockClear()
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] } }),
    } as unknown as Response)
    await store.poll()
    const state = store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' })
  })

  it('tolerates a list response without the items key', async () => {
    const { store } = boot({ ok: true, value: {} })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', machines: [], discovered: [], statuses: {} })
  })

  it('loads the discovered config aliases alongside the manual machines', async () => {
    const { store } = boot({
      ok: true,
      value: {
        items: [{ ...machineA, state: 'disconnected' }],
        discovered: [
          { ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root', hasPassword: false, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' },
          { ...machineA, id: 'ci', name: 'ci', host: 'ci', user: '', hasPassword: false, state: 'disconnected' },
        ],
      },
    })
    await store.load()
    const state = store.getSnapshot()
    expect(state.machines.map(row => row.id)).toEqual(['a'])
    expect(state.discovered.map(row => row.id)).toEqual(['dev', 'ci'])
    expect(state.discovered[0]).toMatchObject({ host: 'dev', user: 'root', hasPassword: false, hasPassphrase: false })
    expect(state.statuses.dev).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:9' })
    expect(state.statuses.ci).toEqual({ state: 'disconnected' })
  })

  it('reports a list failure as a page error', async () => {
    const { store } = boot({ ok: false, error: { code: 'forbidden', message: 'loopback only' } })
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: 'loopback only' })
  })

  it('reports poll failures without flipping the ready status', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'forbidden', message: 'nope' } }) } as unknown as Response)
    await store.poll()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: 'nope' })
  })

  it('persists saves and removals through /api-ssh', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'disconnected' }, { ...machineB, state: 'disconnected' }] },
    })
    await store.load()
    fetchFn.mockClear()
    await store.persist(
      [{ ...machineA, name: 'alpha-2' }],
      { a: { password: 'sekrit', passphrase: 'PHRASE' } },
    )
    const calls = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
      .filter(call => call.method !== 'machine.list')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      method: 'machine.save',
      payload: {
        machineId: 'a',
        row: { name: 'alpha-2', host: '10.0.0.1', port: 22, user: 'root', remotePort: 3080 },
        secrets: { password: 'sekrit', passphrase: 'PHRASE' },
      },
    })
    expect(calls[1]).toEqual({ method: 'machine.remove', payload: { machineId: 'b' } })
    expect(store.getSnapshot().error).toBeNull()
  })

  it('persists only manual machines, never the discovered aliases', async () => {
    const { store, fetchFn } = boot({
      ok: true,
      value: {
        items: [{ ...machineA, state: 'disconnected' }],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected' }],
      },
    })
    await store.load()
    fetchFn.mockClear()
    await store.persist([machineA], {})
    const calls = fetchFn.mock.calls
      .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
      .filter(call => call.method !== 'machine.list')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'machine.save', payload: { machineId: 'a' } })
  })

  it('reports persist failures without throwing', async () => {
    const { store, fetchFn } = boot({ ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } })
    await store.load()
    fetchFn.mockClear()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'settings-rejected', message: 'nope' } }) } as unknown as Response)
    await store.persist([machineA], {})
    expect(store.getSnapshot().error).toBe('nope')
  })

  it('tests a machine and publishes the banner', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true, banner: 'Linux alpha' } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toBe('Linux alpha')
    expect(state.busy).toEqual({})
    const [, init] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ method: 'machine.test', payload: { machineId: 'a' } })
  })

  it('falls back to defaults when a probe omits banner or message', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true } }) } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().notice).toBe('ok')
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: false } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toBe('failed')
    expect(state.statuses.a).toEqual({ state: 'disconnected', lastError: 'failed' })
  })

  it('publishes failed probes with the failure message', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: false, message: 'auth failed' } }) } as unknown as Response)
    await store.test('a')
    const state = store.getSnapshot()
    expect(state.notice).toBe('auth failed')
    expect(state.statuses.a).toEqual({ state: 'disconnected', lastError: 'auth failed' })
  })

  it('connects, disconnects, and tracks busy state', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:49152' } }) } as unknown as Response)
    await store.connect('a')
    expect(store.getSnapshot().statuses.a).toEqual({ state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' })
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: {} }) } as unknown as Response)
    await store.disconnect('a')
    expect(store.getSnapshot().statuses.a).toEqual({ state: 'disconnected' })
    expect(store.getSnapshot().notice).toBe('disconnected')
  })

  it('marks a machine busy while a connection-plane op is in flight', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fetchFn.mockReturnValueOnce(gate.then(() => ({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:1' } }) }) as unknown as Response))
    const pending = store.connect('a')
    expect(store.getSnapshot().busy.a).toBe('connect')
    release!()
    await pending
    expect(store.getSnapshot().busy).toEqual({})
  })

  it('reports connection-plane failures as a banner error', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'connect-failed', message: 'refused' } }) } as unknown as Response)
    await store.connect('a')
    expect(store.getSnapshot().error).toBe('refused')
    fetchFn.mockResolvedValueOnce({
      json: async () => {
        throw new Error('bad json')
      },
    } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().error).toBe('bad json')
    fetchFn.mockResolvedValueOnce({

      json: async () => {
        // eslint-disable-next-line no-throw-literal -- deliberately non-Error: covers messageOf(String(error))
        throw 'boom'
      },
    } as unknown as Response)
    await store.test('a')
    expect(store.getSnapshot().error).toBe('boom')
  })

  it('carries the dshMissing marker on list rows', async () => {
    const { store } = boot({
      ok: true,
      value: { items: [{ ...machineA, state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true }] },
    })
    await store.load()
    const status = store.getSnapshot().statuses.a
    expect(status?.dshMissing).toBe(true)
    expect(status?.lastError).toBe('dsh is not installed')
  })

  it('installs dsh, records the outcome, and refreshes', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({
      json: async () => ({ ok: true, value: { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true } }),
    } as unknown as Response)
    await store.install('a')
    const state = store.getSnapshot()
    expect(state.installResults.a).toEqual({ dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true })
    // The follow-up load refreshed the list (auto-connect status).
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(state.busy).toEqual({})
  })

  it('reports an install failure as a banner error', async () => {
    const { store, fetchFn } = boot()
    await store.load()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: false, error: { code: 'machine-install-failed', message: 'pnpm: not found' } }) } as unknown as Response)
    await store.install('a')
    expect(store.getSnapshot().error).toBe('pnpm: not found')
  })

  it('exposes a uSES-compatible subscribe/getSnapshot seam', async () => {
    const { store } = boot()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.load()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    const before = listener.mock.calls.length
    await store.load()
    expect(listener.mock.calls.length).toBe(before)
    expect(store.getSnapshot()).toBe(store.store.getSnapshot())
  })
})
