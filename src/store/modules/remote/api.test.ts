import type { SshFetchFn } from './api'
import type { SshMachineListValue } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createSshApiClient } from './api'

/** 组一个返回固定信封的 fetch mock。 */
function fakeFetch(envelope: unknown, status = 200): SshFetchFn {
  return vi.fn(async () => ({ ok: status < 400, status, json: async () => envelope }) as unknown as Response)
}

const listValue: SshMachineListValue = {
  items: [
    { id: 'b', name: 'beta', state: 'connected', tunnelBaseUrl: 'http://127.0.0.1:4002', color: '#123456', tintBorder: true },
    { id: 'a', name: 'alpha', state: 'disconnected', lastError: 'boom', authMethod: 'key', nextRetryAt: 1725000000000 },
  ],
  discovered: [
    { id: 'alias', name: 'alias-host', state: 'disconnected' },
  ],
}

describe('createSshApiClient', () => {
  it('listMachines 合并手动机器与别名机器并按名排序，丢掉缺字段的坏行', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      value: {
        items: [...listValue.items, { id: '', name: 'bad', state: 'connected' }, { id: 'x' }],
        discovered: listValue.discovered,
      },
    })
    const client = createSshApiClient(fetchFn, () => 'http://127.0.0.1:3081')
    const rows = await client.listMachines()
    // 按 name 排序：alias-host < alpha < beta
    expect(rows.map(row => row.id)).toEqual(['alias', 'a', 'b'])
    expect(rows[2]).toMatchObject({ color: '#123456', tintBorder: true, tunnelBaseUrl: 'http://127.0.0.1:4002' })
    // 增量投影：authMethod 与 nextRetryAt 随行透出（切换器倒计时/凭据后缀用）
    expect(rows[1]).toMatchObject({ authMethod: 'key', nextRetryAt: 1725000000000 })
    // 请求形状：POST /api-ssh + machine.list 信封
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:3081/api-ssh',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ method: 'machine.list', payload: {} }) }),
    )
  })

  it('connect 透传 machineId 并返回隧道 URL', async () => {
    const fetchFn = fakeFetch({ ok: true, value: { tunnelBaseUrl: 'http://127.0.0.1:4004' } })
    const client = createSshApiClient(fetchFn, () => 'http://127.0.0.1:3081')
    await expect(client.connect('m1')).resolves.toEqual({ tunnelBaseUrl: 'http://127.0.0.1:4004' })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:3081/api-ssh',
      expect.objectContaining({ body: JSON.stringify({ method: 'machine.connect', payload: { machineId: 'm1' } }) }),
    )
  })

  it('ok:false 信封抛引擎错误消息（供切换器降级/失败呈现）', async () => {
    const client = createSshApiClient(
      fakeFetch({ ok: false, error: { code: 'machine-reconnecting', message: 'machine is reconnecting' } }),
      () => 'http://127.0.0.1:3081',
    )
    await expect(client.connect('m1')).rejects.toThrow('machine is reconnecting')
  })

  it('hTTP 非 200 与网络失败都抛错（本地实例不可达）', async () => {
    const httpError = createSshApiClient(fakeFetch({ ok: true, value: {} }, 503), () => 'http://127.0.0.1:3081')
    await expect(httpError.listMachines()).rejects.toThrow('SSH_API_HTTP_503')

    const networkError = createSshApiClient(
      vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as SshFetchFn,
      () => 'http://127.0.0.1:3081',
    )
    await expect(networkError.listMachines()).rejects.toThrow('fetch failed')
  })
})
