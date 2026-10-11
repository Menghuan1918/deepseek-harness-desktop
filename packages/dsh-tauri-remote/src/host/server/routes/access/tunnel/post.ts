import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import type { RemoteTunnelMode } from '../../../../types/index'
import { defineEventHandler, readBody } from 'h3'
import { access } from '../../../../service/access'
import { tunnel } from '../../../../service/tunnel'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async event =>
  guarded(event, async () => {
    const body = (await readBody<{ mode?: unknown, token?: unknown, hostname?: unknown }>(event)) ?? {}
    const mode = modeOf(body.mode)
    const credential = textOf(body.token, 'token')
    const host = textOf(body.hostname, 'hostname')
    tunnel.assertStartable(mode, credential, host)
    const ensured = await access.ensureAuth()
    await tunnel.start(mode, credential, host)
    const status = await access.status()
    return ensured.generatedPassword === undefined ? status : { ...status, generatedPassword: ensured.generatedPassword }
  }))

// --- internal ---
function modeOf(value: unknown): RemoteTunnelMode {
  if (value === 'quick' || value === 'token')
    return value
  throw new Error('invalid mode: quick | token')
}

function textOf(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null)
    return undefined
  if (typeof value !== 'string')
    throw new Error(`invalid ${field}`)
  return value
}
