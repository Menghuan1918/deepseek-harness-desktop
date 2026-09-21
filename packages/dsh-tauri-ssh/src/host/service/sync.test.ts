import type { SshExecResult, SshSession } from './transport'
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_REMOTE_PROFILE } from '../storage/index'
import { MachineId } from '../types/index'
import { layoutNodeBinary } from './bootstrap'
import { buildPreview, classifySpec, pluginAddCommand, skillExtractCommand, SyncEngine } from './sync'

/** A scripted SSH session: commands dispatched by order or by matcher. */
function fakeSession(respond: (command: string, options?: { stdinData?: Buffer }) => SshExecResult): SshSession & { execSpy: ReturnType<typeof vi.fn>, closed: () => boolean } {
  let open = true
  const execSpy = vi.fn(async (command: string, options?: { stdinData?: Buffer }) => respond(command, options))
  return {
    execSpy,
    exec: execSpy as unknown as SshSession['exec'],
    openTunnel: () => Promise.reject(new Error('not needed')),
    onClosed: () => {},
    close: async () => {
      open = false
    },
    closed: () => !open,
  }
}

const ok = (stdout = ''): SshExecResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): SshExecResult => ({ code: 1, stdout: '', stderr })

describe('classifySpec', () => {
  it('accepts remotely installable specs', () => {
    expect(classifySpec('github:omdsh-dev/dsh-market').syncable).toBe(true)
    expect(classifySpec('git+https://github.com/a/b.git').syncable).toBe(true)
    expect(classifySpec('git@github.com:a/b.git').syncable).toBe(true)
    expect(classifySpec('^0.3.0').syncable).toBe(true)
    expect(classifySpec('0.16.0').syncable).toBe(true)
    expect(classifySpec(' latest ').syncable).toBe(true)
  })

  it('rejects local-path and URL specs with reasons', () => {
    const local = classifySpec('link:/path/to/plugin')
    expect(local.syncable).toBe(false)
    expect(local.reason).toContain('local-path')
    expect(classifySpec('file:../local').reason).toContain('local-path')
    const url = classifySpec('https://example.com/x.tgz')
    expect(url.syncable).toBe(false)
    expect(url.reason).toContain('URL')
    expect(classifySpec('').reason).toContain('empty')
  })
})

describe('buildPreview', () => {
  it('lists profile dependencies minus core packages, each with a verdict', () => {
    const preview = buildPreview(
      {
        'zz-plugin': 'github:a/b',
        'aa-plugin': '^1.0.0',
        '@deepseek-ai/dsh-client-runtime': '^0.1.0',
        'local-plugin': 'link:../local',
      },
      [],
    )
    expect(preview.plugins.map(plugin => plugin.name)).toEqual(['aa-plugin', 'local-plugin', 'zz-plugin'])
    expect(preview.plugins[2]).toMatchObject({ syncable: true })
    expect(preview.plugins[1]).toMatchObject({ syncable: false, reason: expect.stringContaining('local-path') })
  })

  it('lists skills per root in name order', () => {
    const preview = buildPreview({}, [
      { root: 'dsh', names: ['beta', 'alpha'] },
      { root: 'agents', names: ['zeta'] },
    ])
    expect(preview.skills).toEqual([
      { name: 'alpha', root: 'dsh' },
      { name: 'beta', root: 'dsh' },
      { name: 'zeta', root: 'agents' },
    ])
  })
})

describe('command builders', () => {
  it('runs the layout entry under the layout node, both quoted', () => {
    expect(pluginAddCommand('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js', 'github:a/b'))
      .toBe(`"$HOME/.dsh-desktop/runtime/bin/node" '/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js' plugin --profile '${DEFAULT_REMOTE_PROFILE}' add 'github:a/b'`)
    expect(pluginAddCommand('/home/u/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', 'pkg@^1.0.0'))
      .toBe(`${layoutNodeBinary()} '/home/u/.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' plugin --profile '${DEFAULT_REMOTE_PROFILE}' add 'pkg@^1.0.0'`)
  })

  it('installs into the machine profile it is handed, quoted', () => {
    // 隧道只服务这台机器自己的档案：装到别处（历史上的硬编码 web）等于没同步
    expect(pluginAddCommand('/x/bin.js', 'github:a/b', 'work'))
      .toBe(`${layoutNodeBinary()} '/x/bin.js' plugin --profile 'work' add 'github:a/b'`)
  })

  it('extracts the streamed tarball into the remote skill home', () => {
    expect(skillExtractCommand()).toBe(`mkdir -p "$HOME/.dsh/skills" && tar -xf - -C "$HOME/.dsh/skills"`)
  })
})

describe('syncEngine.apply', () => {
  const machine = MachineId('m1')

  it('returns per-item successes when everything lands', async () => {
    const session = fakeSession((command) => {
      // The entry probe is the only command carrying a printf.
      if (command.includes('printf'))
        return ok('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js\n')
      return ok()
    })
    const packSkills = vi.fn(async () => Buffer.from('TARDATA'))
    const openSession = vi.fn(async () => session)
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills,
      openSession,
    })
    const result = await sync.apply(machine, [{ name: 'p1', spec: 'github:a/b' }], [{ name: 'alpha', root: 'dsh' }])
    expect(result.items).toEqual([
      { kind: 'plugin', name: 'p1', ok: true },
      { kind: 'skill', name: 'alpha', root: 'dsh', ok: true },
    ])
    // The tarball rode the command's stdin, never the command line.
    const extract = session.execSpy.mock.calls.find(([command]) => command.includes('tar -xf')) as [string, { stdinData?: Buffer }]
    expect(extract[1]?.stdinData?.toString()).toBe('TARDATA')
    expect(extract[0]).not.toContain('TARDATA')
    expect(packSkills).toHaveBeenCalledWith('/root/skills', ['alpha'])
    expect(session.closed()).toBe(true)
  })

  it('reports partial plugin failures per item with the output tail', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/home/u/.dsh-desktop/dependencies/dsh/lib/bin.js\n')
      return command.includes('bad-pkg') ? fail('ERR_PNPM_NO_MATCH') : ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(
      machine,
      [
        { name: 'good', spec: 'github:a/good' },
        { name: 'bad', spec: 'npm:bad-pkg' },
      ],
      [],
    )
    expect(result.items[0]).toMatchObject({ kind: 'plugin', name: 'good', ok: true })
    expect(result.items[1]).toMatchObject({ kind: 'plugin', name: 'bad', ok: false, error: expect.stringContaining('ERR_PNPM_NO_MATCH') })
    expect(result.items[1]?.error).toContain('exit 1')
  })

  it('fails every plugin item when the remote has no dsh entry', async () => {
    const session = fakeSession(() => ok('\n'))
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ ok: false, error: expect.stringContaining('no dsh entry') })
  })

  it('marks unknown skills and local pack failures without touching the remote', async () => {
    const session = fakeSession(() => ok())
    const packSkills = vi.fn(async () => {
      throw new Error('tar failed: disk full')
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills,
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [], [
      { name: 'ghost', root: 'dsh' },
      { name: 'alpha', root: 'dsh' },
    ])
    expect(result.items[0]).toMatchObject({ kind: 'skill', name: 'ghost', ok: false, error: expect.stringContaining('not found') })
    expect(result.items[1]).toMatchObject({ kind: 'skill', name: 'alpha', ok: false, error: 'tar failed: disk full' })
    // Nothing reached the remote: every extract carried no stdin payload failure path.
    expect(session.execSpy.mock.calls.some(([command]) => command.includes('tar -xf'))).toBe(false)
  })

  it('reports a remote extract failure on every skill of that root', async () => {
    const session = fakeSession((command) => {
      if (command.includes('tar -xf'))
        return fail('cannot write: read-only file system')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha', 'beta'] }],
      packSkills: async () => Buffer.from('TAR'),
      openSession: async () => session,
    })
    const result = await sync.apply(machine, [], [
      { name: 'alpha', root: 'dsh' },
      { name: 'beta', root: 'dsh' },
    ])
    expect(result.items).toHaveLength(2)
    for (const item of result.items) {
      expect(item.ok).toBe(false)
      expect(item.error).toContain('read-only file system')
    }
  })

  it('dedupes repeated selections and skips the session for an empty selection', async () => {
    const session = fakeSession(() => ok('/dsh\n'))
    const openSession = vi.fn(async () => session)
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [{ root: 'dsh', dir: '/root/skills', names: ['alpha'] }],
      packSkills: async () => Buffer.alloc(0),
      openSession,
    })
    const empty = await sync.apply(machine, [], [])
    expect(empty.items).toEqual([])
    expect(openSession).not.toHaveBeenCalled()

    const deduped = await sync.apply(
      machine,
      [{ name: 'p', spec: 'github:a/b' }, { name: 'p again', spec: 'github:a/b' }],
      [{ name: 'alpha', root: 'dsh' }, { name: 'alpha', root: 'dsh' }],
    )
    expect(deduped.items).toHaveLength(2)
  })

  it('installs plugins into the profile the options name', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    await sync.apply(machine, [{ name: 'p', spec: 'github:a/b' }], [], { profileName: 'work' })
    const add = session.execSpy.mock.calls.map(([command]) => command).find(command => command.includes('plugin --profile'))
    expect(add).toContain('--profile \'work\' add')
  })

  it('announces each item before it runs, 1-based and deduped, skills batched by root', async () => {
    const session = fakeSession((command) => {
      if (command.includes('printf'))
        return ok('/dsh\n')
      return ok()
    })
    const sync = new SyncEngine({
      profileDependencies: () => ({}),
      scanSkills: () => [
        { root: 'dsh', dir: '/root/dsh-skills', names: ['alpha', 'beta'] },
        { root: 'agents', dir: '/root/agent-skills', names: ['gamma'] },
      ],
      packSkills: async () => Buffer.alloc(0),
      openSession: async () => session,
    })
    const seen: string[] = []
    await sync.apply(
      machine,
      [{ name: 'p1', spec: 'github:a/b' }, { name: 'p1 dup', spec: 'github:a/b' }, { name: 'p2', spec: '^1.0.0' }],
      [{ name: 'alpha', root: 'dsh' }, { name: 'beta', root: 'dsh' }, { name: 'ghost', root: 'dsh' }, { name: 'gamma', root: 'agents' }],
      { onItem: (position, total, name) => seen.push(`${position}/${total}:${name}`) },
    )
    // 去重后 2 插件 + 4 skill；ghost 在本地校验出局（不公告但照样结算），
    // 每个 root 的 skill 共用一份 tar，故只公告批首那条。
    expect(seen).toEqual(['1/6:p1', '2/6:p2', '4/6:alpha', '6/6:gamma'])
  })
})
