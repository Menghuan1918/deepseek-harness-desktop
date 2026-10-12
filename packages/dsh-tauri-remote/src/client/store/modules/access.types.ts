import type { AccessStatus } from '../../types/index'

export type AccessLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AccessViewState {
  status: AccessLoadStatus
  error: string | null
  busy: boolean
  snapshot: AccessStatus | null
}
