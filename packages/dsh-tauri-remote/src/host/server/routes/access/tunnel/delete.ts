import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessStatus } from '../../../../service/access.types'
import { defineEventHandler } from 'h3'
import { access } from '../../../../service/access'
import { tunnel } from '../../../../service/tunnel'
import { mutationDenied } from '../../../panel.utils'
import { guarded } from '../../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async (event) => {
  const denied = mutationDenied(event)
  if (denied !== undefined)
    return denied
  return await guarded(event, async () => {
    await tunnel.stop()
    return await access.status()
  })
})
