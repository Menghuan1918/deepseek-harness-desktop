/**
 * Remote-instance assurance: probe the remote `dsh web` port, auto-start the
 * instance when absent, and poll until it answers. Commands are pure
 * functions of the profile so the manager can drive them through any
 * transport; the polling loop owns the timing contract and reports its phase
 * through a progress callback so the settings page can show live progress.
 * Also the one-line dsh installer: probe for a `dsh` binary, run the official
 * install script through the remote shell, and copy the local API credentials.
 * @module dsh-tauri-ssh/host/service/bootstrap
 */

import type { Config } from '../storage/index.js'
import type { MachineProfile, SshProgress } from '../types/index.js'
import type { SshSession } from './transport.js'
import { readFileSync } from 'node:fs'
import { shQuote } from './transport.js'

/** Log file of the auto-started remote instance, under the remote home. */
export const REMOTE_WEB_LOG = '.dsh/dsh-remote-web.log'

/** The installer's default clone source (its DSH_REPO default). */
export const OFFICIAL_INSTALL_REPO = 'https://github.com/deepseek-harness/deepseek-harness.git'

/** The default remote-instance start command, parameterized by the profile's remote port. */
export function defaultStartCommand(profile: MachineProfile): string {
  return `dsh web --host 127.0.0.1 --port ${profile.remotePort}`
}

/**
 * The remote-instance start command: the profile override when present, else
 * the default with the resolved `dsh` binary substituted for the bare name
 * (the installer's `~/.local/bin` is rarely on a login shell's PATH). The
 * log directory is ensured first (a missing `$HOME/.dsh` would otherwise
 * swallow the redirection and every error with it), then the command runs
 * detached in the background with output redirected to the log; the health
 * probe judges the outcome, never the command. Deliberately no `nohup`: in an
 * sshd exec session there is no controlling terminal to detach from, and
 * macOS nohup then kills the child instead of protecting it — a plain
 * backgrounded job survives both the exec channel and connection close (no
 * pty was ever allocated).
 * @param profile - the machine profile.
 * @param dshPath - resolved remote `dsh` binary path, when known.
 * @returns the shell command line that starts (or restarts) the instance.
 */
export function startCommandFor(profile: MachineProfile, dshPath?: string): string {
  const base = profile.startCommand !== undefined
    ? profile.startCommand
    : dshPath === undefined
      ? defaultStartCommand(profile)
      : `${dshPath} web --host 127.0.0.1 --port ${profile.remotePort}`
  // Detach through a double subshell: `( … & ) &` — the inner background job
  // reparents (orphan) as soon as the wrapping subshell exits, so nothing
  // holds the exec channel's stdin and sshd closes the channel immediately
  // (a bare `… &` keeps the instance in the session: sshd holds the channel
  // open and ssh2's exec never settles). Output goes to the log with stdin
  // from /dev/null; no nohup (macOS nohup kills the child in this context).
  return `mkdir -p "$HOME/.dsh" && ( ${base} >>"$HOME/${REMOTE_WEB_LOG}" 2>&1 < /dev/null & ) &`
}

/**
 * Probe for a remote `dsh` binary, in install order: the login shell's PATH,
 * then the installer's `~/.local/bin` link, then the source checkout's
 * launcher. Prints the resolved path (possibly `$HOME`-relative) or nothing.
 * Each branch is a braced group so a successful `command -v` short-circuits
 * the whole `||` chain without the later `&& printf` arms firing too.
 */
export function probeDshCommand(): string {
  return [
    'command -v dsh 2>/dev/null',
    `{ test -x "$HOME/.local/bin/dsh" && printf '%s\\n' "$HOME/.local/bin/dsh"; }`,
    `{ test -x "$HOME/.dsh/source/current/bin/dsh" && printf '%s\\n' "$HOME/.dsh/source/current/bin/dsh"; }`,
    'true',
  ].join(' || ')
}

/**
 * The one-line remote install, built in (no external script to curl — the
 * "official" installer URL does not exist yet): clone the repository (the
 * configured `installRepo`, default branch or `installRef`), install
 * dependencies, build the web frontend, and link `dsh` into
 * `~/.local/bin` (the path the probe resolves when the login PATH lacks it).
 * A prior managed install under `~/.dsh/source` is replaced, so re-running
 * reinstalls cleanly.
 * @param config - plugin config (repo and ref overrides).
 * @returns the full remote install command line.
 */
export function installCommandFor(config: Pick<Config, 'installRepo' | 'installRef'>): string {
  const repo = config.installRepo === undefined || config.installRepo === ''
    ? OFFICIAL_INSTALL_REPO
    : config.installRepo
  const ref = config.installRef === undefined || config.installRef === ''
    ? undefined
    : config.installRef
  const clone = ref === undefined
    ? `git clone --depth 1 ${shQuote(repo)} "$HOME/.dsh/source/master"`
    : `git clone --depth 1 --branch ${shQuote(ref)} ${shQuote(repo)} "$HOME/.dsh/source/master"`
  return [
    'set -e',
    `mkdir -p "$HOME/.dsh/source" "$HOME/.local/bin"`,
    `rm -rf "$HOME/.dsh/source/master" "$HOME/.dsh/source/current"`,
    `echo '==> cloning dsh source'`,
    clone,
    `ln -s "$HOME/.dsh/source/master" "$HOME/.dsh/source/current"`,
    `echo '==> ensuring pnpm'`,
    // pnpm may live outside the login PATH (nvm etc.): enable it via
    // corepack (ships with Node), else install it globally with npm.
    `(command -v pnpm >/dev/null 2>&1) || (corepack enable pnpm >/dev/null 2>&1) || npm install -g pnpm`,
    `echo '==> installing dependencies (pnpm install)'`,
    `(cd "$HOME/.dsh/source/current" && pnpm install)`,
    `echo '==> building web UI'`,
    `(cd "$HOME/.dsh/source/current" && pnpm run build)`,
    `ln -sfn "$HOME/.dsh/source/current/bin/dsh" "$HOME/.local/bin/dsh"`,
    `echo '==> dsh installed'`,
  ].join(' && ')
}

/** Credentials read from a local dsh `.env` document. */
export interface EnvCredentials {
  apiKey?: string
  baseUrl?: string
}

/**
 * Read `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` from a dsh `.env` document
 * (the installer's own layout: `KEY=value` lines, no quoting).
 * @param path - the `.env` file path (the harness home's `.env`).
 * @returns the credentials present in the document.
 */
export function readEnvCredentials(path: string): EnvCredentials {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch {
    return {}
  }
  const out: EnvCredentials = {}
  const apiKey = envValueOf(text, 'DEEPSEEK_API_KEY')
  /* v8 ignore next -- attribution artifact: both arms are exercised by the credentials tests */
  if (apiKey !== undefined)
    out.apiKey = apiKey
  const baseUrl = envValueOf(text, 'DEEPSEEK_BASE_URL')
  if (baseUrl !== undefined)
    out.baseUrl = baseUrl
  return out
}

/**
 * Write credentials into the remote `~/.dsh/.env` without clobbering an
 * existing key: print `copied` when the write happened, `existing` when the
 * remote already carries a key (kept untouched).
 * @param credentials - the credentials to write (apiKey required).
 * @returns the shell command line.
 */
export function credentialsCopyCommand(credentials: EnvCredentials & { apiKey: string }): string {
  const lines = [`printf 'DEEPSEEK_API_KEY=%s\\n' ${shQuote(credentials.apiKey)}`]
  if (credentials.baseUrl !== undefined) {
    lines.push(`printf 'DEEPSEEK_BASE_URL=%s\\n' ${shQuote(credentials.baseUrl)}`)
  }
  return [
    `mkdir -p "$HOME/.dsh"`,
    `if grep -q '^DEEPSEEK_API_KEY=' "$HOME/.dsh/.env" 2>/dev/null; then echo existing; else umask 077 && { ${lines.join('; ')}; } > "$HOME/.dsh/.env" && echo copied; fi`,
  ].join(' && ')
}

/** One `KEY=value` line of a `.env` document, optional surrounding quotes stripped. */
function envValueOf(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${key}=`))
      continue
    const value = line.slice(key.length + 1).trim().replace(/^"(.*)"$/u, '$1')
    return value === '' ? undefined : value
  }
  return undefined
}

/** The first non-empty line of a command's stdout, trimmed (a probe prints one path). */
export function firstLineOf(stdout: string): string {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '')
      return trimmed
  }
  return ''
}

/**
 * One health probe: curl the remote instance's web port. Any HTTP response
 *  (including 404 on the bare path) proves the webserver listens; a refused
 *  connection exits nonzero.
 */
export function healthCheckCommand(remotePort: number, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return `curl -s -o /dev/null -m ${seconds} -w '%{http_code}' http://127.0.0.1:${remotePort}/`
}

/** The tail command that recovers the remote instance's log for the error message. */
export function logTailCommand(): string {
  return `tail -n 20 "$HOME/${REMOTE_WEB_LOG}" 2>/dev/null || true`
}

/** The typed failure "the remote has no `dsh` binary" (offers the install path). */
export class DshMissingError extends Error {}

/**
 * Ensure the remote instance answers on its port: probe once, auto-start when
 * absent, then poll until healthy or the attempt budget is exhausted. The
 * failure message carries the remote log's tail — a backgrounded start always
 * exits 0 (even when the command itself fails), so the log is the only place
 * the real error (command not found, port busy, …) is visible. When the
 * default start command is in play (no profile override), the `dsh` binary is
 * resolved first and its absence fails fast with {@link DshMissingError}.
 * @param session - the authenticated SSH session.
 * @param profile - the machine profile (port + start command).
 * @param timeoutMs - per-probe curl deadline.
 * @param pollIntervalMs - pause between probes.
 * @param pollAttempts - total probes after the initial one.
 * @param onProgress - receives the live bootstrap phase (started/probing).
 * @returns a short description of the healthy instance (host:port).
 * @throws {DshMissingError} when no `dsh` binary is reachable.
 * @throws {Error} with an operator-facing message when the instance never becomes reachable.
 */
export async function ensureRemoteInstance(
  session: SshSession,
  profile: MachineProfile,
  timeoutMs: number,
  pollIntervalMs: number,
  pollAttempts: number,
  onProgress?: (progress: SshProgress) => void,
): Promise<string> {
  const probe = async (): Promise<boolean> => {
    const result = await session.exec(healthCheckCommand(profile.remotePort, timeoutMs))
    return result.code === 0
  }
  if (await probe())
    return `${profile.host}:${profile.remotePort}`
  onProgress?.({ phase: 'starting' })
  let dshPath: string | undefined
  if (profile.startCommand === undefined) {
    dshPath = firstLineOf((await session.exec(probeDshCommand())).stdout)
    if (dshPath === '') {
      throw new DshMissingError(
        `dsh is not installed on "${profile.host}" (checked the login PATH, ~/.local/bin and ~/.dsh/source/current); `
        + 'install it with the one-click install, or configure the machine\'s start command',
      )
    }
  }
  const started = await session.exec(startCommandFor(profile, dshPath))
  if (started.code !== 0) {
    throw new Error(
      `remote instance start failed on "${profile.host}": ${describeExecFailure(started.code, started.stderr)}`,
    )
  }
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    onProgress?.({ phase: 'probing', attempt: attempt + 1, total: pollAttempts })
    await sleep(pollIntervalMs)
    if (await probe())
      return `${profile.host}:${profile.remotePort}`
  }
  const tail = await logTail(session)
  throw new Error(
    `remote dsh web did not become reachable on "${profile.host}:${profile.remotePort}" `
    + `within ${pollAttempts} polls; remote log (${shQuote(`$HOME/${REMOTE_WEB_LOG}`)}) tail: ${tail}`,
  )
}

/** The remote instance log's tail, or a note when nothing was captured. */
async function logTail(session: SshSession): Promise<string> {
  try {
    const result = await session.exec(logTailCommand())
    const tail = result.stdout.trim()
    return tail === '' ? '(log is empty)' : tail.split('\n').slice(-5).join(' | ')
  }
  catch {
    return '(log unreadable)'
  }
}

/** One operator-facing fragment for a failed remote command. */
export function describeExecFailure(code: number | null, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' | ')
  return `exit ${code ?? '?'}${tail === '' ? '' : `: ${tail}`}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
