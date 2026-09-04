/**
 * `/api-ssh` 客户端：壳层与 SSH 引擎（本地实例上的 dsh-tauri-ssh 插件）的
 * 全部数据往来。协议是 S1 契约的最小 JSON 信封（同源 POST、loopback-only）：
 *
 *   POST /api-ssh  { "method": "machine.list", "payload": {} }
 *   → 200          { "ok": true, "value": ... } | { "ok": false, "error": {...} }
 *
 * 壳层只用三个方法：`machine.list`（轮询）、`machine.connect`（切换到未连接
 * 机器）、`machine.disconnect`（面板之外的断开入口，预留给后续壳层动作）。
 * fetch 与基础 URL 均可注入，便于单测与复用。
 * @module store/remote/api
 */

import type { SshConnectionState, SshMachineListValue, SshMachineRow } from './types'

/** 一次请求信封。 */
interface SshApiRequest {
  method: string
  payload?: Record<string, unknown>
}

/** 一次应答信封。 */
type SshApiResponse
  = | { ok: true, value: unknown }
    | { ok: false, error: { code: string, message: string } }

/** fetch 函数形状（与全局 fetch 兼容，可注入 mock）。 */
export type SshFetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** 本客户端面向壳层暴露的引擎动作。 */
export interface SshApiClient {
  /** `machine.list`：手动机器 + ~/.ssh/config 别名机器（已按名排序合并）。 */
  listMachines: () => Promise<SshMachineRow[]>
  /** `machine.connect`：阻塞到隧道就绪，返回隧道 URL。 */
  connect: (machineId: string) => Promise<{ tunnelBaseUrl: string }>
  /** `machine.disconnect`：主动断开（远端实例保持运行）。 */
  disconnect: (machineId: string) => Promise<void>
}

/** 非法机器行兜底：缺 id/name/state 的行直接丢弃，不让坏数据进切换器。 */
function machineRowOf(raw: unknown): SshMachineRow | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '')
    return undefined
  if (typeof value.name !== 'string' || value.name === '')
    return undefined
  const STATES: SshConnectionState[] = ['disconnected', 'testing', 'connecting', 'connected', 'reconnecting', 'given-up']
  if (!STATES.includes(value.state as SshConnectionState))
    return undefined
  return {
    id: value.id,
    name: value.name,
    ...typeof value.color === 'string' && value.color !== '' ? { color: value.color } : {},
    ...value.tintBorder === true ? { tintBorder: true } : {},
    state: value.state as SshConnectionState,
    ...typeof value.tunnelBaseUrl === 'string' ? { tunnelBaseUrl: value.tunnelBaseUrl } : {},
    ...typeof value.lastError === 'string' ? { lastError: value.lastError } : {},
    ...typeof value.nextRetryAt === 'number' ? { nextRetryAt: value.nextRetryAt } : {},
  }
}

/**
 * 组一个 `/api-ssh` 客户端。
 *
 * @param fetchFn - fetch 实现（默认全局 fetch；测试注入 mock）。
 * @param getBaseUrl - 本地实例基址（默认读 harness store 的 serviceUrl）。
 */
export function createSshApiClient(
  fetchFn: SshFetchFn,
  getBaseUrl: () => string,
): SshApiClient {
  async function call<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await fetchFn(`${getBaseUrl()}/api-ssh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload: payload ?? {} } satisfies SshApiRequest),
    })
    if (!response.ok)
      throw new Error(`SSH_API_HTTP_${response.status}`)
    const envelope = await response.json() as SshApiResponse
    if (!envelope.ok)
      throw new Error(envelope.error?.message || envelope.error?.code || 'SSH_API_ERROR')
    return envelope.value as T
  }

  return {
    async listMachines() {
      const value = await call<SshMachineListValue>('machine.list')
      const items = (value?.items ?? []).map(machineRowOf).filter((row): row is SshMachineRow => row !== undefined)
      const discovered = (value?.discovered ?? []).map(machineRowOf).filter((row): row is SshMachineRow => row !== undefined)
      // 确定性排序（localeCompare 的 ICU 整序在不同环境不稳定）
      return [...items, ...discovered].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    connect: machineId => call<{ tunnelBaseUrl: string }>('machine.connect', { machineId }),
    disconnect: async (machineId) => {
      await call<unknown>('machine.disconnect', { machineId })
    },
  }
}
