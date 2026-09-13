import type { SshKey } from '../locales/index'
import type { FetchFn, MachineRow } from '../store/index'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { cleanup, render } from '@testing-library/react'
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../locales/index'
import { MachinesStore } from '../store/index'
import { SyncPanel } from './sync-panel'

// dsh-tauri-ui/client 的 dist bundle 以 ModuleLoader 工厂包裹，脱离宿主加载器
// 无法在 node 求值；mock 到同一 cssr 实例的源文件（与 dsh-tauri-panel 同款做法），
// 组件渲染只消费 cls 字符串，不需要真实样式。
vi.mock('dsh-tauri-ui/client', async () => {
  const mod = await import('../../../../dsh-tauri-ui/src/client/utils/cssr.ts')
  return { cssr: mod.cssr }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: SshKey) => string

type FetchMock = ReturnType<typeof vi.fn<FetchFn>>

/** A fetch mock dispatching by /api-ssh method name. */
function routeFetch(routes: Record<string, unknown>, failures: string[] = []): FetchMock {
  return vi.fn<FetchFn>(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string }
    if (failures.includes(body.method)) {
      return { json: async () => ({ ok: false, error: { code: 'internal', message: `${body.method} broke` } }) } as unknown as Response
    }
    const value = routes[body.method] ?? {}
    return { json: async () => ({ ok: true, value }) } as unknown as Response
  })
}

const preview = {
  plugins: [
    { name: 'dsh-market', spec: 'github:omdsh/dsh-market', syncable: true },
    { name: 'local-thing', spec: 'link:../local', syncable: false, reason: 'local-path dependency; it cannot be resolved on the remote' },
  ],
  skills: [
    { name: 'alpha', root: 'dsh' },
    { name: 'beta', root: 'agents' },
  ],
}

const machineA: MachineRow = {
  id: 'a',
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  hasPassword: false,
  hasPassphrase: false,
  remotePort: 3080,
}

/** A store preloaded with one connected machine and a landed sync preview. */
function connectedStore(fetchFn: FetchMock): MachinesStore {
  const store = new MachinesStore(fetchFn)
  store.store.update((state) => {
    state.status = 'ready'
    state.machines = [machineA]
    state.statuses = { a: { state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' } }
    state.sync = { status: 'ready', error: null, preview, applying: false, results: null }
  })
  return store
}

describe('syncPanel', () => {
  it('keeps every independently selected item (multi-select, not a radio group)', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-plugin-dsh-market')).toBeTruthy())
    const plugin = screen.getByTestId('sync-plugin-dsh-market')
    const skill = screen.getByTestId('sync-skill-dsh-alpha')
    expect(plugin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(plugin)
    fireEvent.click(skill)
    expect(screen.getByTestId('sync-plugin-dsh-market').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('sync-skill-dsh-alpha').getAttribute('aria-pressed')).toBe('true')
    // Deselecting one leaves the others selected — the chip defect fix.
    fireEvent.click(screen.getByTestId('sync-plugin-dsh-market'))
    expect(screen.getByTestId('sync-plugin-dsh-market').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('sync-skill-dsh-alpha').getAttribute('aria-pressed')).toBe('true')
  })

  it('disables unsyncable plugins and shows their reason', async () => {
    const store = connectedStore(routeFetch({ 'machine.list': { items: [] } }))
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-plugin-local-thing')).toBeTruthy())
    expect(screen.getByTestId('sync-plugin-local-thing').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/local-path dependency/)).toBeTruthy()
  })

  it('sends the whole multi-selection to sync.apply', async () => {
    const fetchFn = routeFetch({ 'sync.apply': { items: [] } })
    const store = connectedStore(fetchFn)
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sync-plugin-dsh-market'))
    fireEvent.click(screen.getByTestId('sync-skill-agents-beta'))
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(applyCalls(fetchFn)).toHaveLength(1))
    expect(applyCalls(fetchFn)[0]).toEqual({
      machineId: 'a',
      plugins: [{ name: 'dsh-market', spec: 'github:omdsh/dsh-market' }],
      skills: [{ name: 'beta', root: 'agents' }],
    })
  })

  it('renders partial failures per item with reasons', async () => {
    const store = connectedStore(routeFetch({}))
    store.store.update((state) => {
      state.sync.results = [
        { kind: 'plugin', name: 'dsh-market', ok: true },
        { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
      ]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByTestId('sync-result-dsh-market').dataset.ok).toBe('true')
    const failed = screen.getByTestId('sync-result-alpha')
    expect(failed.dataset.ok).toBe('false')
    expect(failed.textContent).toContain('read-only file system')
    expect(failed.textContent).toContain('(dsh)')
    expect(screen.getByText(/1\/2 items succeeded/)).toBeTruthy()
  })

  it('renders a complete failure with every reason visible', async () => {
    const store = connectedStore(routeFetch({}))
    store.store.update((state) => {
      state.sync.results = [
        { kind: 'plugin', name: 'dsh-market', ok: false, error: 'exit 1: ERR_PNPM_NO_MATCH' },
        { kind: 'skill', name: 'alpha', root: 'dsh', ok: false, error: 'exit 1: read-only file system' },
      ]
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-results')).toBeTruthy())
    expect(screen.getByText(/0\/2 items succeeded/)).toBeTruthy()
    expect(screen.getByTestId('sync-result-dsh-market').textContent).toContain('ERR_PNPM_NO_MATCH')
    expect(screen.getByTestId('sync-result-alpha').textContent).toContain('read-only file system')
  })

  it('surfaces a request-level failure without swallowing previous results', async () => {
    const fetchFn = routeFetch({ 'sync.apply': { items: [] } }, ['sync.apply'])
    const store = connectedStore(fetchFn)
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByTestId('sync-apply')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sync-plugin-dsh-market'))
    fireEvent.click(screen.getByTestId('sync-apply'))
    await waitFor(() => expect(screen.getByText(/The sync request failed: sync.apply broke/)).toBeTruthy())
  })

  it('shows the not-connected note when no machine is connected', async () => {
    const store = new MachinesStore(routeFetch({}))
    store.store.update((state) => {
      state.status = 'ready'
      state.machines = [machineA]
      state.statuses = { a: { state: 'disconnected' } }
      state.sync = { status: 'ready', error: null, preview, applying: false, results: null }
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByText(/No connected machines/)).toBeTruthy())
    expect(screen.queryByTestId('sync-apply')).toBeNull()
  })

  it('shows the preview load failure with the reason', async () => {
    const fetchFn = routeFetch({}, ['sync.preview'])
    const store = new MachinesStore(fetchFn)
    store.store.update((state) => {
      state.status = 'ready'
    })
    render(<SyncPanel store={store} t={t} />)
    await waitFor(() => expect(screen.getByText(/Failed to load the sync list: sync.preview broke/)).toBeTruthy())
  })
})

/** The sync.apply request bodies the fake fetch received. */
function applyCalls(fetchFn: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchFn.mock.calls
    .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
    .filter(call => call.method === 'sync.apply')
    .map(call => call.payload)
}
