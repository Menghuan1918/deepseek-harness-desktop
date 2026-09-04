import type { MachineProfile } from '../types/index.js'
import type { RemoteInstallPlan } from './bootstrap.js'
import type { SshExecOptions, SshExecResult, SshSession } from './transport.js'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineId } from '../types/index.js'
import {
  buildInstallScript,
  bundleProbeCommand,
  checkMissingCommand,
  credentialsCopyCommand,
  describeExecFailure,
  ensureRemoteInstance,
  firstLineOf,
  missingComponentsOf,
  parseBootstrapLine,
  planRemoteInstall,
  readEnvCredentials,
  REMOTE_ROOT,
  rootProbeCommand,
  splitBundleProbeStdout,
  startCommandFor,
} from './bootstrap.js'

const profile: MachineProfile = {
  id: MachineId('m1'),
  name: 'alpha',
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  remotePort: 3080,
}

/** A realistic newest-first release list matching the live pkg repository. */
const RELEASES = [
  { tag: 'dsh-0.2.0-preview.1-32490000001', prerelease: true },
  { tag: 'dsh-0.1.2-rc.1-33729514615', prerelease: false },
  { tag: 'dsh-0.1.1-rc.1-32342588166', prerelease: false },
]

const PKG_REPO = 'dsh-tauri-desk/deepseek-harness-pkg'

/** The GitHub assets the linux-x64 zip release carries. */
const LINUX_ASSETS = [
  {
    name: 'deepseek-harness-pkg-linux.zip',
    url: `https://github.com/${PKG_REPO}/releases/download/dsh-0.1.2-rc.1-33729514615/deepseek-harness-pkg-linux.zip`,
    digest: 'sha256:6b7ecfebe3b7d779b459262943b17777427860f1b96dbf3b6f16a5074b1119a7',
  },
]

/** The default injected fetchers (no network): a healthy metadata view. */
function healthyFetchers(overrides: Partial<{
  listReleases: () => Promise<typeof RELEASES>
  listAssets: () => Promise<typeof LINUX_ASSETS>
  npmDist: () => Promise<{ url: string, mirrorUrl: string, integrity?: string }>
}> = {}) {
  return {
    listReleases: () => Promise.resolve(RELEASES),
    listAssets: () => Promise.resolve(LINUX_ASSETS),
    npmDist: () => Promise.resolve({
      url: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
      mirrorUrl: 'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
      integrity: 'sha512-ZXhhZQ==',
    }),
    ...overrides,
  }
}

class FakeSession implements SshSession {
  commands: string[] = []

  constructor(private readonly responder: (command: string, index: number) => SshExecResult) {}

  exec(command: string, _options?: SshExecOptions): Promise<SshExecResult> {
    this.commands.push(command)
    return Promise.resolve(this.responder(command, this.commands.length - 1))
  }

  openTunnel(): Promise<never> {
    throw new Error('unused')
  }

  onClosed(): void {}

  close(): Promise<void> {
    return Promise.resolve()
  }
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-bootstrap-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseBootstrapLine', () => {
  it('splits stage-tagged markers and demotes untagged lines', () => {
    expect(parseBootstrapLine('::dsh download https://example.test/a')).toEqual({
      stage: 'download',
      line: 'https://example.test/a',
    })
    expect(parseBootstrapLine('::dsh failed checksum mismatch: x')).toEqual({
      stage: 'failed',
      line: 'checksum mismatch: x',
    })
    expect(parseBootstrapLine('random tool output')).toEqual({ stage: 'install', line: 'random tool output' })
  })
})

describe('planRemoteInstall', () => {
  it('pins the recommended release for linux x64 with its trusted digest', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    expect(plan.os).toBe('linux')
    expect(plan.arch).toBe('x64')
    expect(plan.dsh.kind).toBe('pkg-zip')
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.2-rc.1-33729514615')
    expect(plan.dsh.digest).toBe(LINUX_ASSETS[0]?.digest)
    expect(plan.dsh.urls[0]).toBe(LINUX_ASSETS[0]?.url)
    expect(plan.dsh.urls[1]).toContain('ghfast.top/')
    expect(plan.dshEntry).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(plan.dshVersion).toBe('0.1.2-rc.1')
    expect(plan.notes).toEqual([])
  })

  it('resolves the arm64 npm asset with its packument integrity', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers())
    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind === 'npm-tgz') {
      expect(plan.dsh.urls).toEqual([
        'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
        'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz',
      ])
      expect(plan.dsh.integrity).toBe('sha512-ZXhhZQ==')
    }
    expect(plan.dshEntry).toBe('lib/bin.js')
    expect(plan.node.urls[0]).toBe('https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-arm64.tar.gz')
  })

  it('derives deterministic URLs and notes skipped verification when metadata fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listAssets: () => Promise.reject(new Error('rate limited')),
    }))
    expect(plan.dsh.kind).toBe('pkg-zip')
    expect(plan.notes.join('\n')).toContain('资产元数据获取失败')
    expect(plan.notes.join('\n')).toContain('跳过 SHA-256 校验')
    if (plan.dsh.kind === 'pkg-zip')
      expect(plan.dsh.urls[0]).toBe(LINUX_ASSETS[0]?.url)
  })

  it('derives deterministic npm URLs when the registry view fails', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers({
      npmDist: () => Promise.reject(new Error('offline')),
    }))
    expect(plan.dsh.kind).toBe('npm-tgz')
    if (plan.dsh.kind === 'npm-tgz')
      expect(plan.dsh.urls[0]).toBe('https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz')
    expect(plan.notes.join('\n')).toContain('未取得')
  })

  it('falls back to the known stable tag when the release listing fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listReleases: () => Promise.reject(new Error('offline')),
    }))
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.2-rc.1-33729514615')
    expect(plan.notes.join('\n')).toContain('release 列表获取失败')
  })

  it('honors a configured pin and a custom release repository', async () => {
    const repos: string[] = []
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {
      installRepo: 'https://github.com/my-org/deepseek-harness-pkg.git',
      installRef: '0.1.1-rc.1',
    }, {
      listReleases: (repo) => {
        repos.push(repo)
        return Promise.resolve(RELEASES)
      },
      listAssets: () => Promise.resolve(LINUX_ASSETS),
      npmDist: () => Promise.reject(new Error('unused')),
    })
    expect(repos).toEqual(['my-org/deepseek-harness-pkg'])
    if (plan.dsh.kind !== 'pkg-zip')
      throw new Error('expected pkg-zip')
    expect(plan.dsh.tag).toBe('dsh-0.1.1-rc.1-32342588166')
  })

  it('rejects platforms outside the matrix before any network use', async () => {
    const fetchers = {
      listReleases: (): Promise<typeof RELEASES> => {
        throw new Error('must not be called')
      },
      listAssets: (): Promise<typeof LINUX_ASSETS> => {
        throw new Error('must not be called')
      },
      npmDist: (): Promise<never> => {
        throw new Error('must not be called')
      },
    }
    await expect(planRemoteInstall('MINGW64_NT-10.0-19045 x86_64', {}, fetchers)).rejects.toThrow(/REMOTE_PLATFORM_UNSUPPORTED/)
  })
})

describe('buildInstallScript', () => {
  it('embeds the plan: URLs, digests, entries, and the cleanup trap', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const script = buildInstallScript(plan)
    expect(script).toContain('https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
    expect(script).toContain('https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-linux-x64.tar.gz')
    expect(script).toContain('https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz')
    expect(script).toContain(LINUX_ASSETS[0]?.url ?? '')
    expect(script).toContain('sha256:6b7ecfebe3b7d779b459262943b17777427860f1b96dbf3b6f16a5074b1119a7')
    expect(script).toContain('trap cleanup EXIT')
    expect(script).toContain('checksum mismatch')
    expect(script).toContain('unzip -q -o')
    expect(script).not.toContain('pnpm install')
  })

  it('arm64: assembles node_modules on the remote with registry fallback', async () => {
    const plan = await planRemoteInstall('Linux 5.15 aarch64', {}, healthyFetchers())
    const script = buildInstallScript(plan)
    expect(script).toContain('https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz')
    expect(script).toContain('sha512-ZXhhZQ==')
    expect(script).toContain('install --prod --silent --registry')
    expect(script).toContain('"$ROOT/dependencies/pnpm/bin/pnpm.cjs"')
    expect(script).toContain('https://registry.npmmirror.com')
    // The tarball path extracts with tar; the zip helper stays uncalled.
    expect(script).not.toContain('extract_zip "$TMP/dsh')
  })
})

describe('install script execution (real POSIX sh)', () => {
  /**
   * Run one generated script under the real `sh` inside a sandboxed HOME,
   * with a fake `curl` first on PATH that "downloads" tampered bytes and a
   * SHASUMS256.txt pinning a digest those bytes cannot match.
   */
  function runScript(script: string, sandbox: string): Promise<{ code: number, stdout: string, stderr: string }> {
    const binDir = join(sandbox, 'fake-bin')
    mkdirSync(binDir, { recursive: true })
    const fakeCurl = join(binDir, 'curl')
    writeFileSync(fakeCurl, [
      '#!/bin/sh',
      'dst=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then dst="$arg"; fi',
      '  prev="$arg"',
      'done',
      'url=""',
      'for arg in "$@"; do url="$arg"; done',
      'case "$url" in',
      '  *SHASUMS256.txt)',
      '    printf \'%s  %s\\n\' deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef node-v22.22.0-linux-x64.tar.gz > "$dst"',
      '    ;;',
      '  *)',
      '    printf \'tampered-download-bytes\' > "$dst"',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    chmodSync(fakeCurl, 0o755)
    const scriptPath = join(sandbox, 'install.sh')
    writeFileSync(scriptPath, script)
    const run = promisify(execFile)
    return run('sh', [scriptPath], {
      env: { ...process.env, HOME: sandbox, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number, stdout?: string, stderr?: string }) =>
        ({ code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
    )
  }

  it('aborts and cleans half-products when the SHA-256 mismatches (tampered asset)', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers({
      listAssets: () => Promise.resolve(LINUX_ASSETS),
    }))
    const sandbox = tempDir()
    const outcome = await runScript(buildInstallScript(plan), sandbox)
    // The node tarball's digest cannot match the tampered download: the run
    // must abort before installing anything and the trap must clean up.
    expect(outcome.code).toBe(11)
    expect(outcome.stdout).toContain('::dsh failed checksum mismatch')
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'runtime'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'tmp'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'runtime.new'))).toBe(false)
    expect(existsSync(join(sandbox, REMOTE_ROOT, 'dependencies', 'dsh'))).toBe(false)
  })

  it('skips every section when the three components are already installed', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const sandbox = tempDir()
    const root = join(sandbox, REMOTE_ROOT)
    mkdirSync(join(root, 'runtime', 'bin'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'bin', 'node'), 'placeholder')
    chmodSync(join(root, 'runtime', 'bin', 'node'), 0o755)
    mkdirSync(join(root, 'dependencies', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'), 'placeholder')
    mkdirSync(join(root, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(root, 'dependencies', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'placeholder')
    const outcome = await runScript(buildInstallScript(plan), sandbox)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('node 已就绪')
    expect(outcome.stdout).toContain('pnpm 已就绪')
    expect(outcome.stdout).toContain('dsh 已就绪')
    expect(outcome.stdout).toContain('远端初始化完成')
    expect(outcome.stdout).not.toContain('::dsh download')
    expect(existsSync(join(root, 'tmp'))).toBe(false)
  })
})

describe('component probe and launch commands', () => {
  it('lists the missing components of the remote layout', () => {
    const command = checkMissingCommand()
    expect(command).toContain('.dsh-desktop')
    expect(command).toContain('"$ROOT/runtime/bin/node"')
    expect(command).toContain('"$ROOT/dependencies/pnpm/bin/pnpm.cjs"')
    expect(command).toContain('"$ROOT/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"')
    expect(missingComponentsOf('node\ndsh\n')).toEqual(['node', 'dsh'])
    expect(missingComponentsOf('')).toEqual([])
    expect(missingComponentsOf('node\njunk\npnpm\n')).toEqual(['node', 'pnpm'])
  })

  it('builds the layout launch: pinned port, pid file, detached, log redirect', async () => {
    const plan = await planRemoteInstall('Linux 6.8 x86_64', {}, healthyFetchers())
    const command = startCommandFor(profile, plan)
    expect(command).toContain('.dsh-desktop/runtime/bin/node')
    expect(command).toContain('.dsh-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(command).toContain('.dsh-remote.pid')
    expect(command).toContain('--host 127.0.0.1')
    expect(command).toContain(`--port "$4"`)
    expect(command).toContain('DSH_WEB_PORT=3080')
    expect(command).toContain('--no-open')
    expect(command).toContain('REMOTE_NOT_INSTALLED')
    expect(command).toContain('dsh-remote-web.log')
  })

  it('keeps the profile startCommand override untouched', () => {
    const overridden: MachineProfile = { ...profile, startCommand: 'my-launcher web --port 4000' }
    expect(startCommandFor(overridden))
      .toBe('mkdir -p "$HOME/.dsh" && ( my-launcher web --port 4000 >>"$HOME/.dsh/dsh-remote-web.log" 2>&1 < /dev/null & ) &')
  })
})

describe('health probes', () => {
  it('builds the root probe and the bundle probe', () => {
    expect(rootProbeCommand(3080, 2500)).toBe('curl -s -m 3 http://127.0.0.1:3080/')
    expect(bundleProbeCommand('http://127.0.0.1:3080/plugins/x/client.js', 2500))
      .toBe('curl -s -m 3 -w \'\\n%{http_code}\' \'http://127.0.0.1:3080/plugins/x/client.js\'')
  })

  it('splits a bundle probe answer into body and status', () => {
    expect(splitBundleProbeStdout('console.log(1)\n200')).toEqual({ body: 'console.log(1)', status: 200 })
    expect(splitBundleProbeStdout('404\n')).toEqual({ body: '', status: 404 })
    expect(splitBundleProbeStdout('<!doctype html>\n200')).toEqual({ body: '<!doctype html>', status: 200 })
    expect(splitBundleProbeStdout('garbage')).toEqual({ body: 'garbage', status: 0 })
  })
})

describe('credentials', () => {
  it('reads the DEEPSEEK keys from a dsh .env document', () => {
    const dir = tempDir()
    const env = join(dir, '.env')
    writeFileSync(env, 'OTHER=1\nDEEPSEEK_API_KEY=sk-test-123\nDEEPSEEK_BASE_URL=https://api.example.com\n')
    expect(readEnvCredentials(env)).toEqual({
      apiKey: 'sk-test-123',
      baseUrl: 'https://api.example.com',
    })
  })

  it('strips surrounding quotes and treats blank keys as absent', () => {
    const dir = tempDir()
    const env = join(dir, '.env')
    writeFileSync(env, 'DEEPSEEK_API_KEY="sk-quoted"\nDEEPSEEK_BASE_URL=\n')
    expect(readEnvCredentials(env)).toEqual({ apiKey: 'sk-quoted' })
  })

  it('reports no credentials for a missing document', () => {
    expect(readEnvCredentials(join(tempDir(), 'nope.env'))).toEqual({})
  })

  it('writes credentials into the remote .env without clobbering an existing key', () => {
    const command = credentialsCopyCommand({ apiKey: 'sk-\'quoted\'', baseUrl: 'https://api.example.com' })
    expect(command).toContain(`printf 'DEEPSEEK_API_KEY=%s\\n' 'sk-'\\''quoted'\\'''`)
    expect(command).toContain('DEEPSEEK_BASE_URL')
    expect(command).toContain('grep -q \'^DEEPSEEK_API_KEY=\'')
    expect(command).toContain('echo copied')
    expect(command).toContain('echo existing')
    expect(command).toContain('umask 077')
  })
})

/** A boot page the bundle probe answers with real JavaScript. */
const BOOT_HTML = [
  '<html><head>',
  '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=1"></script>',
  '</head><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>',
].join('')

const BOOTSTRAP = {
  config: {},
  healthCheckTimeoutMs: 1000,
  healthPollIntervalMs: 5,
  healthPollAttempts: 3,
}

function plannerOf(plan: RemoteInstallPlan) {
  return async (): Promise<RemoteInstallPlan> => plan
}

describe('ensureRemoteInstance', () => {
  it('is satisfied immediately when the boot manifest answers with a real bundle', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return { code: 0, stdout: BOOT_HTML, stderr: '' }
    })
    const events: Array<{ stage: string, line: string, terminal?: string }> = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line, options) => events.push({ stage, line, ...options?.terminal === undefined ? {} : { terminal: options.terminal } }),
    })).resolves.toBe('10.0.0.1:3080')
    expect(session.commands).toHaveLength(2)
    expect(events).toEqual([{ stage: 'ready', line: expect.stringContaining('已就绪'), terminal: 'success' }])
  })

  it('falls back to the legacy any-response verdict when the HTML carries no manifest', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('/dev/null'))
        return { code: 0, stdout: '200', stderr: '' }
      return { code: 0, stdout: '<html>an old instance without a boot graph</html>', stderr: '' }
    })
    const events: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => events.push(`${stage}: ${line}`),
    })).resolves.toBe('10.0.0.1:3080')
    expect(events[0]).toContain('旧探测兜底')
    expect(events[0]).toContain('root answered 200')
  })

  it('bootstraps a fresh machine end to end: probe → install → launch → ready', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    let started = false
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: 'node\ndsh\npnpm\n', stderr: '' }
      if (command.includes('trap cleanup EXIT'))
        return { code: 0, stdout: '::dsh install 远端初始化完成', stderr: '' }
      if (command.includes('dsh-remote.pid')) {
        started = true
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      // Readiness probes: refused until the launch, manifest-healthy after.
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return started
        ? { code: 0, stdout: BOOT_HTML, stderr: '' }
        : { code: 7, stdout: '', stderr: 'refused' }
    })
    const events: Array<{ stage: string, line: string, terminal?: string, reason?: string }> = []
    const phases: unknown[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onProgress: progress => phases.push(progress),
      onEvent: (stage, line, options) => events.push({ stage, line, ...options ?? {} }),
    }, plannerOf(plan))).resolves.toBe('10.0.0.1:3080')
    const kinds = events.map(event => event.stage)
    expect(kinds).toEqual(['probe', 'probe', 'probe', 'launch', 'ready'])
    expect(events[0]?.line).toContain('探测远端平台')
    expect(events[1]?.line).toContain('linux/x64')
    expect(events[2]?.line).toContain('缺失组件: node, dsh, pnpm')
    expect(events[4]?.terminal).toBe('success')
    expect(phases).toEqual([{ phase: 'starting' }, { phase: 'probing', attempt: 1, total: 3 }])
    expect(session.commands.some(command => command.includes('https://nodejs.org/dist/'))).toBe(true)
  })

  it('skips the install when the three components are already present', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    let started = false
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid')) {
        started = true
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      }
      if (command.includes('-w'))
        return { code: 0, stdout: 'console.log(1)\n200', stderr: '' }
      return started
        ? { code: 0, stdout: BOOT_HTML, stderr: '' }
        : { code: 7, stdout: '', stderr: '' }
    })
    const events: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => events.push(`${stage}: ${line}`),
    }, plannerOf(plan))).resolves.toBe('10.0.0.1:3080')
    expect(events.some(entry => entry.includes('三件套已就绪，跳过安装'))).toBe(true)
    expect(session.commands.some(command => command.includes('trap cleanup EXIT'))).toBe(false)
  })

  it('records the terminal failure and reason when the install script fails', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: 'node\n', stderr: '' }
      if (command.includes('trap cleanup EXIT'))
        return { code: 11, stdout: '::dsh failed checksum mismatch: node.tar.gz', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: Array<{ line: string, terminal?: string, reason?: string }> = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line, options) => {
        if (stage === 'failed')
          failures.push({ line, ...options ?? {} })
      },
    }, plannerOf(plan))).rejects.toThrow(/install failed on remote/)
    expect(failures[0]?.terminal).toBe('failed')
    expect(failures[0]?.reason).toContain('checksum mismatch')
  })

  it('reports unsupported platforms as a terminal failure', async () => {
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'MINGW64_NT-10.0-19045 x86_64\n', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: string[] = []
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {
      onEvent: (stage, line) => {
        if (stage === 'failed')
          failures.push(line)
      },
    })).rejects.toThrow(/REMOTE_PLATFORM_UNSUPPORTED/)
    expect(failures).toHaveLength(1)
  })

  it('fails loud with fallback details when the instance never becomes ready', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('tail'))
        return { code: 0, stdout: 'err1\nerr2\nerr3\nerr4\nerr5\nerr6', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 0, stdout: '远端实例已拉起', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    const failures: Array<{ reason?: string, terminal?: string }> = []
    await expect(ensureRemoteInstance(session, profile, {
      ...BOOTSTRAP,
      healthPollAttempts: 2,
    }, {
      onEvent: (_stage, _line, options) => {
        if (options?.terminal === 'failed')
          failures.push({ terminal: options.terminal, ...options.reason === undefined ? {} : { reason: options.reason } })
      },
    }, plannerOf(plan))).rejects.toThrow(/did not become ready.*fallback probe: root no answer.*err2 \| err3 \| err4 \| err5 \| err6/)
    expect(failures[0]?.terminal).toBe('failed')
  })

  it('surfaces REMOTE_NOT_INSTALLED when the launch finds an incomplete runtime', async () => {
    const plan = await planRemoteInstall('Linux 6.8.0-45-generic x86_64', {}, healthyFetchers())
    const session = new FakeSession((command) => {
      if (command === 'uname -srm')
        return { code: 0, stdout: 'Linux 6.8.0-45-generic x86_64\n', stderr: '' }
      if (command.includes('echo node'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('dsh-remote.pid'))
        return { code: 1, stdout: 'REMOTE_NOT_INSTALLED: 远端三件套未安装完整', stderr: '' }
      return { code: 7, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, BOOTSTRAP, {}, plannerOf(plan)))
      .rejects
      .toThrow(/REMOTE_NOT_INSTALLED/)
  })

  it('summarizes a failed command for operators', () => {
    expect(describeExecFailure(1, 'sh: dsh: not found\n')).toBe('exit 1: sh: dsh: not found')
    expect(describeExecFailure(null, '  ')).toBe('exit ?')
  })

  it('takes the first non-empty line of a probe result', () => {
    expect(firstLineOf('ok\nother\n')).toBe('ok')
    expect(firstLineOf('\n  \nok')).toBe('ok')
    expect(firstLineOf('')).toBe('')
  })
})
