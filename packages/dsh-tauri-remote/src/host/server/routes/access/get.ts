import type { EventHandlerRequest } from 'h3'
import type { IncomingMessage } from 'node:http'
import type { RemoteAccessStatus } from '../../../service/access.types'
import type { GetAccessQuery } from '../index.types'
import { defineEventHandler, getQuery, HTTPError } from 'h3'
import { sourceSessionToken } from '../../../config/runtime'
import { access } from '../../../service/access'
import { redactStatus } from '../../../service/access.utils'
import { waitForPairingUse } from '../../../service/pairing'
import { isLoopbackSource } from '../../../utils/source'

export default defineEventHandler<EventHandlerRequest, Promise<RemoteAccessStatus>>(async (event) => {
  const query = getQuery<GetAccessQuery>(event)
  const raw = query.sincePairingUseSeq
  const since = raw === undefined ? undefined : typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
    throw new HTTPError({ statusCode: 400, message: 'invalid sincePairingUseSeq' })
  const request = (event.runtime as { node?: { req?: IncomingMessage } } | undefined)?.node?.req
  const loopback = request !== undefined && isLoopbackSource(request.headers, request.socket?.remoteAddress, sourceSessionToken())
  if (loopback && since !== undefined)
    await waitForPairingUse(since, event.req.signal)
  const status = await access.status()
  return loopback ? status : redactStatus(status)
})
