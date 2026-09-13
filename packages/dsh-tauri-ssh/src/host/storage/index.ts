/**
 * Plugin config and the `ssh-machines` settings-namespace schema. The
 * namespace stores a dict of machine profiles keyed by machine id — a dict
 * (not an array) so a redacted client can add, edit, and delete one machine
 * through `settings.update` deep-merge and `settings.mutate` path-unset
 * without ever re-supplying (or deleting) secrets it never saw.
 * @module dsh-tauri-ssh/host/storage
 */

import type { MachineProfile } from '../types/index'
import z from 'schemastery'
import { MachineId } from '../types/index'

/** One settings-namespace key (the harness brands these; the wire treats them as strings). */
export type SettingsNamespace = string & { readonly __namespace: unique symbol }

/** Brand a settings namespace key. */
export function settingsNamespace(name: string): SettingsNamespace {
  return name as SettingsNamespace
}

/** Settings namespace key owning the machine profile dict. */
export const MACHINES_NAMESPACE = settingsNamespace('ssh-machines')

/** Default TCP port of the remote `dsh web` instance (loopback). */
export const DEFAULT_REMOTE_PORT = 3080

/** Default SSH transport port. */
export const DEFAULT_SSH_PORT = 22

/**
 * One machine profile schema: the settings-namespace member shape. Credential
 * fields are `role('secret')` positions — redacted from every wire surface,
 * present in the owner scope's resolved value. Authentication itself runs on
 * the host's `~/.ssh`; the stored fields are only the optional fallbacks.
 */
export const MachineSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  host: z.string().required(),
  port: z.number().default(DEFAULT_SSH_PORT),
  user: z.string().required(),
  password: z.string().role('secret'),
  passphrase: z.string().role('secret'),
  remotePort: z.number().default(DEFAULT_REMOTE_PORT),
  startCommand: z.string(),
  color: z.string(),
  tintBorder: z.boolean(),
})

/** The whole `ssh-machines` namespace value: a dict of profiles by machine id. */
export const MachinesSchema = z.object({
  machines: z.dict(MachineSchema).default({}),
}) as unknown as z<MachinesValue>

/** Resolved value shape of the `ssh-machines` namespace. */
export interface MachinesValue {
  machines: Record<string, MachineProfile>
}

/**
 * Validated plugin config. Timeouts are deployment-varying choices, never
 * hardcoded tunables.
 */
export interface Config {
  /** SSH handshake/authentication deadline in milliseconds. */
  connectTimeoutMs: number
  /** Per-probe deadline of the remote-instance health check in milliseconds. */
  healthCheckTimeoutMs: number
  /** Pause between health-check probes while waiting for the instance. */
  healthPollIntervalMs: number
  /** How many probes run before the bootstrap attempt is declared failed. */
  healthPollAttempts: number
  /** Override for the TOFU known-hosts file (defaults under the harness home). */
  knownHostsPath?: string
  /** Override for the `~/.ssh` directory the credentials resolve against. */
  sshDir?: string
  /** Default remote `dsh web` port for machines that do not override it. */
  remotePort?: number
  /**
   * Default remote-instance start command for machines without their own
   * override; `{port}` is replaced with the machine's remote port. Covers
   * the discovered `~/.ssh/config` aliases, which cannot carry per-machine
   * overrides.
   */
  startCommand?: string
  /**
   * The DSH install-source repository anchor. Defaults to the official DSH
   * repository (org verified: `deepseek-ai`); the binary install resolves its
   * download repository from it — the official anchor maps onto the official
   * packaging repository (`dsh-tauri-desk/deepseek-harness-pkg`), and any
   * other configured `owner/name` or GitHub URL is used directly as the
   * release repository, so forks/mirrors of the packaging repo keep working.
   */
  installRepo?: string
  /**
   * DSH version pin for the binary install: a semver (`0.1.5-rc.2`) or a full
   * release tag (`dsh-0.1.5-rc.2-34495473237`). Defaults to the recommended
   * version; unresolvable pins fall back to the latest stable release.
   */
  installRef?: string
  /** Deadline for one remote binary install (download + verify + extract + pnpm assembly). */
  installTimeoutMs?: number
  /** ssh2 keepalive interval in milliseconds — the connection watchdog's heartbeat. */
  keepaliveIntervalMs: number
  /** How many unanswered keepalives declare the connection dead (the watchdog threshold). */
  keepaliveCountMax: number
  /** Delay before the first reconnect retry, in milliseconds. */
  reconnectInitialDelayMs: number
  /** Ceiling of the exponential reconnect backoff, in milliseconds. */
  reconnectMaxDelayMs: number
  /**
   * Give-up threshold: how many reconnect retries run (after the initial
   * attempt) before the machine lands in the `given-up` terminal state.
   */
  reconnectMaxAttempts: number
}

/** Plugin config schema; schemastery fills defaults before construction. */
export const ConfigSchema: z<Config> = z.object({
  connectTimeoutMs: z.number().default(15_000),
  healthCheckTimeoutMs: z.number().default(3_000),
  healthPollIntervalMs: z.number().default(1_000),
  healthPollAttempts: z.number().default(30),
  knownHostsPath: z.string(),
  sshDir: z.string(),
  remotePort: z.number().default(DEFAULT_REMOTE_PORT),
  startCommand: z.string(),
  installRepo: z.string(),
  installRef: z.string(),
  installTimeoutMs: z.number().default(1_800_000),
  keepaliveIntervalMs: z.number().default(10_000),
  keepaliveCountMax: z.number().default(3),
  reconnectInitialDelayMs: z.number().default(1_000),
  reconnectMaxDelayMs: z.number().default(20_000),
  reconnectMaxAttempts: z.number().default(6),
})

/** Normalize a resolved namespace value into a machine profile map keyed by id. */
export function machinesFromValue(value: MachinesValue): Map<MachineId, MachineProfile> {
  const profiles = new Map<MachineId, MachineProfile>()
  for (const [key, profile] of Object.entries(value.machines)) {
    const id = MachineId(key)
    if (profile.id !== key) {
      throw new Error(
        `ssh-machines: machine "${key}" carries id "${profile.id}"; the dict key must equal the profile id`,
      )
    }
    profiles.set(id, { ...profile, id })
  }
  return profiles
}
