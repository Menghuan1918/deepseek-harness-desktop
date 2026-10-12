// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteShare } from './remote-share'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const getAccessSpy = vi.fn<() => Promise<unknown>>()
const postAccessSpy = vi.fn<(body: unknown) => Promise<unknown>>()
const postAccessTunnelSpy = vi.fn<(body: unknown) => Promise<unknown>>()
const deleteAccessTunnelSpy = vi.fn<() => Promise<unknown>>()
vi.mock('@/apis/remote', () => ({
  getAccess: () => getAccessSpy(),
  postAccess: (body: unknown) => postAccessSpy(body),
  postAccessTunnel: (body: unknown) => postAccessTunnelSpy(body),
  deleteAccessTunnel: () => deleteAccessTunnelSpy(),
}))

const clipboardSpy = vi.fn<(text: string, message?: string) => Promise<void>>()
vi.mock('@/utils/clipboard', () => ({
  writeClipboardText: (text: string, message?: string) => clipboardSpy(text, message),
}))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

if (typeof CSS === 'undefined')
  vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.getAnimations = function () {
  return []
}

const QR = 'data:image/png;base64,qr'
const PAIR_CODE = '482913'
const LAN_LINK = 'http://192.168.1.5:3080/?auth=482913'
const TUNNEL_LINK = 'https://demo.trycloudflare.com/?auth=482913'

function pairingOf(patch: Record<string, unknown> = {}) {
  return {
    code: PAIR_CODE,
    expiresAt: Date.now() + 300_000,
    link: LAN_LINK,
    qr: QR,
    ...patch,
  }
}

function statusOf(patch: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    state: 'stopped',
    listening: false,
    listen: { address: '0.0.0.0', port: 3080 },
    port: 3080,
    linkSource: 'lan',
    tunnel: { enabled: false, mode: 'quick', hostname: null, state: 'stopped', events: [] },
    ...patch,
  }
}

const listening = {
  state: 'listening',
  listening: true,
  link: LAN_LINK,
  maskLink: 'http://192.168.1.5:3080/?auth=***',
  qr: QR,
  pairing: pairingOf(),
}

async function openShare() {
  fireEvent.click(screen.getByRole('button', { name: 'remote.share' }))
  await screen.findByRole('dialog')
}

function clickTunnelTab() {
  fireEvent.click(screen.getByText('remote.share.tab_tunnel'))
}

beforeEach(() => {
  getAccessSpy.mockReset()
  postAccessSpy.mockReset()
  postAccessTunnelSpy.mockReset()
  deleteAccessTunnelSpy.mockReset()
  clipboardSpy.mockReset()
  clipboardSpy.mockResolvedValue(undefined)
  getAccessSpy.mockResolvedValue(statusOf())
  postAccessSpy.mockResolvedValue(statusOf(listening))
  postAccessTunnelSpy.mockResolvedValue(statusOf())
  deleteAccessTunnelSpy.mockResolvedValue(statusOf())
})

afterEach(() => {
  cleanup()
})

describe('remoteShare 远程分享弹层', () => {
  it('未打开弹层时不拉取状态', () => {
    render(<RemoteShare onManage={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getAccessSpy).not.toHaveBeenCalled()
  })

  it('局域网未开启：只给开启入口，动作成功后立刻显示新的可达链接', async () => {
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    expect(await screen.findByText('remote.share.lan_enable')).toBeTruthy()

    fireEvent.click(screen.getByText('remote.share.lan_enable'))

    await waitFor(() => expect(postAccessSpy).toHaveBeenCalledWith({ enabled: true }))
    expect(await screen.findByText(LAN_LINK)).toBeTruthy()
  })

  it('局域网已开启：显示链接、二维码与复制按钮', async () => {
    getAccessSpy.mockResolvedValue(statusOf(listening))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    expect(await screen.findByText(LAN_LINK)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'remote.share.qr_alt' }).getAttribute('src')).toBe(QR)
    expect(screen.queryByText('remote.share.lan_local_only')).toBeNull()

    fireEvent.click(screen.getByText('remote.share.copy'))
    await waitFor(() => expect(clipboardSpy).toHaveBeenCalledWith(LAN_LINK, 'remote.share.copied'))
  })

  it('回环来源：不给链接、二维码与复制，只给仅本机可用的提示', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      ...listening,
      link: 'http://127.0.0.1:3080/?auth=482913',
      maskLink: 'http://127.0.0.1:3080/?auth=***',
      pairing: pairingOf({ link: 'http://127.0.0.1:3080/?auth=482913' }),
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()

    expect(await screen.findByText('remote.share.lan_local_only')).toBeTruthy()
    expect(screen.queryByText(/127\.0\.0\.1/u)).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText('remote.share.copy')).toBeNull()
  })

  it('隧道关闭：只显示启用入口', async () => {
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByText('remote.share.tunnel_enable')).toBeTruthy()
    expect(screen.queryByText('remote.share.tunnel_ready')).toBeNull()
    expect(screen.queryByText('remote.share.tunnel_failed')).toBeNull()
  })

  it('隧道启动中：显示阶段与下载进度', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      tunnel: { state: 'starting', mode: 'quick', progress: { stage: 'download', received: 1048576, total: 4194304 } },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByText('remote.share.stage.download')).toBeTruthy()
    expect(screen.getByText('remote.share.download_progress')).toBeTruthy()
    expect(screen.getByText('remote.share.tunnel_starting')).toBeTruthy()
  })

  it('隧道失败：显示原因并可重试', async () => {
    postAccessTunnelSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ tunnelLink: TUNNEL_LINK, tunnelQr: QR }),
      tunnel: { state: 'running', mode: 'quick', link: TUNNEL_LINK, qr: QR },
    }))
    getAccessSpy.mockResolvedValue(statusOf({ tunnel: { state: 'error', mode: 'quick', error: 'dial failed' } }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByText(/dial failed/)).toBeTruthy()
    fireEvent.click(screen.getByText('remote.connect.retry'))

    await waitFor(() => expect(postAccessTunnelSpy).toHaveBeenCalledWith({ mode: 'quick' }))
    expect(await screen.findByText(TUNNEL_LINK)).toBeTruthy()
  })

  it('隧道就绪：显示隧道链接、二维码与临时配对码', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ tunnelLink: TUNNEL_LINK, tunnelQr: QR }),
      tunnel: { state: 'running', mode: 'quick', link: 'https://demo.trycloudflare.com/?auth=tok', qr: QR },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByText('remote.share.tunnel_ready')).toBeTruthy()
    expect(screen.getByText(TUNNEL_LINK)).toBeTruthy()
    expect(screen.getByTestId('remote-share-pairing').textContent).toBe(PAIR_CODE)
    expect(screen.getByText('remote.share.pairing_expires')).toBeTruthy()
    expect(screen.getByText('remote.share.pairing_hint')).toBeTruthy()
  })

  it('配对码过期：重新拉取状态换新码，且不因同一过期时间反复重试', async () => {
    getAccessSpy.mockResolvedValue(statusOf({
      pairing: pairingOf({ expiresAt: Date.now() - 1000 }),
      tunnel: { state: 'running', mode: 'quick' },
    }))
    render(<RemoteShare onManage={vi.fn()} />)
    await openShare()
    clickTunnelTab()

    expect(await screen.findByTestId('remote-share-pairing')).toBeTruthy()
    await waitFor(() => expect(getAccessSpy).toHaveBeenCalledTimes(2))
    expect(getAccessSpy).toHaveBeenCalledTimes(2)
  })

  it('齿轮入口打通设置定位链路，缺席时点击不动作', async () => {
    const manageSpy = vi.fn()
    const { unmount } = render(<RemoteShare onManage={manageSpy} />)
    await openShare()
    fireEvent.click(screen.getByRole('button', { name: 'remote.share.settings' }))
    expect(manageSpy).toHaveBeenCalledTimes(1)
    unmount()

    render(<RemoteShare />)
    await openShare()
    fireEvent.click(screen.getByRole('button', { name: 'remote.share.settings' }))
    expect(manageSpy).toHaveBeenCalledTimes(1)
  })
})
