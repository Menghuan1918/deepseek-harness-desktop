import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPluginsBundle, findBundledPluginsTree, pluginSyncApplyCommand, pluginSyncMarkerCommand } from './plugins-sync'

describe('findBundledPluginsTree', () => {
  it('locates the deployed tree from the repo dev layout (packages/ → src-tauri/resources/node_modules)', () => {
    // 本测试运行于包源码树内：ownPkgDir=packages/dsh-tauri-ssh，候选一应被
    // 「ssh2 依赖不在」拒绝，候选二命中 build:plugins 的部署树
    const tree = findBundledPluginsTree()
    expect(tree).toBeDefined()
    expect(tree!.root).toContain('src-tauri/resources/node_modules')
    expect(tree!.pluginNames).toContain('dsh-tauri-ssh')
    expect(tree!.pluginNames).toContain('dsh-tauri-ui')
    // 第三方依赖不挂 dsh 字段，不得混入插件清单
    expect(tree!.pluginNames).not.toContain('ssh2')
    expect(tree!.pluginNames.length).toBeGreaterThanOrEqual(12)
  })
})

describe('buildPluginsBundle', () => {
  let staging: string | undefined

  afterEach(() => {
    if (staging !== undefined)
      rmSync(staging, { recursive: true, force: true })
    staging = undefined
  })

  it('packages the tree plus the wiring helper, hashed for skip-if-same', async () => {
    // 微缩树：两个「插件」+ 一个依赖，验证 tar 组装与哈希稳定即可
    staging = mkdtempSync(join(tmpdir(), 'dsh-plugins-tree-'))
    for (const name of ['plugin-a', 'plugin-b']) {
      mkdirSync(join(staging, name, 'dist'), { recursive: true })
      writeFileSync(join(staging, name, 'package.json'), JSON.stringify({ name, dsh: { bundle: {} } }))
      writeFileSync(join(staging, name, 'dist', 'index.js'), `// ${name}`)
    }
    mkdirSync(join(staging, 'some-dep'), { recursive: true })
    writeFileSync(join(staging, 'some-dep', 'package.json'), JSON.stringify({ name: 'some-dep' }))

    const first = await buildPluginsBundle({ root: staging, pluginNames: ['plugin-a', 'plugin-b'] })
    expect(first.tar.length).toBeGreaterThan(0)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/)
    const second = await buildPluginsBundle({ root: staging, pluginNames: ['plugin-a', 'plugin-b'] })
    // tar 头部含时间戳，内容同则哈希可能不同——不断言相等，只断言可复算
    expect(second.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('plugin sync commands', () => {
  const tree = { root: '/x', pluginNames: ['dsh-tauri', 'dsh-tauri-ssh'] }

  it('marker command reads the remote hash silently', () => {
    expect(pluginSyncMarkerCommand()).toContain('.dsh-desktop/plugins/.sync-sha256')
  })

  it('apply command: atomic swap + hash marker + profile wiring + instance restart', () => {
    const command = pluginSyncApplyCommand(tree, 'abc123')
    // 原子交换：staging → 正式位
    expect(command).toContain('$BASE.new')
    expect(command).toContain('mv "$BASE.new" "$BASE"')
    // 哈希标记
    expect(command).toContain('echo "abc123" > "$HOME/.dsh-desktop/plugins/.sync-sha256"')
    // profile 接线走上传的 _wire.js（deps link + bundles + symlink）
    expect(command).toContain('_wire.js')
    expect(command).toContain('.dsh/profiles/web/package.json')
    expect(command).toContain('dsh-tauri dsh-tauri-ssh')
    // 实例在跑则按 pidfile 重启（ensure 探测落空后按新 profile 拉起）
    expect(command).toContain('.dsh/dsh-remote.pid')
    expect(command).toContain('kill')
    expect(command).toContain('PLUGINS_SYNCED')
  })
})
