/**
 * 批次 · `dsh-tauri-remote` 入站访问面板（S6）在真实浏览器里的走查。
 *
 * 断言的是**用户可见行为**：设置侧栏「远程访问」页三张分组卡（局域网 / 公网隧道 / 访问控制）的
 * 渲染与操作回执、短期配对凭据、永久访问码的显隐与作废，以及（`DSH_E2E_TUNNEL=1` 时）真实
 * cloudflared quick 隧道的启停。截图落在 `test/e2e/.artifacts/`，作为人工复核证据。
 *
 * 非回环监听的前置状态用同一套 HTTP 路由布置（面板下拉在 iframe 里的指针命中不稳，
 * 不适合做断言支点）；面板侧只断言渲染与凭据开关的真实回写。
 * 分享链接与二维码一律走宿主签发的短期配对凭据（永久 token 只在「永久访问码」行里显隐）。
 * 隧道用例默认关闭：它会真的下载 cloudflared 并占用公网随机域名，不适合放进常规门禁；
 * 打开后用例自带收尾（停止隧道、关闭暴露），不把状态留给后续用例。
 */

import type { Browser } from 'playwright'
import type { DshPage } from '../support/browser'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { launchDshBrowser, newDshPage, openSettings, selectSettingsSection } from '../support/browser'

const ARTIFACTS = join(import.meta.dirname, '..', '.artifacts')
const ACCESS_API = '/api/tauri/remote/access'
const PANEL = '[data-testid="access-section"]'
const LAN = '局域网'
const TUNNEL = '公网隧道'
const AUTH = '要求密码或链接 Token'
const LAN_ADDRESS = '[data-testid="access-lan-address"]'
const LINK = '[data-testid="access-link"]'
const MASK_LINK = '[data-testid="access-mask-link"]'
const LINK_HINT = '[data-testid="access-link-hint"]'
const PAIRING_CODE = '[data-testid="access-pairing-code"]'
const PAIRING_QR = '[data-testid="access-pairing-qr"]'
const PERMANENT_STATE = '[data-testid="access-permanent-state"]'
const PERMANENT_VALUE = '[data-testid="access-permanent-value"]'
const PERMANENT_REVEAL = '[data-testid="access-permanent-reveal"]'
const PERMANENT_REVOKE = '[data-testid="access-token-revoke"]'
const TUNNEL_START = '[data-testid="access-tunnel-start"]'
const TUNNEL_STOP = '[data-testid="access-tunnel-stop"]'
const TUNNEL_URL = '[data-testid="access-tunnel-url"]'
const TUNNEL_READY = '[data-testid="access-tunnel-ready"]'
const TUNNEL_STATE = '[data-testid="access-tunnel-state"]'
const TUNNEL_CODE = '[data-testid="access-tunnel-code"]'
const TUNNEL_QR = '[data-testid="access-tunnel-qr"]'
const GENERATED = '[data-testid="access-generated-password-value"]'
const GENERATED_DISMISS = '[data-testid="access-generated-password-dismiss"]'
const PROGRESS = '[data-testid="access-tunnel-progress"]'
const TUNNEL_E2E = process.env.DSH_E2E_TUNNEL === '1'

let browser: Browser

beforeAll(async () => {
  browser = await launchDshBrowser()
  mkdirSync(ARTIFACTS, { recursive: true })
})

afterAll(async () => {
  await browser?.close()
})

function apiHeaders(): Record<string, string> {
  return { 'cookie': inject('dshCookie'), 'content-type': 'application/json' }
}

async function apiPost(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) })
  expect(response.status, `${path} 必须返回 200`).toBe(200)
}

async function apiDelete(path: string): Promise<void> {
  const response = await fetch(`${inject('dshBaseUrl')}${path}`, { method: 'DELETE', headers: apiHeaders() })
  expect(response.status, `${path} 必须返回 200`).toBe(200)
}

async function shoot(app: DshPage, name: string): Promise<void> {
  await app.page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
}

function switchOf(app: DshPage, name: string) {
  return app.frame.getByRole('switch', { name }).first()
}

function authSwitch(app: DshPage) {
  return switchOf(app, AUTH)
}

async function openAccessPanel(app: DshPage): Promise<void> {
  await openSettings(app.page, app.frame, app.syntheticFallbacks)
  await selectSettingsSection(app.page, app.frame, '远程访问', app.syntheticFallbacks)
  // iframe 内的指针命中偶发丢失（与监听地址下拉同一现象），因此按 aria-selected 重试点击。
  const tab = app.frame.getByTestId('remote-tabs').getByRole('tab', { name: '远程访问' })
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await expect.poll(async () => {
    if (await tab.getAttribute('aria-selected') === 'true')
      return 'true'
    await tab.click({ timeout: 5_000 }).catch(() => undefined)
    return await tab.getAttribute('aria-selected')
  }, { timeout: 60_000 }).toBe('true')
  await app.frame.locator(PANEL).waitFor({ state: 'attached', timeout: 20_000 })
}

async function readText(app: DshPage, selector: string): Promise<string> {
  return await app.frame.locator(selector).first().textContent() ?? ''
}

/** 用例前后：关暴露、关认证、清密码、复位监听地址并撤销隧道与永久码，不依赖 UI，避免把状态留给同宿主里的后续用例。 */
async function resetExposure(): Promise<void> {
  await apiPost(ACCESS_API, { enabled: false, address: '127.0.0.1', authEnabled: false, password: null })
  await apiDelete(`${ACCESS_API}/tunnel`)
  await apiDelete(`${ACCESS_API}/token`)
}

describe('入站访问面板（真实浏览器）', () => {
  it('渲染「远程访问」页、开启回环监听并只给掩码链接与短期二维码', async () => {
    await resetExposure()
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(PANEL).isVisible()).toBe(true)
      const lan = switchOf(app, LAN)
      expect(await lan.getAttribute('aria-checked')).toBe('false')
      await shoot(app, 'access-1-panel')

      await lan.click()
      await expect.poll(() => lan.getAttribute('aria-checked'), { timeout: 20_000 }).toBe('true')
      await expect.poll(() => app.frame.locator(MASK_LINK).count(), { timeout: 20_000 }).toBe(1)
      expect(await readText(app, MASK_LINK), '回环地址不外发明文链接').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?auth=•+$/u)
      expect(await app.frame.locator(LINK).count(), '回环下没有明文链接').toBe(0)
      expect(await app.frame.locator(LINK_HINT).count(), '回环下给出「仅本机」说明').toBe(1)
      expect(await app.frame.locator(PAIRING_QR).count(), '短期配对二维码照常给出').toBe(1)
      expect(await authSwitch(app).getAttribute('aria-checked'), '开启监听即自动带认证').toBe('true')
      expect(await readText(app, GENERATED), '没有凭据时面板展示一次性密码').toMatch(/^[2-9A-HJ-NP-Za-km-z]{20}$/u)
      await shoot(app, 'access-2-loopback')

      await app.frame.locator(GENERATED_DISMISS).click()
      await expect.poll(() => app.frame.locator(GENERATED).count(), { timeout: 20_000 }).toBe(0)

      await lan.click()
      await expect.poll(() => app.frame.locator(LAN_ADDRESS).count(), { timeout: 20_000 }).toBe(0)
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 120_000)

  it('开放到全部网卡并带凭据后，入口行渲染链接与短期二维码，永久码可显隐与作废', async () => {
    await resetExposure()
    await apiPost(ACCESS_API, { enabled: true, address: '0.0.0.0', authEnabled: true, password: 'e2e-panel-pass', scope: 'public_only' })
    await apiPost(`${ACCESS_API}/token`, {})
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await expect.poll(() => app.frame.locator(PAIRING_QR).count(), { timeout: 30_000 }).toBe(1)
      await expect.poll(() => app.frame.locator(LINK).count(), { timeout: 20_000 }).toBe(1)
      expect(await readText(app, LINK)).toMatch(/\?auth=/u)
      expect(await app.frame.locator(PAIRING_QR).first().getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
      expect(await readText(app, PERMANENT_STATE)).toContain('链接可用')
      expect(await readText(app, PERMANENT_VALUE), '永久码默认掩码').toBe('••••••••••••')
      expect(await authSwitch(app).getAttribute('aria-checked')).toBe('true')
      await shoot(app, 'access-3-qr')

      await app.frame.locator(PERMANENT_REVEAL).click()
      expect(await readText(app, PERMANENT_VALUE), '点显示才出明文').toMatch(/^[\w-]{43}$/u)

      await authSwitch(app).click()
      await expect.poll(() => authSwitch(app).getAttribute('aria-checked'), { timeout: 20_000 }).toBe('false')

      // 面板必须能把自己签发的永久码作废，否则共享宿主会把凭据留给后续用例
      await app.frame.locator(PERMANENT_REVOKE).click()
      await expect.poll(async () => await readText(app, PERMANENT_STATE), { timeout: 20_000 }).toBe('尚未签发链接')
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 120_000)

  it.skipIf(!TUNNEL_E2E)('启动真实 quick 隧道并拿到公网地址，随后停止回收', async () => {
    await resetExposure()
    const app = await newDshPage(browser, { ready: '[data-slot="sidebar"]' })
    try {
      await openAccessPanel(app)
      await switchOf(app, TUNNEL).click()
      await app.frame.locator(TUNNEL_START).click()
      // 启动期边轮询边采样：进度必须在拿到公网地址之前至少出现过一次（不能静默）
      let sawProgress = false
      await expect.poll(async () => {
        if (await app.frame.locator(PROGRESS).count() > 0)
          sawProgress = true
        return await app.frame.locator(TUNNEL_URL).count()
      }, { timeout: 180_000, interval: 500 }).toBe(1)
      expect(sawProgress, '启动期必须能看到阶段进度').toBe(true)
      const url = await readText(app, TUNNEL_URL)
      expect(url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/\?auth=/u)
      const code = await readText(app, PAIRING_CODE)
      expect(code, '隧道链接只带宿主签发的短期配对码').toBe(url.split('?auth=').at(-1))
      expect(await readText(app, TUNNEL_CODE)).toContain(code)
      expect(await app.frame.locator(TUNNEL_QR).count(), '隧道就绪行给出二维码').toBe(1)
      expect(await authSwitch(app).getAttribute('aria-checked'), '启动隧道强制开认证').toBe('true')
      expect(await readText(app, TUNNEL_STATE)).toBe('隧道运行中')
      expect(await readText(app, TUNNEL_READY)).toBe('公网隧道已就绪')
      await shoot(app, 'access-4-tunnel')

      await app.frame.locator(TUNNEL_STOP).click()
      await expect.poll(() => app.frame.locator(TUNNEL_URL).count(), { timeout: 30_000 }).toBe(0)
      expect(await app.frame.locator(TUNNEL_STATE).count(), '停止后隧道卡片收起').toBe(0)
    }
    finally {
      await resetExposure()
      await app.page.close()
    }
  }, 300_000)
})
