import type { MachineProfile } from '../types/index.js'
import type { SshExecOptions, SshExecResult, SshSession } from './transport.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MachineId } from '../types/index.js'
import {
  credentialsCopyCommand,
  defaultStartCommand,
  describeExecFailure,
  DshMissingError,
  ensureRemoteInstance,
  firstLineOf,
  healthCheckCommand,
  installCommandFor,
  OFFICIAL_INSTALL_REPO,
  probeDshCommand,
  readEnvCredentials,
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

/** The dsh-path answer a remote probe would print. */
const RESOLVED_DSH = '/usr/local/bin/dsh'

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

describe('remote instance commands', () => {
  it('builds the default start command from the profile port', () => {
    expect(defaultStartCommand(profile)).toBe('dsh web --host 127.0.0.1 --port 3080')
  })

  it('honors the profile startCommand override and ensures the log directory', () => {
    const overridden: MachineProfile = { ...profile, startCommand: 'dsh web --port 4000' }
    expect(startCommandFor(overridden))
      .toBe('mkdir -p "$HOME/.dsh" && ( dsh web --port 4000 >>"$HOME/.dsh/dsh-remote-web.log" 2>&1 < /dev/null & ) &')
  })

  it('builds the detached default start with log redirection', () => {
    expect(startCommandFor(profile))
      .toBe('mkdir -p "$HOME/.dsh" && ( dsh web --host 127.0.0.1 --port 3080 >>"$HOME/.dsh/dsh-remote-web.log" 2>&1 < /dev/null & ) &')
  })

  it('substitutes a resolved dsh path into the default start command', () => {
    expect(startCommandFor(profile, RESOLVED_DSH))
      .toBe('mkdir -p "$HOME/.dsh" && ( /usr/local/bin/dsh web --host 127.0.0.1 --port 3080 >>"$HOME/.dsh/dsh-remote-web.log" 2>&1 < /dev/null & ) &')
  })

  it('keeps the profile override untouched when a dsh path is known', () => {
    const overridden: MachineProfile = { ...profile, startCommand: 'my-launcher web' }
    expect(startCommandFor(overridden, RESOLVED_DSH)).toContain('my-launcher web')
  })

  it('builds a curl health probe with a bounded deadline', () => {
    expect(healthCheckCommand(3080, 2500)).toBe('curl -s -o /dev/null -m 3 -w \'%{http_code}\' http://127.0.0.1:3080/')
    expect(healthCheckCommand(4000, 100)).toBe('curl -s -o /dev/null -m 1 -w \'%{http_code}\' http://127.0.0.1:4000/')
  })

  it('summarizes a failed command for operators', () => {
    expect(describeExecFailure(1, 'bash: dsh: command not found\n')).toBe('exit 1: bash: dsh: command not found')
    expect(describeExecFailure(null, '  ')).toBe('exit ?')
  })
})

describe('dsh probe', () => {
  it('checks PATH, then the installer links, and never fails', () => {
    const command = probeDshCommand()
    expect(command).toContain('command -v dsh')
    expect(command).toContain('"$HOME/.local/bin/dsh"')
    expect(command).toContain('"$HOME/.dsh/source/current/bin/dsh"')
    expect(command).toContain('true')
    // Each fallback is a braced group: a successful earlier arm must
    // short-circuit the chain instead of firing the later && printf arms too.
    expect(command).toMatch(/\{ test -x "\$HOME\/\.local\/bin\/dsh" && printf/)
  })

  it('takes the first non-empty line of a probe result', () => {
    expect(firstLineOf('/usr/local/bin/dsh\n/other/bin/dsh\n')).toBe('/usr/local/bin/dsh')
    expect(firstLineOf('\n  \n/usr/local/bin/dsh')).toBe('/usr/local/bin/dsh')
    expect(firstLineOf('   ')).toBe('')
    expect(firstLineOf('')).toBe('')
  })
})

describe('install commands', () => {
  it('builds the built-in install from the official repo default', () => {
    const command = installCommandFor({})
    expect(command).toContain(`git clone --depth 1 '${OFFICIAL_INSTALL_REPO}' "$HOME/.dsh/source/master"`)
    expect(command).toContain('corepack enable pnpm')
    expect(command).toContain('npm install -g pnpm')
    expect(command).toContain('pnpm install')
    expect(command).toContain('pnpm run build')
    expect(command).toContain('ln -sfn "$HOME/.dsh/source/current/bin/dsh" "$HOME/.local/bin/dsh"')
    expect(command).toContain('rm -rf "$HOME/.dsh/source/master" "$HOME/.dsh/source/current"')
    expect(command).toContain('set -e')
  })

  it('clones a configured repo with an optional ref', () => {
    const command = installCommandFor({ installRepo: 'https://git.example.com/team/dsh.git' })
    expect(command).toContain(`git clone --depth 1 'https://git.example.com/team/dsh.git' "$HOME/.dsh/source/master"`)
    const withRef = installCommandFor({
      installRepo: 'git@github.com:me/dsh.git',
      installRef: 'snapshots/2026',
    })
    expect(withRef).toContain(`git clone --depth 1 --branch 'snapshots/2026' 'git@github.com:me/dsh.git' "$HOME/.dsh/source/master"`)
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

describe('ensureRemoteInstance', () => {
  it('skips start when the instance already answers', async () => {
    const session = new FakeSession(() => ({ code: 0, stdout: '200', stderr: '' }))
    await expect(ensureRemoteInstance(session, profile, 1000, 10, 3)).resolves.toBe('10.0.0.1:3080')
    expect(session.commands).toHaveLength(1)
    expect(session.commands[0]).toContain('curl')
  })

  it('auto-starts when absent and reports the healthy address after polling', async () => {
    const session = new FakeSession((_command, index) => {
      // 1 = port probe (refused), 2 = dsh probe, 3 = start, 4 = post-start probe (healthy).
      if (index === 1)
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (index === 2)
        return { code: 0, stdout: '', stderr: '' }
      if (index === 3)
        return { code: 0, stdout: '200', stderr: '' }
      return { code: 7, stdout: '', stderr: 'refused' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 3)).resolves.toBe('10.0.0.1:3080')
    expect(session.commands[2]).toContain(`${RESOLVED_DSH} web --host 127.0.0.1 --port 3080`)
  })

  it('reports the bootstrap phases through the progress callback', async () => {
    const session = new FakeSession((_command, index) => {
      // 1 = port probe (refused), 2 = dsh probe, 3 = start, 4 = post-start probe (healthy).
      if (index === 1)
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (index === 2)
        return { code: 0, stdout: '', stderr: '' }
      if (index === 3)
        return { code: 0, stdout: '200', stderr: '' }
      return { code: 7, stdout: '', stderr: 'refused' }
    })
    const phases: unknown[] = []
    await ensureRemoteInstance(session, profile, 1000, 5, 3, progress => phases.push(progress))
    expect(phases).toEqual([
      { phase: 'starting' },
      { phase: 'probing', attempt: 1, total: 3 },
    ])
  })

  it('fails fast with DshMissingError when no dsh binary is reachable', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('curl'))
        return { code: 7, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 3)).rejects.toBeInstanceOf(DshMissingError)
  })

  it('fails loud when the start command itself fails', async () => {
    const session = new FakeSession((_command, index) => {
      if (index === 1)
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (index === 2)
        return { code: 127, stdout: '', stderr: 'sh: dsh: not found' }
      return { code: 7, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 3)).rejects.toThrow(/start failed.*not found/)
  })

  it('fails loud when the instance never becomes reachable, with the log tail', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('command -v dsh'))
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (command.includes('tail'))
        return { code: 0, stdout: 'dsh: command not found\nline2\nline3\nline4\nline5\nline6', stderr: '' }
      if (command.includes('curl'))
        return { code: 7, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 2)).rejects.toThrow(
      /did not become reachable.*line2 \| line3 \| line4 \| line5 \| line6/,
    )
    expect(session.commands).toHaveLength(6)
  })

  it('notes an empty remote log in the failure message', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('command -v dsh'))
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (command.includes('tail'))
        return { code: 0, stdout: '', stderr: '' }
      if (command.includes('curl'))
        return { code: 7, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 1)).rejects.toThrow(/log is empty/)
  })

  it('notes an unreadable remote log in the failure message', async () => {
    const session = new FakeSession((command) => {
      if (command.includes('command -v dsh'))
        return { code: 0, stdout: RESOLVED_DSH, stderr: '' }
      if (command.includes('tail'))
        throw new Error('channel closed')
      if (command.includes('curl'))
        return { code: 7, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 1)).rejects.toThrow(/log unreadable/)
  })

  it('propagates transport failures', async () => {
    const session = new FakeSession(() => {
      throw new Error('channel closed')
    })
    await expect(ensureRemoteInstance(session, profile, 1000, 5, 2)).rejects.toThrow()
  })
})
