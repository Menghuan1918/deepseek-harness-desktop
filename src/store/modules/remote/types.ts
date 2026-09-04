/**
 * SSH 远端机器的类型面：壳层消费 `/api-ssh`（本地实例上的 dsh-tauri-ssh
 * 插件路由）所需的最小机器行词汇。字段与插件 host 侧
 * `SshMachineListItem`（C-STATE / S1 契约）逐字对齐：六态连接状态 +
 * `nextRetryAt`/`authMethod` 增量、隧道 URL、最近错误与机器标识色。
 * @module store/remote/types
 */

/** S3 状态词汇表（六态）：切换器状态点与切换语义的共用词汇。 */
export type SshConnectionState
  = | 'disconnected'
    | 'testing'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'given-up'

/** 切换器渲染所需的机器行（`machine.list` 行的壳层投影）。 */
export interface SshMachineRow {
  id: string
  name: string
  /** 标识色（手动机器可选）；色点优先取它。 */
  color?: string
  /** 是否用标识色给内容区描边。 */
  tintBorder?: boolean
  state: SshConnectionState
  /** 隧道就绪时的本地回环 URL（`http://127.0.0.1:<port>`）。 */
  tunnelBaseUrl?: string
  /** 最近一次失败的原因（given-up 时呈现入口）。 */
  lastError?: string
  /** 下次重连重试时间（epoch ms，reconnecting 时出现）。 */
  nextRetryAt?: number
}

/** `machine.list` 的应答信封（items = 手动机器，discovered = ~/.ssh/config 别名）。 */
export interface SshMachineListValue {
  items: SshMachineRow[]
  discovered: SshMachineRow[]
}
