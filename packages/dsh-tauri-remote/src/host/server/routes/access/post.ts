import type { EventHandlerRequest } from 'h3'
import type { RemoteAccessBody, RemoteAccessStatus } from '../../../service/access.types'
import { defineEventHandler, readBody } from 'h3'
import { access } from '../../../service/access'
import { mutationDenied } from '../../panel.utils'
import { guarded } from '../index.utils'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus | { error: string }>>(async (event) => {
  const body = (await readBody<RemoteAccessBody>(event)) ?? {}
  const denied = mutationDenied(event)
  if (denied !== undefined)
    return denied
  return await guarded(event, async () => await access.apply(body))
})
