import { generateAccessPassword } from '../utils/auth'

/** 临时配对码有效期：5 分钟到期自动换新（评审意见 6）。 */
export const PAIRING_TTL_MS = 5 * 60 * 1000

const PAIRING_CODE_LENGTH = 8

let current: { code: string, expiresAt: number } | undefined

/**
 * 惰性轮换：只在读取时检查过期，不需要宿主定时器；过期即换新码，旧码立刻失效。
 * 已签发会话依赖独立的会话密钥，不受换码影响，因此不会被踢下线（评审意见 6）。
 */
export function pairingCodeOf(now = Date.now()): { code: string, expiresAt: number } {
  if (current === undefined || current.expiresAt <= now)
    current = { code: generateAccessPassword(PAIRING_CODE_LENGTH), expiresAt: now + PAIRING_TTL_MS }
  return current
}

export function resetPairingCode(): void {
  current = undefined
}
