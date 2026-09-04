/**
 * SSH transport seam and its ssh2 implementation. The manager depends on the
 * narrow interfaces here — connect, exec, tunnel, close — so tests inject a
 * fake transport and never touch the network.
 * @module dsh-tauri-ssh/host/service/transport
 */

import type { Buffer } from 'node:buffer'
import type { AddressInfo, Server } from 'node:net'
import type { ConnectConfig } from 'ssh2'
import type { MachineProfile } from '../types/index.js'
import type { ResolvedSshAuth } from './ssh-config.js'
import { createServer } from 'node:net'
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

/** Optional exec behavior: a deadline and/or a streaming stdout tap. */
export interface SshExecOptions {
  /** Abort the command after this many milliseconds (closes the connection). */
  timeoutMs?: number
  /** Receive stdout chunks as they arrive (long-running commands, logs). */
  onData?: (chunk: string) => void
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
   * @returns the local listener handle.
   */
  openTunnel: (remotePort: number) => Promise<SshTunnelHandle>
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

/**
 * ssh2-backed transport. One `Client` per session; exec and tunnel run over
 * the shared connection. Credentials come from the injected
 * {@link SshCredentialsResolver}: the host's own `~/.ssh` (config aliases,
 * IdentityFiles, default keys) with the profile's stored password/passphrase
 * as fallbacks — the connection behaves like a local `ssh` invocation.
 */
export class Ssh2Transport implements SshTransport {
  /**
   * @param readyTimeoutMs - handshake deadline for {@link Client.connect}.
   * @param resolver - the `~/.ssh` credential resolver (host, port, user, keys).
   */
  constructor(
    private readonly readyTimeoutMs: number,
    private readonly resolver: SshCredentialsResolver,
  ) {}

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
      client.on('ready', () => {
        settle(() => resolve(new Ssh2Session(client)))
      })
      client.on('error', (error) => {
        settle(() => reject(error))
      })
      void this.resolver.resolve(profile).then((auth) => {
        // Try every resolved identity in order, then the stored password —
        // the same preference order as OpenSSH (publickey before password).
        // ssh2 parses each key itself and skips invalid ones, so a bad or
        // passphrase-locked key never aborts the attempt. Each credential is
        // offered at most once; the handler then gives up.
        let keyIndex = 0
        let passwordOffered = false
        const authHandler: NonNullable<ConnectConfig['authHandler']> = (_methodsLeft, _partialSuccess, callback) => {
          const key = auth.keys[keyIndex]
          if (key !== undefined) {
            keyIndex += 1
            callback({
              type: 'publickey',
              username: auth.username,
              key: key.privateKey,
              ...key.passphrase === undefined ? {} : { passphrase: key.passphrase },
            })
          }
          else if (auth.password !== undefined && !passwordOffered) {
            passwordOffered = true
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
          // Keep the connection alive during long remote commands (dsh
          // installs, health polling): default ssh2 keepalives are off, and
          // idle NAT/firewall state would otherwise drop a 10-minute install.
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3,
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

/** The ssh2 session face over one authenticated `Client`. */
class Ssh2Session implements SshSession {
  private readonly closed = new Set<() => void>()
  private closedFired = false

  constructor(private readonly client: Client) {
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

  openTunnel(remotePort: number): Promise<SshTunnelHandle> {
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
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
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
