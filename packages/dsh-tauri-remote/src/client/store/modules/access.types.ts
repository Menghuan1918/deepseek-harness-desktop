import type { AccessStatus } from '../../types/index'

export type AccessLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AccessViewState {
  status: AccessLoadStatus
  error: string | null
  busy: boolean
  notice: string | null
  snapshot: AccessStatus | null
  /** 自动生成的访问密码明文：只在本次会话内保留，直到用户关闭提示；轮询刷新不覆盖。 */
  generatedPassword: string | null
}
