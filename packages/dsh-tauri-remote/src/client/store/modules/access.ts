import type { AccessStatus } from '../../types/index'
import type { AccessViewState } from './access.types'
import { defineStore } from 'dsh-tauri/client'

function initialState(): AccessViewState {
  return {
    status: 'idle',
    error: null,
    busy: false,
    snapshot: null,
  }
}

export const access = defineStore({
  state: (): AccessViewState => initialState(),
  actions: {
    reset(): void {
      Object.assign(this, initialState())
    },
    beginLoad(): void {
      this.status = 'loading'
      this.error = null
    },
    commit(snapshot: AccessStatus): void {
      this.snapshot = snapshot
      this.status = 'ready'
      this.error = null
    },
    fail(message: string): void {
      this.status = 'error'
      this.error = message
    },
    beginBusy(): void {
      this.busy = true
    },
    endBusy(): void {
      this.busy = false
    },
  },
})
