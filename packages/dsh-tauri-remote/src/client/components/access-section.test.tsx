// @vitest-environment jsdom
import type { RemoteKey } from '../locales/index'
import type { WireCall, WireReply } from '../test-utils/client-mock'
import { fireEvent, screen, waitFor } from '@testing-library/dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../locales/index'
import { store } from '../store/index'
import { answer, replies, resetWire, sent } from '../test-utils/client-mock'
import { AccessSection } from './access-section'

vi.mock('dsh-tauri-ui/client', async () => (await import('../test-utils/ui-mock')).uiMock)
vi.mock('dsh-tauri/client', async () => (await import('../test-utils/client-mock')).clientMock)

const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as (key: RemoteKey) => string

const BASE = '/api/tauri/remote/access'
const LAN_SWITCH = en['access.lan.title']
const TUNNEL_SWITCH = en['access.tunnel.title']

function tunnelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [], ...overrides }
}

function pairingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'AB12CD34',
    expiresAt: Date.now() + 300_000,
    link: 'http://192.168.1.5:3088/?auth=AB12CD34',
    qr: 'data:image/png;base64,QUJD',
    ...overrides,
  }
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    state: 'listening',
    listening: true,
    listen: { address: '192.168.1.5', port: 3088 },
    port: 3088,
    auth: { enabled: false, scope: 'public_only', hasPassword: false, hasToken: true },
    addresses: [{ address: '192.168.1.5', family: 'ipv4', interface: 'en0', scope: 'private', score: 120, recommended: true }],
    recommended: '192.168.1.5',
    link: 'http://192.168.1.5:3088/?auth=tok',
    maskLink: 'http://192.168.1.5:3088/?auth=***',
    linkSource: 'lan',
    qr: 'data:image/png;base64,QUJD',
    tunnel: tunnelPayload(),
    localPort: 3080,
    events: [{ seq: 1, ts: '2026-10-06T00:00:00.000Z', kind: 'state', line: '入站暴露已监听 192.168.1.5:3088' }],
    ...overrides,
  }
}

let queued: WireReply[] = []
let route: (call: WireCall) => WireReply = () => replies.ok(statusPayload())

function once(...next: WireReply[]): void {
  queued.push(...next)
}

function getCalls(url: string, http: string): WireCall[] {
  return sent.filter(call => call.url === url && call.http === http)
}

beforeEach(() => {
  resetWire()
  store.access.reset()
  queued = []
  route = () => replies.ok(statusPayload())
  answer(call => queued.shift() ?? route(call))
})

afterEach(() => {
  cleanup()
})

describe('接入面板', () => {
  it('局域网卡给出真实地址与端口，且只在回环来源之外给明文链接', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-link')
    expect(screen.getByTestId('access-link').textContent).toBe('http://192.168.1.5:3088/?auth=tok')
    expect(screen.getByTestId('access-lan-port').textContent).toBe('3088')
    expect(screen.getByTestId('access-link-copy')).toBeTruthy()
    expect(screen.queryByTestId('access-mask-link')).toBeNull()
    expect(screen.queryByTestId('access-link-qr')).toBeNull()
  })

  it('非回环来源只给掩码，链接与二维码都不下发', async () => {
    route = () => replies.ok(statusPayload({ link: undefined, qr: undefined, linkSource: undefined }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-mask-link')
    expect(screen.queryByTestId('access-link')).toBeNull()
    expect(screen.queryByTestId('access-link-copy')).toBeNull()
    expect(screen.getByTestId('access-mask-link').textContent).toBe('http://192.168.1.5:3088/?auth=••••••')
    expect(screen.getByTestId('access-link-hint').textContent).toBe(en['access.lan.loopbackHint'])
  })

  it('回环监听即使有链接也只显示掩码与「仅本机」提示', async () => {
    route = () => replies.ok(statusPayload({ link: 'http://127.0.0.1:3088/?auth=tok', linkSource: 'loopback' }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-mask-link')
    expect(screen.queryByTestId('access-link')).toBeNull()
    expect(screen.getByTestId('access-mask-link').textContent).toBe('http://127.0.0.1:3088/?auth=••••••')
    expect(screen.getByTestId('access-link-hint')).toBeTruthy()
  })

  it('局域网关闭时只留开关这一行', async () => {
    route = () => replies.ok(statusPayload({ enabled: false, listening: false, state: 'stopped' }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-toggle')
    expect(screen.queryByTestId('access-lan-address')).toBeNull()
    expect(screen.queryByTestId('access-lan-port')).toBeNull()
    expect(screen.queryByTestId('access-lan-draft')).toBeNull()
    expect(screen.queryByTestId('access-share')).toBeNull()
  })

  it('开关直接以回包更新面板状态', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({ enabled: false, listening: false, state: 'stopped', link: undefined, qr: undefined, maskLink: undefined })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-link')
    fireEvent.click(screen.getByRole('switch', { name: LAN_SWITCH }))
    await waitFor(() => {
      expect(sent.at(-1)?.url).toBe(BASE)
      expect(sent.at(-1)?.body).toEqual({ enabled: false })
    })
    await waitFor(() => {
      expect(store.access.snapshot?.enabled).toBe(false)
    })
  })

  it('改地址只落草稿：取消不发请求，保存才提交一次', async () => {
    once(replies.ok(statusPayload()), replies.ok(statusPayload({ listen: { address: '127.0.0.1', port: 3088 } })))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-lan-address')
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: '127.0.0.1' } })
    await screen.findByTestId('access-lan-draft')
    expect(getCalls(BASE, 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('access-lan-cancel'))
    await waitFor(() => expect(screen.queryByTestId('access-lan-draft')).toBeNull())
    expect(getCalls(BASE, 'POST')).toHaveLength(0)
    fireEvent.change(select, { target: { value: '127.0.0.1' } })
    fireEvent.click(await screen.findByTestId('access-lan-save'))
    await waitFor(() => expect(getCalls(BASE, 'POST')).toHaveLength(1))
    expect(getCalls(BASE, 'POST')[0]?.body).toEqual({ address: '127.0.0.1' })
    await waitFor(() => expect(screen.queryByTestId('access-lan-draft')).toBeNull())
  })

  it('保存失败保留草稿输入并给出错误', async () => {
    once(replies.ok(statusPayload()), replies.http(400))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-lan-address')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '127.0.0.1' } })
    fireEvent.click(await screen.findByTestId('access-lan-save'))
    await waitFor(() => expect(screen.getByTestId('access-error').textContent).toContain('请求失败'))
    expect(screen.getByTestId('access-lan-draft')).toBeTruthy()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('127.0.0.1')
  })

  it('隧道关闭时不展开任何字段，打开开关本身不发请求', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-toggle')
    expect(screen.queryByTestId('access-tunnel-mode')).toBeNull()
    expect(screen.queryByTestId('access-tunnel-start')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: TUNNEL_SWITCH }))
    await screen.findByTestId('access-tunnel-mode')
    expect(getCalls(`${BASE}/tunnel`, 'POST')).toHaveLength(0)
  })

  it('quick 模式启动隧道：请求体只带模式，回包里的公网地址、访问码与二维码进入面板', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({
        pairing: pairingPayload({
          tunnelLink: 'https://bold-fox-abc.trycloudflare.com/?auth=AB12CD34',
          tunnelQr: 'data:image/png;base64,QUJD',
        }),
        tunnel: tunnelPayload({
          enabled: true,
          state: 'running',
          hostname: 'bold-fox-abc.trycloudflare.com',
          url: 'https://bold-fox-abc.trycloudflare.com',
          port: 3089,
          link: 'https://bold-fox-abc.trycloudflare.com/?auth=tok',
          qr: 'data:image/png;base64,QUJD',
          events: [{ seq: 1, ts: '2026-10-06T00:00:01.000Z', kind: 'state', line: '公网隧道已就绪：https://bold-fox-abc.trycloudflare.com' }],
        }),
      })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-toggle')
    fireEvent.click(screen.getByRole('switch', { name: TUNNEL_SWITCH }))
    await screen.findByTestId('access-tunnel-start')
    fireEvent.click(screen.getByTestId('access-tunnel-start'))
    await waitFor(() => {
      expect(sent.at(-1)?.url).toBe(`${BASE}/tunnel`)
      expect(sent.at(-1)?.body).toEqual({ mode: 'quick' })
    })
    await screen.findByTestId('access-tunnel-url')
    expect(screen.getByTestId('access-tunnel-url').textContent, '隧道就绪行必须用短期凭据链接，而非永久 token').toBe('https://bold-fox-abc.trycloudflare.com/?auth=AB12CD34')
    expect(screen.getByTestId('access-tunnel-state').textContent).toBe(en['access.tunnel.state.running'])
    expect(screen.getByTestId('access-tunnel-ready').textContent).toBe(en['access.tunnel.ready'])
    expect(screen.getByTestId('access-tunnel-code').textContent).toContain('AB12CD34')
    expect(screen.getByTestId('access-tunnel-qr')).toBeTruthy()
  })

  it('具名模式沿用已保存 Token，只提交改动过的主机名', async () => {
    once(
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token', token: 'cf-saved', hostname: 'dsh.example.com' }) })),
      replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token', token: 'cf-saved', hostname: 'new.example.com' }) })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-hostname')
    const token = screen.getByTestId('access-tunnel-token') as HTMLInputElement
    expect(token.value).toBe('cf-saved')
    fireEvent.change(token, { target: { value: '' } })
    expect(token.value, '清空 Token 输入必须回落到已保存凭据').toBe('cf-saved')
    fireEvent.change(screen.getByTestId('access-tunnel-hostname'), { target: { value: 'new.example.com' } })
    fireEvent.click(await screen.findByTestId('access-tunnel-save'))
    await waitFor(() => expect(getCalls(`${BASE}/tunnel`, 'POST')).toHaveLength(1))
    expect(getCalls(`${BASE}/tunnel`, 'POST')[0]?.body).toEqual({ mode: 'token', token: 'cf-saved', hostname: 'new.example.com' })
  })

  it('具名模式缺必填项时给出引导且不提交', async () => {
    once(replies.ok(statusPayload({ tunnel: tunnelPayload({ enabled: true, mode: 'token' }) })))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-hint')
    expect(screen.getByTestId('access-tunnel-hint').textContent).toBe(en['access.tunnel.tokenRequired'])
    expect((screen.getByTestId('access-tunnel-start') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('access-tunnel-start'))
    expect(getCalls(`${BASE}/tunnel`, 'POST')).toHaveLength(0)
  })

  it('临时配对码显示码、倒计时、短期链接与全页唯一的二维码', async () => {
    route = () => replies.ok(statusPayload({ pairing: pairingPayload() }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-code')
    expect(screen.getByTestId('access-pairing-code').textContent).toBe('AB12CD34')
    expect(screen.getByTestId('access-pairing-countdown').textContent).toContain(en['access.pairing.remaining'])
    expect(screen.getByTestId('access-pairing-link').textContent).toBe('http://192.168.1.5:3088/?auth=••••••')
    expect(screen.getByTestId('access-pairing-copy')).toBeTruthy()
    expect(screen.getByTestId('access-pairing-qr')).toBeTruthy()
  })

  it('配对码过期后提示已过期并自动刷新一次', async () => {
    let expired = true
    route = () => replies.ok(statusPayload(expired ? { pairing: pairingPayload({ expiresAt: Date.now() - 60_000 }) } : {}))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-pairing-countdown')
    expect(screen.getByTestId('access-pairing-countdown').textContent).toBe(en['access.pairing.expired'])
    expired = false
    await waitFor(() => expect(getCalls(BASE, 'GET').length).toBeGreaterThanOrEqual(2))
  })

  it('永久码默认掩码、点显示才出明文，签发与作废都走 /access/token', async () => {
    once(
      replies.ok(statusPayload()),
      replies.ok(statusPayload({ link: 'http://192.168.1.5:3088/?auth=next' })),
      replies.ok(statusPayload({ link: undefined, auth: { enabled: false, scope: 'public_only', hasToken: false } })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-permanent-value')
    expect(screen.getByTestId('access-permanent-value').textContent).toBe('••••••••••••')
    fireEvent.click(screen.getByTestId('access-permanent-reveal'))
    await waitFor(() => expect(screen.getByTestId('access-permanent-value').textContent).toBe('tok'))
    fireEvent.click(screen.getByTestId('access-token-rotate'))
    await waitFor(() => expect(sent.at(-1)?.url).toBe(`${BASE}/token`))
    expect(sent.at(-1)?.http).toBe('POST')
    await screen.findByTestId('access-token-revoke')
    fireEvent.click(screen.getByTestId('access-token-revoke'))
    await waitFor(() => expect(sent.at(-1)?.http).toBe('DELETE'))
    await waitFor(() => expect(screen.queryByTestId('access-token-revoke')).toBeNull())
  })

  it('访问认证与 scope 只保留一处，切换 scope 立即提交', async () => {
    once(
      replies.ok(statusPayload({ auth: { enabled: true, scope: 'public_only', hasPassword: false, hasToken: true } })),
      replies.ok(statusPayload({ auth: { enabled: true, scope: 'all', hasPassword: false, hasToken: true } })),
      replies.ok(statusPayload({ auth: { enabled: false, scope: 'all', hasPassword: false, hasToken: true } })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-auth-scope')
    expect(screen.getAllByTestId('access-auth-scope')).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: en['access.auth.scope.all'] }))
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ scope: 'all' }))
    fireEvent.click(screen.getByRole('switch', { name: en['access.auth.enable'] }))
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ authEnabled: false })
      expect(screen.queryByTestId('access-auth-scope')).toBeNull()
    })
  })

  it('自动生成的访问密码来自响应且只在会话内保留到用户关闭', async () => {
    once(
      replies.ok(statusPayload({ auth: { enabled: true, scope: 'public_only', hasPassword: true, hasToken: false }, generatedPassword: 'Kf7Qm2Xr9Tb4Nw8Zs6Ld' })),
      replies.ok(statusPayload({ auth: { enabled: true, scope: 'public_only', hasPassword: true, hasToken: false } })),
    )
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-generated-password')
    expect(screen.getByTestId('access-generated-password-value').textContent).toBe('Kf7Qm2Xr9Tb4Nw8Zs6Ld')
    fireEvent.click(screen.getByTestId('access-generated-password-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('access-generated-password')).toBeNull())
    fireEvent.click(screen.getByRole('switch', { name: LAN_SWITCH }))
    await waitFor(() => expect(screen.queryByTestId('access-generated-password')).toBeNull())
  })

  it('隧道启动期按阶段显示进度：下载阶段带百分比', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'starting', progress: { stage: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', received: 3_200_000, total: 6_400_000 } }),
    }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-progress')
    expect(screen.getByTestId('access-tunnel-progress-line').textContent).toBe('Downloading cloudflared 50%')
    expect(screen.getByTestId('access-tunnel-progress-bar').querySelector('div')?.getAttribute('style')).toContain('width: 50%')
  })

  it('隧道失败时错误、重试与停止都可见', async () => {
    route = () => replies.ok(statusPayload({
      tunnel: tunnelPayload({ enabled: true, state: 'error', error: 'cloudflared 下载失败（已尝试：https://…）' }),
    }))
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-tunnel-error')
    expect(screen.getByTestId('access-tunnel-error').textContent).toContain('cloudflared 下载失败')
    expect(screen.getByTestId('access-tunnel-start').textContent).toBe(en['access.tunnel.retry'])
    expect((screen.getByTestId('access-tunnel-stop') as HTMLButtonElement).disabled).toBe(false)
  })

  it('日志默认收起，按需展开', async () => {
    render(<AccessSection t={t} />)
    await screen.findByTestId('access-logs-toggle')
    expect(screen.queryByTestId('access-events')).toBeNull()
    fireEvent.click(screen.getByTestId('access-logs-toggle'))
    await screen.findByTestId('access-events')
    expect(screen.getByTestId('access-events').textContent).toContain('入站暴露已监听 192.168.1.5:3088')
  })
})
