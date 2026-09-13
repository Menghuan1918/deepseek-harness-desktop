/**
 * SSH transport seam and its ssh2 implementation. The manager depends on the
 * narrow interfaces here — connect, exec, tunnel, close — so tests inject a
 * fake transport and never touch the network.
 * @module dsh-tauri-ssh/host/service/transport
 */

import type { Buffer } from 'node:buffer'
import type { AddressInfo, Server } from 'node:net'
import type { ConnectConfig } from 'ssh2'
import type { MachineProfile, SshAuthMethod } from '../types/index'
import type { ResolvedSshAuth } from './ssh-config'
import { createServer } from 'node:net'
import process from 'node:process'
import { Client } from 'ssh2'

/** The credential-resolution face the transport needs (SshConfigResolver implements it). */
export interface SshCredentialsResolver {
  resolve: (profile: MachineProfile) => Promise<ResolvedSshAuth>
}

/** One completed remote command. */
export interface SshExecResult {
  /** Exit code; null when the remote side reported none. */
  code: number | null
  stdout: string
  stderr: string
}

/** Optional exec behavior: a deadline, a streaming stdout tap, and stdin bytes. */
export interface SshExecOptions {
  /** Abort the command after this many milliseconds (closes the connection). */
  timeoutMs?: number
  /** Receive stdout chunks as they arrive (long-running commands, logs). */
  onData?: (chunk: string) => void
  /**
   * Bytes written to the command's stdin, then EOF. Used to stream payloads
   * (a skill tarball) without landing them on the remote command line, whose
   * single-argument length the kernel caps far below a real payload.
   */
  stdinData?: Buffer
}

/** A local loopback listener forwarding into the SSH tunnel. */
export interface SshTunnelHandle {
  /** The bound loopback port (0 = ephemeral, read from the server). */
  localPort: number
  /** Close the listener; in-flight forwarded connections are aborted. */
  close: () => Promise<void>
}

/** One authenticated SSH session. */
export interface SshSession {
  /**
   * Which credential this session authenticated with (`agent`, `key`, or
   * `password`); absent when the transport cannot tell.
   */
  readonly authMethod?: SshAuthMethod | undefined
  /**
   * Run one command through the remote login shell.
   * @param command - the full command line.
   * @param options - optional deadline and streaming stdout tap.
   * @returns the collected result.
   */
  exec: (command: string, options?: SshExecOptions) => Promise<SshExecResult>
  /**
   * Forward a remote loopback port to a new local loopback listener
   * (`ssh -L` semantics).
   * @param remotePort - the remote 127.0.0.1 port to reach.
   * @param preferredLocalPort - keep the tunnel's published URL stable across
   *   reconnects by re-binding this port when possible (falls back to an
   *   ephemeral port when it is taken).
   * @returns the local listener handle.
   */
  openTunnel: (remotePort: number, preferredLocalPort?: number) => Promise<SshTunnelHandle>
  /**
   * Register the session-closed callback (connection dropped, server went
   * away, or {@link close} ran).
   * @param callback - fired exactly once.
   */
  onClosed: (callback: () => void) => void
  /** Close the session; idempotent. */
  close: () => Promise<void>
}

/** Transport factory: authenticate one machine and return its session. */
export interface SshTransport {
  /**
   * @param profile - the machine profile to connect.
   * @param hostKeyVerifier - TOFU host-key gate; may be async (the ssh2
   *   callback form waits for the verdict).
   * @param signal - aborts the handshake.
   * @returns the authenticated session.
   */
  connect: (
    profile: MachineProfile,
    hostKeyVerifier: (hostKey: Buffer) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ) => Promise<SshSession>
}

/** Wrap one string for safe inclusion in a remote shell command line. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Build the `sh -lc <command>` wrapper used for every remote command. */
export function loginShell(command: string): string {
  return `sh -lc ${shQuote(command)}`
}

/** The three operator-distinguishable connection failure classes. */
export type SshConnectFailureKind
  = | 'key-rejected'
    | 'password-rejected'
    | 'unreachable'
    | 'other'

/** Network-level error codes that mean "the host cannot be reached at all". */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
])

/** Whether one raw transport error reads as "host unreachable". */
function isUnreachable(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== undefined && UNREACHABLE_CODES.has(code))
    return true
  return /timed?\s?out|connection refused|econnrefused|no route to host|name or service not known|getaddrinfo/iu.test(error.message)
}

/**
 * Classify one connection failure into the three operator-distinguishable
 * classes (key/agent rejected → check keys or store a password; password
 * rejected → update the stored password; unreachable → network/host name).
 * @param error - the raw transport failure.
 * @param passwordOffered - whether the stored password was part of the chain.
 * @returns the failure class.
 */
export function classifyConnectFailure(error: unknown, passwordOffered: boolean): SshConnectFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = error instanceof Error ? error : new Error(message)
  if (isUnreachable(normalized))
    return 'unreachable'
  if (/all configured authentication methods failed|authentication failed|no supported authentication/iu.test(message)) {
    return passwordOffered ? 'password-rejected' : 'key-rejected'
  }
  return 'other'
}

/** One operator-facing message for a classified connection failure. */
export function describeConnectFailure(kind: SshConnectFailureKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (kind) {
    case 'key-rejected':
      return 'authentication failed: no key or ssh-agent was accepted — check your keys or store a password for this machine'
    case 'password-rejected':
      return 'authentication failed: the stored password was rejected — update the stored password'
    case 'unreachable':
      return `host unreachable: ${message === '' ? 'SSH connection failed' : message}`
    default:
      return message === '' ? 'SSH connection failed' : message
  }
}

/** Transport timing/watchdog options; the manager passes the plugin config through. */
export interface Ssh2TransportOptions {
  /** ssh2 keepalive heartbeat interval in milliseconds (default 10 s). */
  keepaliveIntervalMs?: number
  /** Unanswered-heartbeat threshold that declares the connection dead (default 3). */
  keepaliveCountMax?: number
  /**
   * ssh-agent socket path. `undefined` reads `SSH_AUTH_SOCK` per connect
   * (an empty/unset variable disables the agent step); an explicit empty
   * string disables it too.
   */
  agentSocket?: string
}

/**
 * ssh2-backed transport. One `Client` per session; exec and tunnel run over
 * the shared connection. Credentials come from the injected
 * {@link SshCredentialsResolver}: the host's own `~/.ssh` (config aliases,
 * IdentityFiles, default keys) with the profile's stored password/passphrase
 * as fallbacks — the connection behaves like a local `ssh` invocation. The
 * auth chain order is fixed: ssh-agent → private keys → stored password;
 * without an agent or a stored password the chain degrades to exactly the
 * previous behavior.
 */
export class Ssh2Transport implements SshTransport {
  private readonly options: Required<Pick<Ssh2TransportOptions, 'keepaliveIntervalMs' | 'keepaliveCountMax'>> & Pick<Ssh2TransportOptions, 'agentSocket'>

  /**
   * @param readyTimeoutMs - handshake deadline for {@link Client.connect}.
   * @param resolver - the `~/.ssh` credential resolver (host, port, user, keys).
   * @param options - keepalive watchdog timing and the agent socket override;
   *   omitted fields fall back to the 10 s / 3-beat defaults.
   */
  constructor(
    private readonly readyTimeoutMs: number,
    private readonly resolver: SshCredentialsResolver,
    options?: Ssh2TransportOptions,
  ) {
    this.options = {
      keepaliveIntervalMs: options?.keepaliveIntervalMs ?? 10_000,
      keepaliveCountMax: options?.keepaliveCountMax ?? 3,
      ...options?.agentSocket === undefined ? {} : { agentSocket: options.agentSocket },
    }
  }

  async connect(
    profile: MachineProfile,
    hostKeyVerifier: (hostKey: Buffer) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    return new Promise<SshSession>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const client = new Client()
      const onAbort = (): void => {
        client.end()
        reject(abortError(signal as AbortSignal))
      }
      if (signal !== undefined)
        signal.addEventListener('abort', onAbort, { once: true })
      const settle = (fn: () => void): void => {
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      // The auth chain's shared bookkeeping: which method won (reported on
      // the session once ready) and whether the stored password participated
      // (drives the failure classification when everything is rejected).
      let winningMethod: SshAuthMethod | undefined
      let passwordOffered = false
      client.on('ready', () => {
        settle(() => resolve(new Ssh2Session(client, winningMethod)))
      })
      client.on('error', (error) => {
        settle(() => reject(describedConnectFailure(error, passwordOffered)))
      })
      void this.resolver.resolve(profile).then((auth) => {
        const agentSocket = this.options.agentSocket === undefined
          ? process.env.SSH_AUTH_SOCK
          : this.options.agentSocket
        const agent = agentSocket === undefined || agentSocket === '' ? undefined : agentSocket
        // Try the ssh-agent first, then every resolved identity in order,
        // then the stored password — the same preference order as OpenSSH
        // (agent, publickey, password). ssh2 parses each key itself and
        // skips invalid ones, so a bad or passphrase-locked key never aborts
        // the attempt. Each credential is offered at most once; the handler
        // then gives up.
        let agentOffered = false
        let keyIndex = 0
        const authHandler: NonNullable<ConnectConfig['authHandler']> = (_methodsLeft, _partialSuccess, callback) => {
          if (agent !== undefined && !agentOffered) {
            agentOffered = true
            winningMethod = 'agent'
            callback({ type: 'agent', username: auth.username, agent })
          }
          else if (keyIndex < auth.keys.length) {
            const key = auth.keys[keyIndex]!
            keyIndex += 1
            winningMethod = 'key'
            callback({
              type: 'publickey',
              username: auth.username,
              key: key.privateKey,
              ...key.passphrase === undefined ? {} : { passphrase: key.passphrase },
            })
          }
          else if (auth.password !== undefined && !passwordOffered) {
            passwordOffered = true
            winningMethod = 'password'
            callback({ type: 'password', username: auth.username, password: auth.password })
          }
          else {
            // `false` signals "no more methods" at runtime; the published
            // NextAuthHandler type omits it.
            callback(false as never)
          }
        }
        client.connect({
          host: auth.host,
          port: auth.port,
          username: auth.username,
          readyTimeout: this.readyTimeoutMs,
          // Keepalive watchdog: with these settings ssh2 declares the
          // connection dead after `countMax` unanswered heartbeats and
          // surfaces it as a close — the manager's reconnect trigger.
          keepaliveInterval: this.options.keepaliveIntervalMs,
          keepaliveCountMax: this.options.keepaliveCountMax,
          authHandler,
          // ssh2 accepts a synchronous boolean return OR the verify-callback
          // form; always driving the callback keeps async verifiers uniform.
          hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
            const verdict = hostKeyVerifier(key)
            if (verdict instanceof Promise) {
              void verdict.then(verify, () => verify(false))
            }
            else {
              verify(verdict)
            }
          },
        })
      }, reject)
    })
  }
}

/**
 * Wrap one raw ssh2 handshake failure with its classified, operator-facing
 * message (the three-way auth/unreachable distinction rides the message; the
 * raw error's own text never carries secrets).
 */
function describedConnectFailure(error: Error, passwordOffered: boolean): Error {
  const kind = classifyConnectFailure(error, passwordOffered)
  const message = describeConnectFailure(kind, error)
  if (message === error.message)
    return error
  return new Error(message)
}

/** The ssh2 session face over one authenticated `Client`. */
class Ssh2Session implements SshSession {
  private readonly closed = new Set<() => void>()
  private closedFired = false

  constructor(
    private readonly client: Client,
    readonly authMethod: SshAuthMethod | undefined = undefined,
  ) {
    this.client.on('close', () => {
      if (this.closedFired)
        return
      this.closedFired = true
      for (const callback of this.closed) callback()
      this.closed.clear()
    })
  }

  exec(command: string, options?: SshExecOptions): Promise<SshExecResult> {
    return new Promise<SshExecResult>((resolve, reject) => {
      let settled = false
      const timer = options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          /* v8 ignore next 3 -- race guard: the timer always loses to close/error, which clear it */
            if (settled)
              return
            settled = true
            // Closing the connection kills the remote channel (and its process)
            // and settles any in-flight close events.
            this.client.end()
            reject(new Error(`remote command timed out after ${options.timeoutMs} ms`))
          }, options.timeoutMs)
      this.client.exec(loginShell(command), (error, stream) => {
        if (error !== undefined) {
          /* v8 ignore next 3 -- race guard: an exec-open error either settles first or follows a timeout */
          if (!settled) {
            settled = true
            if (timer !== undefined)
              clearTimeout(timer)
            reject(error)
          }
          return
        }
        let stdout = ''
        let stderr = ''
        // Stdin payloads go out first (half-close semantics: EOF lets the
        // remote `tar -xf -` finish while stdout keeps flowing back).
        if (options?.stdinData !== undefined && options.stdinData.length > 0) {
          stream.write(options.stdinData)
          stream.end()
        }
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stdout += text
          options?.onData?.(text)
        })
        stream.on('stderr', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('close', (code: number | null) => {
          if (settled)
            return
          settled = true
          if (timer !== undefined)
            clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
        stream.on('error', (streamError: Error) => {
          /* v8 ignore next -- race guard: a stream error either settles first or follows a timeout */
          if (settled)
            return
          settled = true
          if (timer !== undefined)
            clearTimeout(timer)
          reject(streamError)
        })
      })
    })
  }

  openTunnel(remotePort: number, preferredLocalPort?: number): Promise<SshTunnelHandle> {
    return this.listenTunnel(remotePort, preferredLocalPort, true)
  }

  /**
   * Bind the loopback forwarder, preferring `preferredLocalPort` so a
   * reconnect can re-publish the same tunnel URL; a taken port falls back
   * to an ephemeral one (only the first, deliberate preference retries).
   */
  private listenTunnel(remotePort: number, preferredLocalPort: number | undefined, allowFallback: boolean): Promise<SshTunnelHandle> {
    return new Promise<SshTunnelHandle>((resolve, reject) => {
      const sockets = new Set<import('node:net').Socket>()
      const server: Server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, channel) => {
          if (error !== undefined) {
            socket.destroy()
            return
          }
          socket.pipe(channel).pipe(socket)
        })
      })
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (allowFallback && error.code === 'EADDRINUSE' && preferredLocalPort !== undefined) {
          // The preferred port was reclaimed while we were away; an
          // ephemeral port keeps the reconnect alive (the URL change rides
          // the status publication).
          void this.listenTunnel(remotePort, undefined, false).then(resolve, reject)
          return
        }
        reject(error)
      })
      server.listen(preferredLocalPort ?? 0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve({
          localPort: port,
          close: () => new Promise<void>((closeResolve) => {
            server.close(() => closeResolve())
            // A half-open forwarded socket must not park the close forever.
            for (const socket of sockets) socket.destroy()
          }),
        })
      })
    })
  }

  onClosed(callback: () => void): void {
    if (this.closedFired) {
      callback()
      return
    }
    this.closed.add(callback)
  }

  close(): Promise<void> {
    this.client.end()
    return Promise.resolve()
  }
}

/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error)
    return reason
  if (typeof reason === 'string')
    return new Error(reason)
  return new Error('This operation was aborted')
}
