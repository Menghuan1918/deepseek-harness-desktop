/**
 * 远端机器模块（壳层）：机器列表轮询、iframe 切换目标（activeId/粘性隧道
 * URL）与降级态。数据面完全来自本地实例 `/api-ssh`（dsh-tauri-ssh 插件，
 * S1 契约）——壳不自存任何机器，连接/隧道/bootstrap 全部由插件引擎推进。
 *
 * 节奏（KISS，无推送通道）：秒级轮询 + 窗口聚焦触发刷新（监听在组件侧
 * hook 装配）；本地实例不可达时进入降级态（保留列表、静默重试，不弹错误
 * 风暴），恢复后自动复原。切换语义（断开回本地、重连粘性、就绪即切）由
 * 纯函数 `reconcileSwitcher` 承担（见 logic.ts）。
 * @module store/remote/store
 */

import type { SshMachineRow } from './types'
import { defineStore } from 'valtio-define'
import { harness } from '../harness'
import { createSshApiClient } from './api'
import { reconcileSwitcher } from './logic'

/** 轮询间隔（毫秒）：秒级即可让切换器跟上连接/重连状态流转。 */
const POLL_INTERVAL_MS = 2000

/** 模块级轮询句柄（与 harness store 的定时器管理模式一致）。 */
let pollTimer: ReturnType<typeof setInterval> | undefined

/** 数据面客户端：默认走全局 fetch 与 harness 的 serviceUrl（测试可替换）。 */
let api = createSshApiClient(
  (input, init) => fetch(input, init),
  () => harness.$state.serviceUrl,
)

/** 测试注入口：替换数据面客户端并复位切换状态（仅测试使用）。 */
export function bindSshApiForTests(client: {
  listMachines: () => Promise<SshMachineRow[]>
  connect: (machineId: string) => Promise<{ tunnelBaseUrl: string }>
  disconnect: (machineId: string) => Promise<void>
}): void {
  api = client
}

export const remote = defineStore({
  state: () => ({
    /** 全部机器（手动机器 + ~/.ssh/config 别名，按名排序）。 */
    machines: [] as SshMachineRow[],
    /** iframe 当前指向的远端机器（null = 本地实例）。 */
    activeId: null as string | null,
    /** 点击未连接机器后待切换的目标（连接就绪后升为 activeId）。 */
    pendingId: null as string | null,
    /** 活动机器最近已知的隧道 URL（重连窗口粘性保留，避免指向空端口）。 */
    activeTunnelUrl: '',
    /** `/api-ssh` 是否可达；不可达时切换器降级（禁用远端项 + 提示）。 */
    available: true,
    /** 单飞标志：上一轮未完成时跳过本轮，避免请求堆积。 */
    refreshing: false,
    booted: false,
  }),
  actions: {
    /** 首次挂载切换器时启动轮询（StrictMode 重复挂载下只执行一次）。 */
    boot() {
      if (this.booted)
        return
      this.booted = true
      void this.refresh()
      pollTimer = setInterval(() => {
        // 窗口隐藏时跳过本轮（平台 WebView 报告可见性才生效；恢复可见由
        // 组件侧 visibilitychange 触发的即时刷新兜底）
        if (typeof document !== 'undefined' && document.hidden)
          return
        void this.refresh()
      }, POLL_INTERVAL_MS)
    },

    /** 拉取机器列表并推进切换语义；不可达时进入降级态（静默，保留列表）。 */
    async refresh() {
      if (this.refreshing)
        return
      this.refreshing = true
      try {
        const machines = await api.listMachines()
        const next = reconcileSwitcher(
          { activeId: this.activeId, pendingId: this.pendingId, activeTunnelUrl: this.activeTunnelUrl },
          machines,
        )
        this.machines = machines
        this.activeId = next.activeId
        this.pendingId = next.pendingId
        this.activeTunnelUrl = next.activeTunnelUrl
        this.available = true
      }
      catch (err) {
        // 本地实例不可达（启动中/已停止）：降级但保留既有列表，静默重试
        console.warn('[remote] /api-ssh unreachable:', err)
        this.available = false
      }
      finally {
        this.refreshing = false
      }
    },

    /**
     * 切换视图：已连接直接切换；进行中（连接/重连）挂起等待；否则发起
     * 连接（阻塞到隧道就绪，见 S1 契约——不会指向空端口）。
     */
    switchTo(machineId: string) {
      if (!this.available)
        return
      const machine = this.machines.find(item => item.id === machineId)
      if (machine === undefined)
        return
      if (machine.state === 'connected' && machine.tunnelBaseUrl !== undefined) {
        this.activeId = machineId
        this.activeTunnelUrl = machine.tunnelBaseUrl
        this.pendingId = null
        return
      }
      if (machine.state === 'connecting' || machine.state === 'testing' || machine.state === 'reconnecting') {
        // 引擎已在推进（用户连接或自动重连）：挂起等待，轮询 reconcile 接管
        this.pendingId = machineId
        return
      }
      // disconnected / given-up：重新连接（given-up 可经再次 connect 退出）
      this.pendingId = machineId
      void this.connectAndSwitch(machineId)
    },

    /** 连接一台机器并在就绪后切换；失败留在本地（失败态由列表呈现）。 */
    async connectAndSwitch(machineId: string) {
      try {
        const link = await api.connect(machineId)
        await this.refresh()
        const machine = this.machines.find(item => item.id === machineId)
        if (machine !== undefined && machine.state === 'connected') {
          this.activeId = machineId
          this.activeTunnelUrl = machine.tunnelBaseUrl ?? link.tunnelBaseUrl
          this.pendingId = null
        }
      }
      catch (err) {
        console.warn('[remote] connect failed:', err)
        this.pendingId = null
        // 拉取引擎落定的失败态（given-up + lastError）供切换器呈现
        void this.refresh()
      }
    },

    /** 退回本地实例视图（不断开远端连接；同时撤销挂起中的切换）。 */
    backToLocal() {
      this.activeId = null
      this.activeTunnelUrl = ''
      this.pendingId = null
    },

    /** 断开一台机器：活动机器先退回本地视图，再向引擎发断开。 */
    async disconnect(machineId: string) {
      if (this.activeId === machineId)
        this.backToLocal()
      if (this.pendingId === machineId)
        this.pendingId = null
      try {
        await api.disconnect(machineId)
      }
      catch (err) {
        console.warn('[remote] disconnect failed:', err)
      }
      finally {
        void this.refresh()
      }
    },
  },
})

/** 停止轮询并复位（测试收尾用；壳层生命周期内不调用）。 */
export function disposeRemoteForTests(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  remote.booted = false
  remote.machines = []
  remote.activeId = null
  remote.pendingId = null
  remote.activeTunnelUrl = ''
  remote.available = true
  remote.refreshing = false
}
