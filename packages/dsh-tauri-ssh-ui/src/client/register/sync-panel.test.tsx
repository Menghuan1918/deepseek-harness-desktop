import type { MachinesStore } from '../store/index'
import { describe, expect, it, vi } from 'vitest'
import { SYNC_PANEL_ID, syncPanelFeature } from './sync-panel'

const mocks = vi.hoisted(() => ({
  definePanel: vi.fn((_ctx: unknown, _entry: unknown) => ({ dispose: () => {} })),
}))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (feature: (...args: never[]) => void) => feature,
  definePanel: mocks.definePanel,
}))

describe('syncPanelFeature', () => {
  it('registers the sidebar panel with an embedded SyncPanel render', () => {
    const store = { subscribe: () => () => {}, getSnapshot: () => ({}) } as unknown as MachinesStore
    const feature = syncPanelFeature(store, key => key)
    const controller = { add: vi.fn() }
    ;(feature as (controller: unknown, ctx: unknown) => void)(controller, {})
    expect(controller.add).toHaveBeenCalledOnce()
    const entry = mocks.definePanel.mock.calls[0]?.[1] as unknown as { id: string, render: () => unknown }
    expect(entry.id).toBe(SYNC_PANEL_ID)
    expect(typeof entry.render).toBe('function')
    mocks.definePanel.mockClear()
  })
})
