import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 「跨主/次版本升级 → 请切换档案」链路的结构契约。
 *
 * 前端不在单测里挂载组件（与 clone-profile.test.ts 同款跨层守卫），因此读源码断言结构：
 * 期望值一律取自需求本身（顺序、命令名、i18n key），不与被测实现同源。
 */
const coreSource = (): string => readFileSync(new URL('../src/ui/config/core.tsx', import.meta.url), 'utf8')
const dialogSource = (): string => readFileSync(new URL('../src/ui/dialog/core-upgrade-profile.tsx', import.meta.url), 'utf8')

/** 取组件内某个顶层函数的函数体（到该函数自己的 `\n  }` 为止，嵌套块缩进更深不会误截） */
function bodyOf(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start, marker).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.indexOf('\n  }')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('破坏性升级的判定与警告入口', () => {
  it('用「在用核心 → 目标核心」的主/次版本跨度判定，而不是只看目标版本', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')

    expect(body).toContain('isCoreMajorMinorUpgrade(')
    expect(body).toContain('cores.find(c => c.active)')
    // 判定两侧都取「版本号缺失时回落 release tag」的版本串
    expect(body).toMatch(/coreVersionKey\(activeCore\)/)
    expect(body).toMatch(/coreVersionKey\(core\)/)
  })

  it('警告弹窗的默认档案名取目标版本的主/次版本号（x.x）', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')

    expect(body).toMatch(/coreMajorMinor\(coreVersionKey\(core\)\)/)
    expect(body).toMatch(/defaultName:/)
  })

  it('破坏性升级时改弹档案警告，不再叠加普通切换确认', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')
    const upgradeIndex = body.indexOf('openUpgradeDialog')

    expect(upgradeIndex).toBeGreaterThan(-1)
    // 普通确认（core.switch_confirm_title）只能出现在 breakingUpgrade 之外的 else 分支
    const elseIndex = body.indexOf('else {', upgradeIndex)
    expect(elseIndex).toBeGreaterThan(upgradeIndex)
    expect(body.slice(upgradeIndex, elseIndex)).not.toContain('core.switch_confirm_title')
    expect(body.slice(elseIndex)).toContain('core.switch_confirm_title')
  })

  it('取消警告即中止本次切换（不落档案、不切核心）', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')
    const upgradeIndex = body.indexOf('openUpgradeDialog')
    const elseIndex = body.indexOf('else {', upgradeIndex)
    const cancelBranch = body.slice(upgradeIndex, elseIndex)

    expect(cancelBranch).toContain('silence(')
    expect(cancelBranch).toMatch(/return/)
    expect(cancelBranch).not.toContain('activate.mutateAsync')
  })

  it('「无视风险切换」保持档案不变，只切核心', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')

    // 只有选择 profile 才写入 profileName；ignore 分支不赋值 → 跳过档案切换
    expect(body).toMatch(/if \(choice\.mode === 'profile'\)\n\s*profileName = choice\.name/)
    expect(body).toMatch(/if \(profileName\) \{/)
  })
})

describe('确认后的编排顺序：档案 → 核心 → 重启', () => {
  it('先落版本档案，再切核心，最后重启', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')
    const profileIndex = body.indexOf('await activateVersionProfile(profileName)')
    const coreIndex = body.indexOf('activate.mutateAsync(core.id)')
    const restartIndex = body.indexOf('store.harness.restart()')

    expect(profileIndex).toBeGreaterThan(-1)
    expect(coreIndex).toBeGreaterThan(profileIndex)
    expect(restartIndex).toBeGreaterThan(coreIndex)
  })

  it('档案切换失败即中止，不切核心', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')
    const failureIndex = body.indexOf('core.breaking_profile_failed')
    expect(failureIndex).toBeGreaterThan(-1)

    const failureBranch = body.slice(body.lastIndexOf('catch', failureIndex), body.indexOf('try {', failureIndex))
    expect(failureBranch).toContain('core.breaking_profile_failed')
    expect(failureBranch).toMatch(/return/)
  })

  it('核心切换失败时回滚到切换前的档案', () => {
    const body = bodyOf(coreSource(), 'async function onActivate')
    const failureIndex = body.indexOf('core.switch_failed')
    expect(failureIndex).toBeGreaterThan(-1)

    const failureBranch = body.slice(body.lastIndexOf('catch', failureIndex))
    expect(failureBranch).toMatch(/await restoreActiveProfile\(previousProfileId\)/)
    // 档案本来就没换（目标档案已使用中）时不做无意义的回滚
    expect(failureBranch).toContain('previousProfileId !== switchedProfileId')
  })
})

describe('activateVersionProfile：缺失才新建，已存在只切换', () => {
  it('按后端归一化后的 id 匹配在用档案列表', () => {
    const body = bodyOf(coreSource(), 'async function activateVersionProfile')

    expect(body).toContain('invoke<Profile[]>(\'get_profiles\')')
    expect(body).toContain('normalizeProfileId(name)')
    expect(body).toMatch(/profiles\.find\(p => p\.id === id\)/)
  })

  it('已存在时切到该档案并直接返回，不再新建', () => {
    const body = bodyOf(coreSource(), 'async function activateVersionProfile')
    const existsIndex = body.indexOf('if (existing)')
    const returnIndex = body.indexOf('return { id, previousId }', existsIndex)
    const createIndex = body.indexOf('\'create_profile\'')

    expect(existsIndex).toBeGreaterThan(-1)
    expect(returnIndex).toBeGreaterThan(existsIndex)
    expect(returnIndex).toBeLessThan(createIndex)
    expect(body.slice(existsIndex, returnIndex)).toContain('invoke<Profile>(\'set_active_profile\', { id })')
  })

  it('缺失时新建并切为使用中', () => {
    const body = bodyOf(coreSource(), 'async function activateVersionProfile')

    expect(body).toContain('invoke<Profile>(\'create_profile\', { name })')
    expect(body).toContain('invoke<Profile>(\'set_active_profile\', { id: created.id })')
  })

  it('一并返回切换前的在用档案，供核心失败时回滚', () => {
    const body = bodyOf(coreSource(), 'async function activateVersionProfile')

    expect(body).toContain('profiles.find(p => p.active)?.id')
    expect(body).toMatch(/Promise<\{ id: string, previousId: string \}>/)
    expect(body).toMatch(/return \{ id: created\.id, previousId \}/)
  })
})

describe('restoreActiveProfile：回滚不掩盖原始失败', () => {
  it('切回原档案，回滚失败只记日志，并始终失效档案查询', () => {
    const body = bodyOf(coreSource(), 'async function restoreActiveProfile')

    expect(body).toContain('invoke<Profile>(\'set_active_profile\', { id })')
    expect(body).toMatch(/console\.error/)
    expect(body).toMatch(/finally \{/)
    expect(body).toContain('queryKeys.profiles')
  })
})

describe('警告对话框控件', () => {
  it('档案名 Input 默认填 x.x 且可编辑', () => {
    const source = dialogSource()

    expect(source).toMatch(/useState\(props\.defaultName\)/)
    expect(source).toMatch(/value=\{name\}/)
    expect(source).toMatch(/onChange=\{e => setName\(e\.target\.value\)\}/)
  })

  it('提供「无视风险切换」Link、取消与确认按钮', () => {
    const source = dialogSource()

    expect(source).toMatch(/core\.breaking_ignore/)
    expect(source).toMatch(/disclosure\.confirm\(\{ mode: 'ignore' \}\)/)
    expect(source).toMatch(/core\.breaking_profile_label/)
    expect(source).toMatch(/buttons\.cancel/)
    expect(source).toMatch(/buttons\.confirm/)
    expect(source).toMatch(/disclosure\.confirm\(\{ mode: 'profile', name \}\)/)
  })

  it('归一化后为空的档案名禁止确认', () => {
    const source = dialogSource()

    expect(source).toMatch(/const profileId = normalizeProfileId\(name\)/)
    expect(source).toMatch(/isDisabled=\{!profileId\}/)
  })

  it('警告文案同时给出源版本与目标版本', () => {
    expect(dialogSource()).toMatch(/core\.breaking_desc', \{ from: props\.fromVersion, to: props\.toVersion \}/)
  })

  it('warning 状态的 AlertDialog', () => {
    expect(dialogSource()).toMatch(/status="warning"/)
  })
})

describe('i18n parity', () => {
  const keys = [
    'core.breaking_title',
    'core.breaking_desc',
    'core.breaking_profile_label',
    'core.breaking_ignore',
    'core.breaking_profile_failed',
  ]

  for (const locale of ['zh-CN', 'en-US']) {
    it(`includes all core.breaking* keys in ${locale}`, () => {
      const messages = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
      for (const key of keys) {
        expect(typeof messages[key], key).toBe('string')
        expect((messages[key] as string).length, key).toBeGreaterThan(0)
      }
    })
  }
})
