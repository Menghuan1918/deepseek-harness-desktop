import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSettingsOpen, SETTINGS_OPEN_MESSAGE } from './settings-open'

const mocks = vi.hoisted(() => ({
  openAt: vi.fn(),
  listenParent: vi.fn(),
}))

vi.mock('dsh-tauri/client', () => ({
  defineRegister: (feature: (...args: never[]) => void) => feature,
  listenParent: mocks.listenParent,
}))

vi.mock('../store/modules/settings', () => ({
  settings: { openAt: mocks.openAt },
}))

describe('registerSettingsOpen', () => {
  beforeEach(() => {
    mocks.openAt.mockClear()
    mocks.listenParent.mockReset()
  })

  it('opens the settings overlay at the requested section on the host message', () => {
    mocks.listenParent.mockImplementation((handler: (message: unknown) => void, types: unknown) => {
      expect(types).toBe(SETTINGS_OPEN_MESSAGE)
      handler({ payload: { section: 'dsh-tauri-ssh' } })
      return () => {}
    })
    const controller = { add: vi.fn() }
    ;(registerSettingsOpen as (controller: unknown) => void)(controller)
    expect(mocks.listenParent).toHaveBeenCalledOnce()
    expect(mocks.openAt).toHaveBeenCalledWith('dsh-tauri-ssh')
  })

  it('ignores non-string sections and opens without a target', () => {
    mocks.listenParent.mockImplementation((handler: (message: unknown) => void) => {
      handler({ payload: { section: 42 } })
      handler({})
      return () => {}
    })
    ;(registerSettingsOpen as (controller: unknown) => void)({ add: vi.fn() })
    expect(mocks.openAt).toHaveBeenNthCalledWith(1, undefined)
    expect(mocks.openAt).toHaveBeenNthCalledWith(2, undefined)
  })
})
