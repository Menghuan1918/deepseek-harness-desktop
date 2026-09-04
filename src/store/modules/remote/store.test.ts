import type { SshMachineRow } from './types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSshApiForTests, disposeRemoteForTests, remote } from './store'

function machineOf(partial: Partial<SshMachineRow>): SshMachineRow {
  return { id: 'm1', name: 'machine', state: 'disconnected', ...partial }
}

/** 注入可编程 mock 引擎：listMachines 按调用序返回快照序列。 */
function bindEngine(options: {
  list: SshMachineRow[][]
  connect?: () => Promise<{ tunnelBaseUrl: string }>
}) {
  let call = 0
  const listMachines = vi.fn(async () => {
    const snapshot = options.list[Math.min(call, options.list.length - 1)]
    call += 1
    return snapshot
  })
  const connect = options.connect ?? (vi.fn(async () => ({ tunnelBaseUrl: 'http://127.0.0.1:4001' })))
  bindSshApiForTests({ listMachines, connect, disconnect: vi.fn(async () => undefined) })
  return { listMachines, connect }
}

beforeEach(() => {
  disposeRemoteForTests()
})

afterEach(() => {
  disposeRemoteForTests()
})

describe('remote store 轮询与降级', () => {
  it('refresh 成功更新机器列表；失败进入降级态并保留既有列表，恢复后复原', async () => {
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    expect(remote.machines.map(m => m.name)).toEqual(['alpha'])
    expect(remote.available).toBe(true)

    // 本地实例不可达：fetch 抛错 → 降级但不清空列表（静默，不弹错误）
    bindSshApiForTests({
      listMachines: vi.fn(async () => { throw new Error('SSH_API_HTTP_503') }),
      connect: vi.fn(async () => { throw new Error('unreachable') }),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.available).toBe(false)
    expect(remote.machines.map(m => m.name)).toEqual(['alpha'])

    // 恢复
    bindEngine({ list: [[machineOf({ id: 'm1', name: 'alpha' })]] })
    await remote.refresh()
    expect(remote.available).toBe(true)
  })

  it('boot 幂等：只挂一个轮询定时器（fake timers 下按周期节奏发请求）', async () => {
    vi.useFakeTimers()
    try {
      const engine = bindEngine({ list: [[machineOf({ id: 'm1' })]] })
      remote.boot()
      remote.boot()
      const afterBoot = engine.listMachines.mock.calls.length
      await vi.advanceTimersByTimeAsync(6000)
      // 6 秒 = 3 个周期；boot 即时 1 次 + 每周期 1 次（无重复 boot 的翻倍）
      expect(engine.listMachines.mock.calls.length).toBeLessThanOrEqual(afterBoot + 3)
      expect(engine.listMachines.mock.calls.length).toBeGreaterThanOrEqual(afterBoot + 2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('remote store 切换语义', () => {
  it('switchTo 已连接机器：立即切换到隧道 URL', async () => {
    bindEngine({ list: [[machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })]] })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.activeId).toBe('m1')
    expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001')
    expect(remote.pendingId).toBeNull()
  })

  it('switchTo 未连接机器：发起连接，就绪后自动切换（不指向空端口）', async () => {
    // 状态机式 mock：connect 调用前 disconnected，之后 connected 并给出隧道 URL
    let connected = false
    const engine = bindEngine({
      list: [[]],
      connect: vi.fn(async () => {
        connected = true
        return { tunnelBaseUrl: 'http://127.0.0.1:4002' }
      }),
    })
    engine.listMachines.mockImplementation(async () =>
      [machineOf(connected
        ? { id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002' }
        : { id: 'm1', state: 'disconnected' })])

    await remote.refresh()
    remote.switchTo('m1')
    expect(engine.connect).toHaveBeenCalledWith('m1')
    // connectAndSwitch 内部 refresh 驱动 reconcile，就绪后升为活动
    await vi.waitFor(() => {
      expect(remote.activeId).toBe('m1')
      expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4002')
      expect(remote.pendingId).toBeNull()
    })
  })

  it('连接失败：撤销待切换留在本地，失败态经 refresh 呈现', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'disconnected' })],
        [machineOf({ id: 'm1', state: 'given-up', lastError: 'connect failed after 3 attempt(s): refused' })],
      ],
      connect: vi.fn(async () => { throw new Error('machine is reconnecting') }),
    })
    await remote.refresh()
    remote.switchTo('m1')
    // connect 拒绝后 pending 清空；收尾 refresh 拉到 given-up 状态
    await vi.waitFor(() => {
      expect(remote.pendingId).toBeNull()
      expect(remote.machines[0]?.state).toBe('given-up')
      expect(remote.machines[0]?.lastError).toContain('refused')
    })
    expect(remote.activeId).toBeNull()
  })

  it('reconnecting 中点击：不重复 connect，挂起等待自动恢复', async () => {
    const engine = bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'reconnecting', nextRetryAt: Date.now() + 4000 })],
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.pendingId).toBe('m1')
    expect(engine.connect).not.toHaveBeenCalled()
    await remote.refresh()
    expect(remote.activeId).toBe('m1')
    expect(remote.activeTunnelUrl).toBe('http://127.0.0.1:4001')
  })

  it('活动机器被断开（面板 disconnect）：轮询自动回本地', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
        [machineOf({ id: 'm1', state: 'disconnected' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.activeId).toBe('m1')
    await remote.refresh()
    expect(remote.activeId).toBeNull()
    expect(remote.activeTunnelUrl).toBe('')
  })

  it('backToLocal：回本地并撤销挂起中的切换（不抢切）', async () => {
    bindEngine({
      list: [
        [machineOf({ id: 'm1', state: 'connecting' })],
        [machineOf({ id: 'm1', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4001' })],
      ],
    })
    await remote.refresh()
    remote.switchTo('m1')
    expect(remote.pendingId).toBe('m1')
    remote.backToLocal()
    expect(remote.activeId).toBeNull()
    expect(remote.pendingId).toBeNull()
    // 用户已选本地：即便机器随后就绪也不自动切换
    await remote.refresh()
    expect(remote.activeId).toBeNull()
  })

  it('降级态下 switchTo 直接忽略（远端项在切换器中已禁用）', async () => {
    bindSshApiForTests({
      listMachines: vi.fn(async () => { throw new Error('SSH_API_HTTP_503') }),
      connect: vi.fn(async () => { throw new Error('unreachable') }),
      disconnect: vi.fn(async () => undefined),
    })
    await remote.refresh()
    expect(remote.available).toBe(false)
    remote.switchTo('m1')
    expect(remote.pendingId).toBeNull()
  })
})
