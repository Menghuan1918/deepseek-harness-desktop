import { describe, expect, it } from 'vitest'
import { navBridgeOf, SSH_MACHINES_SECTION } from './nav-bridge'

describe('navBridgeOf', () => {
  it('sends no callbacks while the iframe is absent', () => {
    const post = () => {}
    expect(navBridgeOf(post, false)).toEqual({})
  })

  it('translates every navbar action into its protocol message', () => {
    const sent: Array<Record<string, unknown>> = []
    const bridge = navBridgeOf(message => sent.push(message), true)

    bridge.onToggleSidebar?.()
    bridge.onNewChat?.()
    bridge.onOpenFolder?.()
    bridge.onOpenMachineManager?.()

    expect(sent).toEqual([
      { type: 'dsh://sidebar:toggle' },
      { type: 'dsh://session:new' },
      { type: 'dsh://workspace:add' },
      { type: 'dsh://settings:open', section: SSH_MACHINES_SECTION },
    ])
  })
})
