import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

type PageState = 'empty' | 'splash' | 'chat' | 'normal' | 'mounting'

interface BootHarnessOptions {
  /** 模拟顶层文档（非 iframe）：脚本必须整体不工作 */
  topFrame?: boolean
}

interface BootHarness {
  messages: string[]
  setState: (state: PageState) => void
}

const script = readFileSync(
  new URL('../src-tauri/src/desktop/plugin_boot.js.inc', import.meta.url),
  'utf8',
)

/** 帧身份申报（子 frame 解析出 `#root` 后必然先于其它消息到达一次）。 */
const FRAME_REPORT = 'dsh://plugin-boot:frame'

function createHarness(initialState: PageState, options: BootHarnessOptions = {}): BootHarness {
  let state = initialState
  let mutationCallback = () => {}
  const messages: string[] = []

  function textNodes() {
    if (state === 'splash') {
      return [{ textContent: 'HARNESS' }, { textContent: 'Loading plugins…' }]
    }
    if (state === 'chat') {
      return [
        { textContent: 'HARNESS' },
        { textContent: 'Loading plugins…' },
        { textContent: 'A chat message mentioning Loading plugins…' },
      ]
    }
    return []
  }

  const boot = {
    parentElement: null as typeof root | null,
    get textContent() {
      return state === 'splash' ? 'HARNESS Loading plugins…' : ''
    },
    querySelectorAll(selector: string) {
      return selector === 'div, span, p' ? textNodes() : []
    },
  }

  const root = {
    get childElementCount() {
      return state === 'empty' ? 0 : 1
    },
    get textContent() {
      if (state === 'splash')
        return 'HARNESS Loading plugins…'
      if (state === 'chat')
        return 'HARNESS Loading plugins… A chat message mentioning Loading plugins…'
      if (state === 'normal')
        return 'Harness application'
      return ''
    },
    querySelector(selector: string) {
      if (selector === '[data-dsh-boot]' && state === 'splash')
        return boot
      if (state === 'normal' && selector.includes('main'))
        return { textContent: 'Harness application' }
      return null
    },
  }
  boot.parentElement = root

  class FakeMutationObserver {
    constructor(callback: () => void) {
      mutationCallback = callback
    }

    observe() {}

    disconnect() {}
  }

  const top = {}
  const window = {
    top,
    parent: {
      postMessage(message: { type: string }) {
        messages.push(message.type)
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  if (options.topFrame)
    window.top = window
  runInNewContext(script, {
    window,
    document: {
      documentElement: {},
      getElementById: () => (state === 'mounting' ? null : root),
    },
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })

  return {
    messages,
    setState(nextState) {
      state = nextState
      mutationCallback()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('plugin boot bridge', () => {
  it('starts the stall deadline when the splash appears late', () => {
    vi.useFakeTimers()
    const harness = createHarness('empty')

    vi.advanceTimersByTime(20_000)
    expect(harness.messages).toEqual([FRAME_REPORT])

    harness.setState('splash')
    vi.advanceTimersByTime(7_999)
    expect(harness.messages).toEqual([FRAME_REPORT])
    vi.advanceTimersByTime(1)
    expect(harness.messages).toEqual([FRAME_REPORT, 'dsh://plugin-boot:stalled'])
  })

  it('resets the deadline when the splash disappears and rearms on reappearance', () => {
    vi.useFakeTimers()
    const harness = createHarness('splash')

    vi.advanceTimersByTime(4_000)
    harness.setState('empty')
    vi.advanceTimersByTime(10_000)
    expect(harness.messages).toEqual([FRAME_REPORT])

    harness.setState('splash')
    vi.advanceTimersByTime(8_000)
    expect(harness.messages).toEqual([FRAME_REPORT, 'dsh://plugin-boot:stalled'])
  })

  it('ignores matching page text and permanently disarms after the app shell mounts', () => {
    vi.useFakeTimers()
    const chat = createHarness('chat')
    vi.advanceTimersByTime(20_000)
    expect(chat.messages).toEqual([FRAME_REPORT])

    const harness = createHarness('splash')
    vi.advanceTimersByTime(2_000)
    harness.setState('normal')
    expect(harness.messages).toEqual([FRAME_REPORT, 'dsh://plugin-boot:ready'])

    harness.setState('splash')
    vi.advanceTimersByTime(20_000)
    expect(harness.messages).toEqual([FRAME_REPORT, 'dsh://plugin-boot:ready'])
  })

  it('reports one frame identity once the document exposes the dsh mount point', () => {
    vi.useFakeTimers()
    const harness = createHarness('mounting')

    vi.advanceTimersByTime(3_000)
    expect(harness.messages).toEqual([])

    harness.setState('splash')
    expect(harness.messages).toEqual([FRAME_REPORT])

    // 身份只申报一次；卡在 splash 时后续消息仍是原有的 stalled
    vi.advanceTimersByTime(8_000)
    expect(harness.messages).toEqual([FRAME_REPORT, 'dsh://plugin-boot:stalled'])
  })

  // issue #705：浏览器内部错误页（代理拦截、DNS 失败等）同样会触发 iframe 的 load，
  // 但永远没有 #root。脚本在这里保持沉默，宿主才能把「没收到帧身份」判成加载失败。
  it('never reports a frame identity while the frame has no dsh mount point', () => {
    vi.useFakeTimers()
    const harness = createHarness('mounting')

    vi.advanceTimersByTime(60_000)
    expect(harness.messages).toEqual([])
  })

  it('stays silent in the top-level document', () => {
    vi.useFakeTimers()
    const harness = createHarness('normal', { topFrame: true })

    vi.advanceTimersByTime(60_000)
    expect(harness.messages).toEqual([])
  })
})
