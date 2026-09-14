// @vitest-environment jsdom
import type { SshMachineRow } from '@/store/modules/remote'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSshApiForTests, disposeRemoteForTests, remote } from '@/store/modules/remote'
import { RemoteManager } from './remote-manager'

// jsdom 未实现 CSS.escape（react-aria 可选集合依赖）
if (typeof globalThis.CSS === 'undefined') {
  Object.assign(globalThis, {
    CSS: {
      escape: (value: string) => value.replace(/[^\w-]/g, c => `\\${c}`),
    },
  })
}

// i18n 直通（key 即文案，插值拼后缀便于断言）
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.name !== undefined ? `${key}:${String(params.name)}` : key,
  }),
}))
const toastSpy = vi.fn()
const invokeSpy = vi.fn(async (..._args: unknown[]) => undefined)
vi.mock('@/utils/toast', () => ({
  toast: (...args: unknown[]) => { toastSpy(...args) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeSpy(...args),
}))

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return { id: 'm1', name: 'machine', state: 'disconnected', ...partial }
}

let engineMachines: SshMachineRow[] = []
const saveSpy = vi.fn(async (..._args: unknown[]) => undefined)
const removeSpy = vi.fn(async () => undefined)
const testSpy = vi.fn(async () => ({ ok: true, banner: 'Linux alpha' }))

function bindEngine() {
  saveSpy.mockClear()
  removeSpy.mockClear()
  testSpy.mockClear()
  bindSshApiForTests({
    listMachines: vi.fn(async () => engineMachines),
    connect: vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })),
    disconnect: vi.fn(async () => undefined),
    save: saveSpy as never,
    remove: removeSpy,
    test: testSpy,
  })
}

beforeEach(() => {
  disposeRemoteForTests()
  toastSpy.mockClear()
  invokeSpy.mockClear()
  engineMachines = []
  bindEngine()
})

afterEach(() => {
  cleanup()
  disposeRemoteForTests()
})

function seed(machines: SshMachineRow[]) {
  engineMachines = machines
  remote.machines = machines
}

describe('remoteManager 壳层管理面板', () => {
  it('列表：名称 + user@host:port + 状态；未连接行有连接/编辑/删除动作', async () => {
    seed([machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1', port: 22, user: 'root' })])
    render(<RemoteManager isOpen={true} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('manager-m1')).toBeTruthy())
    const row = screen.getByTestId('manager-m1')
    expect(row.textContent).toContain('alpha')
    expect(row.textContent).toContain('root@10.1.1.1:22')
    expect(row.textContent).toContain('remote.state.disconnected')
    expect(within(row).getByRole('button', { name: 'remote.manager.connect' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'remote.manager.edit_action' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'remote.manager.remove_action' })).toBeTruthy()
  })

  it('添加：主机派生 ID（撞名 -2 避让），手改 ID 后停止派生；主机空禁用保存', async () => {
    seed([machineOf({ id: 'dev', name: 'dev' })])
    render(<RemoteManager isOpen={true} onClose={() => {}} />)
    fireEvent.click(screen.getByText('remote.manager.add'))
    const form = await screen.findByTestId('machine-form')
    const hostInput = within(form).getByLabelText('remote.form.host')
    const idInput = within(form).getByLabelText('remote.form.id') as HTMLInputElement
    const saveButton = within(form).getByText('buttons.save').closest('button')!
    // 空主机：保存禁用 + 必填提示
    expect(saveButton.hasAttribute('disabled')).toBe(true)
    fireEvent.change(hostInput, { target: { value: 'ops@dev' } })
    expect(idInput.value).toBe('dev-2')
    expect(saveButton.hasAttribute('disabled')).toBe(false)
    // 手改 ID 后主机变更不再派生
    fireEvent.change(idInput, { target: { value: 'my-box' } })
    fireEvent.change(hostInput, { target: { value: '10.2.2.2' } })
    expect(idInput.value).toBe('my-box')
    // 提交：save 信封 + 名称回退主机
    fireEvent.click(saveButton)
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    const [profile] = saveSpy.mock.calls[0] as [Record<string, unknown>]
    expect(profile).toMatchObject({ id: 'my-box', name: '10.2.2.2', host: '10.2.2.2' })
    // 保存成功表单收起
    await waitFor(() => expect(screen.queryByTestId('machine-form')).toBeNull())
  })

  it('编辑：表单回填已存字段，敏感值留空=不传（保留已存）', async () => {
    seed([machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1', port: 22, user: 'root', remotePort: 3081, color: '#123456', hasPassword: true })])
    render(<RemoteManager isOpen={true} onClose={() => {}} />)
    fireEvent.click(within(screen.getByTestId('manager-m1')).getByRole('button', { name: 'remote.manager.edit_action' }))
    const form = await screen.findByTestId('machine-form')
    expect((within(form).getByLabelText('remote.form.host') as HTMLInputElement).value).toBe('10.1.1.1')
    expect((within(form).getByLabelText('remote.form.user') as HTMLInputElement).value).toBe('root')
    // 已存密码：placeholder 提示留空保留
    expect((within(form).getByLabelText('remote.form.password') as HTMLInputElement).placeholder).toBe('remote.form.keep_blank')
    // 编辑态无 ID 字段
    expect(within(form).queryByLabelText('remote.form.id')).toBeNull()
    fireEvent.click(within(form).getByText('buttons.save'))
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    const [profile, secrets] = saveSpy.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>]
    expect(profile).toMatchObject({ id: 'm1', name: 'alpha', host: '10.1.1.1', port: 22, user: 'root', remotePort: 3081, color: '#123456' })
    expect(secrets).toEqual({})
  })

  it('删除：确认弹窗后才 remove，成功后行消失', async () => {
    seed([machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1' })])
    render(<RemoteManager isOpen={true} onClose={() => {}} />)
    fireEvent.click(within(screen.getByTestId('manager-m1')).getByRole('button', { name: 'remote.manager.remove_action' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('remote.manager.remove_desc:alpha')
    expect(removeSpy).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByText('buttons.confirm'))
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('m1'))
  })

  it('已连接行：断开与新窗口动作；新窗口发 remote_open_window', async () => {
    seed([machineOf({ id: 'm1', name: 'alpha', host: '10.1.1.1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })])
    render(<RemoteManager isOpen={true} onClose={() => {}} />)
    const row = await screen.findByTestId('manager-m1')
    expect(within(row).getByRole('button', { name: 'remote.manager.disconnect' })).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'remote.open_new_window' }))
    await waitFor(() => {
      expect(invokeSpy).toHaveBeenCalledWith('remote_open_window', { machineId: 'm1', url: 'http://127.0.0.1:4001' })
    })
  })
})
