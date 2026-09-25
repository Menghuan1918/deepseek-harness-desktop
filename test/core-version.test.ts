import { describe, expect, it } from 'vitest'
import { coreMajorMinor, isCoreUnsupported, isCoreUpgrade, MIN_SUPPORTED_CORE_VERSION } from '@/utils/core-version'

/**
 * issue #596：随包内置插件依赖的平台种子词自 dsh 0.1.5 起才存在，核心低于最低支持
 * 基线（0.1.5-rc.1）时 `@deepseek-ai/*` 模块在运行时模块表里不存在，插件必然加载失败
 * 并把应用卡在启动阶段。
 *
 * 后端据此回退预打包核心，前端核心面板据此标注「不兼容」并拒绝激活；这里锁住两侧
 * 共用的版本判定：低于基线为 true，等于/高于为 false，不可解析不误判。
 *
 * 兼容性只看最低支持基线，与推荐核心版本（`manifest.jsonc` 的 `engines.dsh.recommend`）无关——推荐版本
 * 高于基线、仅用于更新提示。
 */
describe('isCoreUnsupported', () => {
  it('把低于 0.1.5-rc.1 的旧版本判为不兼容', () => {
    expect(isCoreUnsupported('0.1.0-rc.7')).toBe(true)
    expect(isCoreUnsupported('0.1.2-rc.1')).toBe(true)
    expect(isCoreUnsupported('0.1.5-alpha.2')).toBe(true)
  })

  it('基线本身与更新的版本都算兼容', () => {
    expect(isCoreUnsupported(MIN_SUPPORTED_CORE_VERSION)).toBe(false)
    expect(isCoreUnsupported('0.1.5-rc.2')).toBe(false)
    expect(isCoreUnsupported('0.1.6-alpha.2')).toBe(false)
    expect(isCoreUnsupported('0.1.7-alpha.1')).toBe(false)
  })

  it('版本缺失或不可解析时不误判为不兼容', () => {
    expect(isCoreUnsupported('')).toBe(false)
    expect(isCoreUnsupported('not-a-version')).toBe(false)
  })

  it('带 dsh-/src- 前缀的 release tag 按同一基线判定', () => {
    expect(isCoreUnsupported('dsh-0.1.2-rc.1')).toBe(true)
    expect(isCoreUnsupported('src-0.1.5-rc.1')).toBe(false)
  })
})

describe('coreMajorMinor', () => {
  it('只取主/次版本号，丢掉 patch 与预发布标识', () => {
    expect(coreMajorMinor('0.17.1')).toBe('0.17')
    expect(coreMajorMinor('0.18.0-rc.1')).toBe('0.18')
    expect(coreMajorMinor('1.2.3')).toBe('1.2')
  })

  it('剥掉 dsh-/src- 前缀后再取主/次版本号', () => {
    expect(coreMajorMinor('dsh-0.1.0-rc.8-32331963388')).toBe('0.1')
    expect(coreMajorMinor('src-2.0.0')).toBe('2.0')
  })

  it('版本缺失或不可解析时为空串', () => {
    expect(coreMajorMinor('')).toBe('')
    expect(coreMajorMinor('local')).toBe('')
    expect(coreMajorMinor('app-0.1.0-rc.8')).toBe('')
  })
})

/**
 * 升到任何更新的版本都要提示「破坏性更改 → 请切换档案」：
 * patch 升级同样可能带破坏性更改（用户实测 0.1.5 → 0.1.7 未提示是漏报，见反馈）；
 * 降级、平级与不可解析版本一律放行——误报会把正常切换挡在弹窗后面。
 */
describe('isCoreUpgrade', () => {
  it('任何更新（含 patch、预发布→正式）都算升级', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.7')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '0.18.0')).toBe(true)
    expect(isCoreUpgrade('0.17.1', '1.0.0')).toBe(true)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5')).toBe(true)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.6-alpha.2')).toBe(true)
  })

  it('平级不算升级', () => {
    expect(isCoreUpgrade('0.1.5', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.1.5-rc.1', '0.1.5-rc.1')).toBe(false)
  })

  it('降级不算升级', () => {
    expect(isCoreUpgrade('0.1.7', '0.1.5')).toBe(false)
    expect(isCoreUpgrade('0.18.0', '0.17.1')).toBe(false)
    expect(isCoreUpgrade('1.0.0', '0.9.9')).toBe(false)
    expect(isCoreUpgrade('0.1.5', '0.1.5-rc.1')).toBe(false)
  })

  it('任一侧版本缺失或不可解析时不误报', () => {
    expect(isCoreUpgrade('', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('local', '0.18.0')).toBe(false)
    expect(isCoreUpgrade('0.17.1', '')).toBe(false)
    expect(isCoreUpgrade('0.17.1', 'app')).toBe(false)
  })

  it('带 dsh-/src- 前缀的 release tag 按同一版本判定', () => {
    expect(isCoreUpgrade('dsh-0.1.5-rc.8-1', 'src-0.1.7')).toBe(true)
  })
})
