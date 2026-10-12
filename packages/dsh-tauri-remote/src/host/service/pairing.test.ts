import { beforeEach, describe, expect, it } from 'vitest'
import { PAIRING_TTL_MS, pairingCodeOf, resetPairingCode } from './pairing'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetPairingCode()
})

describe('pairingCodeOf', () => {
  it('生成 8 位无易混淆字符的配对码并在有效期内保持不变', () => {
    const first = pairingCodeOf(NOW)
    expect(first.code).toMatch(/^[2-9A-HJ-NP-Za-km-z]{8}$/u)
    expect(first.expiresAt).toBe(NOW + PAIRING_TTL_MS)
    expect(pairingCodeOf(NOW + PAIRING_TTL_MS - 1)).toBe(first)
  })

  it('过期即换新码，旧码立刻失效', () => {
    const first = pairingCodeOf(NOW)
    const next = pairingCodeOf(NOW + PAIRING_TTL_MS)
    expect(next.code).not.toBe(first.code)
    expect(next.expiresAt).toBe(NOW + PAIRING_TTL_MS * 2)
    expect(pairingCodeOf(NOW + PAIRING_TTL_MS)).toBe(next)
  })

  it('新旧码不相等且不会因为重复读取而漂移', () => {
    const codes = new Set<string>()
    for (let index = 0; index < 32; index += 1) {
      resetPairingCode()
      codes.add(pairingCodeOf(NOW).code)
    }
    expect(codes.size).toBe(32)
  })
})
