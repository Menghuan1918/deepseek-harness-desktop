import type { SshKey } from '../locales/index.js'
import type { FetchFn, MachineRow, SshApiResponse } from '../store/index.js'
import { fireEvent, screen, waitFor, within } from '@testing-library/dom'
import { act, cleanup, render } from '@testing-library/react'
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../locales/index.js'
import { MachinesStore } from '../store/index.js'
import { MachinesSection, OPEN_WINDOW_FEATURES } from './machines-section.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: SshKey) => string

type FetchMock = ReturnType<typeof vi.fn<FetchFn>>

function fakeFetch(envelope: SshApiResponse): FetchMock {
  return vi.fn<FetchFn>(async () => ({ json: async () => envelope }) as unknown as Response)
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

function mount(overrides: { envelope?: SshApiResponse } = {}) {
  const fetchFn = fakeFetch(overrides.envelope ?? { ok: true, value: { items: [] } })
  const store = new MachinesStore(fetchFn)
  const view = render(<MachinesSection store={store} t={t} />)
  return { view, store, fetchFn }
}

describe('machinesSection', () => {
  it('renders the loaded machine cards with statuses', async () => {
    const { fetchFn } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:49152' }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByTestId('status-a').textContent).toContain('Connected')
    expect(screen.getByText('http://127.0.0.1:49152')).toBeTruthy()
    const passwordInput = screen.getByPlaceholderText('set')
    expect(passwordInput).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledWith('/api-ssh', expect.objectContaining({ method: 'POST' }))
  })

  it('shows the empty state and adds a machine draft', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Add machine'))
    expect(screen.getByTestId('machine-')).toBeTruthy()
    const idInput = screen.getByLabelText('ID')
    fireEvent.change(idInput, { target: { value: 'n1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'newton' } })
    fireEvent.change(screen.getByLabelText('Host or config alias'), { target: { value: '10.1.1.1' } })
    fireEvent.change(screen.getByLabelText('User (optional)'), { target: { value: 'ops' } })
    expect(screen.getByText('Save').closest('button')?.hasAttribute('disabled')).toBe(false)
  })

  it('blocks saving while a draft is incomplete', async () => {
    mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    fireEvent.click(screen.getByText('Add machine'))
    expect(screen.getByText(/Fill in the machine ID, name, and host/)).toBeTruthy()
    expect(screen.getByText('Save').closest('button')?.hasAttribute('disabled')).toBe(true)
  })

  it('persists edits through the store', async () => {
    const { fetchFn } = mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha-2' } })
    fireEvent.change(screen.getByLabelText('Password (optional)'), { target: { value: 'sekrit' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(saveCalls(fetchFn)).toHaveLength(1))
    const payload = saveCalls(fetchFn)[0] as { row: Record<string, unknown>, secrets?: Record<string, unknown> }
    expect(payload.row).toMatchObject({ name: 'alpha-2' })
    expect(payload.secrets).toMatchObject({ password: 'sekrit' })
  })

  it('removes a draft and removes the machine on save', async () => {
    const { fetchFn } = mount({
      envelope: {
        ok: true,
        value: { items: [{ ...machineA, state: 'disconnected' }, { ...machineA, id: 'b', name: 'beta', state: 'disconnected' }] },
      },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    const betaCard = screen.getByTestId('machine-b')
    fireEvent.click(withinButton(betaCard, 'Remove'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(removeCalls(fetchFn)).toHaveLength(1))
    expect(removeCalls(fetchFn)[0]).toEqual({ method: 'machine.remove', payload: { machineId: 'b' } })
  })

  it('tests, connects, opens, and disconnects a machine', async () => {
    const fetchFn = fakeFetch({ ok: true, value: { items: [] } })
    const store = new MachinesStore(fetchFn)
    store.store.update((state) => {
      state.status = 'ready'
      state.machines = [machineA]
    })
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MachinesSection store={store} t={t} />)
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())

    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true, banner: 'Linux alpha' } }) } as unknown as Response)
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Test'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('Linux alpha'))

    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:49152' } }) } as unknown as Response)
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Connect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Open'))
    expect(openSpy).toHaveBeenCalledWith('http://127.0.0.1:49152', '_blank', OPEN_WINDOW_FEATURES)

    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: {} }) } as unknown as Response)
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Disconnect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Connect')).toBeTruthy())
  })

  it('renders the connecting state with the connect action disabled', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connecting' }] } } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByTestId('status-a').textContent).toContain('Connecting')
    expect(withinButton(screen.getByTestId('machine-a'), 'Connect').hasAttribute('disabled')).toBe(true)
  })

  it('edits every config field and falls back on malformed numbers', async () => {
    const { fetchFn } = mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '2222' } })
    fireEvent.change(screen.getByLabelText('Remote port'), { target: { value: 'abc' } })
    fireEvent.change(screen.getByLabelText('Start command (optional)'), { target: { value: 'dsh web --port 3000' } })
    fireEvent.change(screen.getByLabelText('Key passphrase (optional)'), { target: { value: 'phrase' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(saveCalls(fetchFn)).toHaveLength(1))
    const payload = saveCalls(fetchFn)[0] as { row: Record<string, unknown>, secrets?: Record<string, unknown> }
    expect(payload.row).toMatchObject({
      port: 2222,
      remotePort: 3080,
      startCommand: 'dsh web --port 3000',
    })
    expect(payload.secrets).toMatchObject({ passphrase: 'phrase' })
  })

  it('opens nothing when a connected machine has no tunnel url', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connected' }] } } })
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-a'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-a'), 'Open'))
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('persists the identity color and the border tint switch', async () => {
    const { fetchFn } = mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } } })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Color: #4176E6'))
    const card = screen.getByTestId('machine-a')
    expect(card.style.borderColor).toBe('')
    fireEvent.click(within(card).getByRole('switch'))
    expect(card.style.borderColor).toBe('rgb(65, 118, 230)')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(saveCalls(fetchFn)).toHaveLength(1))
    expect((saveCalls(fetchFn)[0] as { row: Record<string, unknown> }).row)
      .toMatchObject({ color: '#4176E6', tintBorder: true })
  })

  it('resets color and border tint through the default swatch', async () => {
    const { fetchFn } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected', color: '#4176E6', tintBorder: true }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByTestId('machine-a').style.borderColor).toBe('rgb(65, 118, 230)')
    fireEvent.click(screen.getByLabelText('Default'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(saveCalls(fetchFn)).toHaveLength(1))
    const row = (saveCalls(fetchFn)[0] as { row: Record<string, unknown> }).row
    expect(row.color).toBeUndefined()
    expect(row.tintBorder).toBeUndefined()
  })

  it('shows the live progress text of an in-flight operation', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing', attempt: 2, total: 30 } }] } } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Health check 2/30'))
  })

  it('shows the handshake progress phase', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'handshake' } }] } } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Connecting over SSH'))
  })

  it('falls back to question marks when probing progress has no numbers', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'probing' } }] } } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Health check ?/?'))
  })

  it('shows the starting progress phase', async () => {
    mount({ envelope: { ok: true, value: { items: [{ ...machineA, state: 'connecting', progress: { phase: 'starting' } }] } } })
    await waitFor(() => expect(screen.getByTestId('status-a').textContent).toContain('Starting the remote instance'))
  })

  it('polls the host while an operation is in flight and stops when idle', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = fakeFetch({ ok: true, value: { items: [] } })
      const store = new MachinesStore(fetchFn)
      store.store.update((state) => {
        state.status = 'ready'
        state.machines = [machineA]
        state.statuses = { a: { state: 'connecting', progress: { phase: 'handshake' } } }
      })
      render(<MachinesSection store={store} t={t} />)
      const before = fetchFn.mock.calls.length
      await act(async () => vi.advanceTimersByTime(1600))
      expect(fetchFn.mock.calls.length).toBe(before + 1)
      // Idle machines stop the polling loop.
      store.store.update((state) => {
        state.statuses = { a: { state: 'disconnected' } }
        state.busy = {}
      })
      await act(async () => vi.advanceTimersByTime(3200))
      expect(fetchFn.mock.calls.length).toBe(before + 1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('shows per-machine failures and the page error banner', async () => {
    const { store } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected', lastError: 'auth failed' }] } },
    })
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
    store.store.update((state) => {
      state.error = 'boom'
    })
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeTruthy())
  })

  it('renders discovered config aliases as read-only cards with working actions', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      value: {
        items: [],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: 'root', hasPassword: false, state: 'disconnected' }],
      },
    })
    const store = new MachinesStore(fetchFn)
    render(<MachinesSection store={store} t={t} />)
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.getByText('Hosts from ~/.ssh/config')).toBeTruthy()
    const card = screen.getByTestId('machine-dev')
    // Read-only: no editable fields, no Remove button.
    expect(within(card).queryByLabelText('ID')).toBeNull()
    expect(within(card).queryByText('Remove')).toBeNull()
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { ok: true, banner: 'Linux dev' } }) } as unknown as Response)
    fireEvent.click(withinButton(card, 'Test'))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('Linux dev'))
  })

  it('connects and opens a discovered config alias', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      value: {
        items: [],
        discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected' }],
      },
    })
    const store = new MachinesStore(fetchFn)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MachinesSection store={store} t={t} />)
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:49152' } }) } as unknown as Response)
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Connect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-dev'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Open'))
    expect(openSpy).toHaveBeenCalledWith('http://127.0.0.1:49152', '_blank', OPEN_WINDOW_FEATURES)
    fetchFn.mockResolvedValueOnce({ json: async () => ({ ok: true, value: {} }) } as unknown as Response)
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Disconnect'))
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-dev'), 'Connect')).toBeTruthy())
  })

  it('opens nothing for a discovered card without a tunnel url', async () => {
    mount({ envelope: { ok: true, value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'connected' }] } } })
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    await waitFor(() => expect(withinButton(screen.getByTestId('machine-dev'), 'Open')).toBeTruthy())
    fireEvent.click(withinButton(screen.getByTestId('machine-dev'), 'Open'))
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('disables connect while a discovered alias is connecting', async () => {
    mount({ envelope: { ok: true, value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'connecting' }] } } })
    await waitFor(() => expect(screen.getByTestId('status-dev').textContent).toContain('Connecting'))
    expect(withinButton(screen.getByTestId('machine-dev'), 'Connect').hasAttribute('disabled')).toBe(true)
  })

  it('shows a discovered alias failure inline', async () => {
    mount({ envelope: { ok: true, value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', hasPassword: false, state: 'disconnected', lastError: 'auth failed' }] } } })
    await waitFor(() => expect(screen.getByText('auth failed')).toBeTruthy())
  })

  it('shows the empty state only when no manual or discovered machines exist', async () => {
    mount({ envelope: { ok: true, value: { discovered: [{ ...machineA, id: 'dev', name: 'dev', host: 'dev', user: '', state: 'disconnected' }] } } })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.queryByText(/No SSH machines yet/)).toBeNull()
  })

  it('refreshes on demand', async () => {
    const { store } = mount()
    await waitFor(() => expect(screen.getByText(/No SSH machines yet/)).toBeTruthy())
    const load = vi.spyOn(store, 'load').mockResolvedValue(undefined)
    fireEvent.click(screen.getByText('Refresh'))
    expect(load).toHaveBeenCalled()
  })

  it('shows the one-click install surface when dsh is missing and installs on click', async () => {
    const { fetchFn } = mount({
      envelope: {
        ok: true,
        value: { items: [{ ...machineA, state: 'disconnected', lastError: 'dsh is not installed', dshMissing: true }] },
      },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    expect(screen.getByText(/No dsh found on the remote/)).toBeTruthy()
    expect(screen.getByText('Install dsh')).toBeTruthy()
    fireEvent.click(screen.getByText('Install dsh'))
    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([_url, init]) =>
        String(init.body).includes('machine.install'))).toBe(true)
    })
  })

  it('shows the installing phase with the live streaming log', async () => {
    const { store } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.store.update((state) => {
        state.busy.a = 'install'
        state.statuses.a = {
          state: 'disconnected',
          dshMissing: true,
          progress: { phase: 'installing', log: '==> Checking dependencies\ngit ... ok' },
        }
      })
    })
    expect(screen.getAllByText(/Installing dsh/).length).toBeGreaterThan(0)
    const log = screen.getByTestId('install-log')
    expect(log.textContent).toContain('==> Checking dependencies')
    expect(log.textContent).toContain('git ... ok')
  })

  it('shows the install outcome note under the card', async () => {
    const { store } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:1' }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.store.update((state) => {
        state.installResults.a = { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: true }
      })
    })
    expect(screen.getByTestId('install-note-a').textContent).toContain('API key was copied')
  })

  it('shows the install note when no local key exists', async () => {
    const { store } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.store.update((state) => {
        state.installResults.a = { dshPath: '/home/root/.local/bin/dsh', credentialsCopied: false }
      })
    })
    expect(screen.getByTestId('install-note-a').textContent).toContain('No DEEPSEEK_API_KEY found locally')
  })

  it('shows the install note with a credentials copy failure', async () => {
    const { store } = mount({
      envelope: { ok: true, value: { items: [{ ...machineA, state: 'disconnected' }] } },
    })
    await waitFor(() => expect(screen.getByText('alpha')).toBeTruthy())
    act(() => {
      store.store.update((state) => {
        state.installResults.a = {
          dshPath: '/home/root/.local/bin/dsh',
          credentialsCopied: false,
          credentialsError: 'disk full',
        }
      })
    })
    expect(screen.getByTestId('install-note-a').textContent).toContain('disk full')
  })

  it('offers the one-click install on a discovered alias too', async () => {
    const { fetchFn } = mount({
      envelope: {
        ok: true,
        value: {
          discovered: [{
            id: 'dev',
            name: 'dev',
            host: 'dev',
            port: 22,
            user: 'root',
            hasPassword: false,
            hasPassphrase: false,
            remotePort: 3080,
            state: 'disconnected',
            dshMissing: true,
            lastError: 'dsh is not installed',
          }],
        },
      },
    })
    await waitFor(() => expect(screen.getByText('dev')).toBeTruthy())
    expect(screen.getByText(/No dsh found on the remote/)).toBeTruthy()
    fireEvent.click(screen.getByText('Install dsh'))
    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([_url, init]) =>
        String(init.body).includes('machine.install'))).toBe(true)
    })
  })
})

/** The machine.save request bodies the fake fetch received. */
function saveCalls(fetchFn: ReturnType<typeof vi.fn>): unknown[] {
  return fetchFn.mock.calls
    .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: unknown })
    .filter(call => call.method === 'machine.save')
    .map(call => call.payload)
}

/** The machine.remove request bodies the fake fetch received. */
function removeCalls(fetchFn: ReturnType<typeof vi.fn>): Array<{ method: string, payload: Record<string, unknown> }> {
  return fetchFn.mock.calls
    .map(call => JSON.parse(String(call[1]?.body)) as { method: string, payload: Record<string, unknown> })
    .filter(call => call.method === 'machine.remove')
}

/** Find one button by its accessible text inside a container. */
function withinButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text)
  if (button === undefined)
    throw new Error(`no button "${text}"`)
  return button as HTMLButtonElement
}
