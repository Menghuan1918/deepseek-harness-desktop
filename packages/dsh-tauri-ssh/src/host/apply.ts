/**
 * host/apply.ts — the DSH remote-machine host plugin assembly: registers the
 * `ssh-machines` settings namespace, owns the SSH connection manager (TOFU
 * host keys, remote `dsh web` auto-start, loopback tunnels), and mounts the
 * same-origin `/api-ssh` route on `ctx.webServer` for the settings page. No
 * upstream DSH source is touched: every integration is a documented cordis
 * extension point.
 * @module dsh-tauri-ssh/host/apply
 */

import type z from 'schemastery'
import type { SshApiHost } from './routes/index.js'
import type { SshHostBlock } from './service/ssh-config.js'
import type { MachinesValue, Config as SshRemoteConfig } from './storage/index.js'
import type { HostSettingsScope, MachineProfile, MachineSaveRow, MachineSecretWrite, MachineView, SshHostContext, SshInstallResult, SshLink, SshMachineStatus, SshTestResult } from './types/index.js'
import { homedir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { SSH_API_PREFIX, SSH_PLUGIN_NAME } from '../shared/constants.js'
import { createSshApiHandler } from './routes/index.js'
import { KnownHostsStore } from './service/host-keys.js'
import { profileView, SshManager } from './service/manager.js'
import { discoverableHosts, loadSshConfigBlocks, lookupSshConfig, SshConfigResolver } from './service/ssh-config.js'
import { Ssh2Transport } from './service/transport.js'
import { ConfigSchema, DEFAULT_REMOTE_PORT, DEFAULT_SSH_PORT, MACHINES_NAMESPACE, machinesFromValue, MachinesSchema } from './storage/index.js'
import { MachineId } from './types/index.js'

/** Default location of the TOFU host-key document under the harness home. */
function defaultKnownHostsPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ssh', 'known-hosts.json')
}

/**
 * The plugin service: manager-backed connection plane plus the `/api-ssh`
 * handler face. Two machine sources feed the manager: the `ssh-machines`
 * settings namespace (manual machines, with secrets) and the host's own
 * `~/.ssh/config` (discovered Host aliases, read-only, no secrets) — a
 * manual machine with the same id as an alias shadows it.
 */
export class SshRemoteService implements SshApiHost {
  /** The connection manager (transport, TOFU store, and per-machine state). */
  readonly manager: SshManager

  /** The registered settings scope; the write path for machine CRUD. */
  private scope!: HostSettingsScope<MachinesValue>

  /** The ssh directory the discovered aliases and credentials come from. */
  private readonly sshDir: string

  /** The home directory used for `~` expansion while reading the ssh config. */
  private readonly homeDir: string

  /** The validated plugin config (defaults applied by schemastery). */
  private readonly config: SshRemoteConfig

  /**
   * @param ctx - the plugin context (settings + webServer available through inject).
   * @param config - the validated plugin config.
   */
  constructor(ctx: SshHostContext, config: SshRemoteConfig) {
    const knownHosts = new KnownHostsStore(config.knownHostsPath ?? defaultKnownHostsPath())
    this.homeDir = homedir()
    this.sshDir = config.sshDir ?? join(this.homeDir, '.ssh')
    this.config = config
    this.manager = new SshManager({
      transport: new Ssh2Transport(
        config.connectTimeoutMs,
        // Credentials come from the host's own ~/.ssh (config + identity
        // files), exactly like a local `ssh` invocation.
        new SshConfigResolver(this.sshDir, this.homeDir),
      ),
      knownHosts,
      config,
      // v8 ignore next -- deliberately empty status hook: the settings page polls /api-ssh
      emitStatus: () => {
        // The settings page polls status through /api-ssh; no live consumers.
      },
    })
    const scope = ctx.settings.register<MachinesValue>(String(MACHINES_NAMESPACE), MachinesSchema, {
      base: { machines: {} },
    })
    this.scope = scope
    this.manager.refreshProfiles(this.applyStartDefaults(this.manualProfiles()))
    scope.watch(() => {
      void this.syncProfiles()
    })
    // Mount the same-origin connection-plane API.
    ctx.webServer.register({
      kind: 'prefix',
      path: SSH_API_PREFIX,
      handler: createSshApiHandler(this),
    })
    ctx.effect(() => () => {
      void this.manager.dispose()
    })
  }

  /** The manual profiles, read fresh from the settings scope. */
  private manualProfiles(): Map<MachineId, MachineProfile> {
    return machinesFromValue(this.scope.get())
  }

  /** The configured default start command, `{port}` substituted, or none. */
  private defaultStartCommandFor(remotePort: number): string | undefined {
    const template = this.config.startCommand
    if (template === undefined || template === '')
      return undefined
    return template.replaceAll('{port}', String(remotePort))
  }

  /** Fill the configured default start command into profiles that lack one. */
  private applyStartDefaults(profiles: Map<MachineId, MachineProfile>): Map<MachineId, MachineProfile> {
    const next = new Map<MachineId, MachineProfile>()
    for (const [id, profile] of profiles) {
      const startCommand = profile.startCommand ?? this.defaultStartCommandFor(profile.remotePort)
      next.set(id, { ...profile, ...startCommand === undefined ? {} : { startCommand } })
    }
    return next
  }

  /** The discovered config-alias profiles, shadowed by manual ids. */
  private discoveredProfiles(
    blocks: SshHostBlock[],
    manual: Map<MachineId, MachineProfile>,
  ): Map<MachineId, MachineProfile> {
    const discovered = new Map<MachineId, MachineProfile>()
    const remotePort = this.config.remotePort ?? DEFAULT_REMOTE_PORT
    const startCommand = this.defaultStartCommandFor(remotePort)
    for (const alias of discoverableHosts(blocks)) {
      const id = MachineId(alias)
      if (manual.has(id))
        continue
      const settings = lookupSshConfig(blocks, alias)
      discovered.set(id, {
        id,
        name: alias,
        host: alias,
        port: settings.port ?? DEFAULT_SSH_PORT,
        user: settings.user ?? '',
        remotePort,
        ...startCommand === undefined ? {} : { startCommand },
      })
    }
    return discovered
  }

  /** Refresh the manager's profile map from both sources (settings + config). */
  private async syncProfiles(): Promise<void> {
    const manual = this.applyStartDefaults(this.manualProfiles())
    const blocks = await loadSshConfigBlocks(this.sshDir, this.homeDir)
    const merged = new Map<MachineId, MachineProfile>(manual)
    for (const [id, profile] of this.discoveredProfiles(blocks, manual)) merged.set(id, profile)
    this.manager.refreshProfiles(merged)
  }

  /** Redacted views of the manual machines only (the stored, editable set). */
  profileViews(): MachineView[] {
    return [...this.manualProfiles().values()].map(profileView)
  }

  /** Redacted views of the discovered `~/.ssh/config` aliases (read-only). */
  async discoveredViews(): Promise<MachineView[]> {
    const manual = this.manualProfiles()
    const blocks = await loadSshConfigBlocks(this.sshDir, this.homeDir)
    return [...this.discoveredProfiles(blocks, manual).values()].map(profileView)
  }

  status(machineId: MachineId): SshMachineStatus {
    return this.manager.status(machineId)
  }

  async test(machineId: MachineId, signal?: AbortSignal): Promise<SshTestResult> {
    await this.syncProfiles()
    return this.manager.test(machineId, signal)
  }

  async connect(machineId: MachineId, signal?: AbortSignal): Promise<SshLink> {
    await this.syncProfiles()
    return this.manager.connect(machineId, signal)
  }

  async disconnect(machineId: MachineId): Promise<void> {
    await this.syncProfiles()
    return this.manager.disconnect(machineId)
  }

  async install(machineId: MachineId, signal?: AbortSignal): Promise<SshInstallResult> {
    await this.syncProfiles()
    return this.manager.install(machineId, signal)
  }

  /**
   * Upsert one machine profile: merge the config row and any freshly typed
   * secrets into the stored profile (secrets omitted keep the stored value).
   * The scope write validates the whole section; the watch refreshes the
   * manager automatically.
   * @param machineId - the profile id (the settings dict key).
   * @param row - the config fields as the settings page edited them.
   * @param secrets - write-only secret values; absent fields keep stored ones.
   */
  async save(machineId: MachineId, row: MachineSaveRow, secrets?: MachineSecretWrite): Promise<void> {
    const machines = machinesFromValue(this.scope.get())
    const existing = machines.get(machineId)
    const next: MachineProfile = {
      id: machineId,
      name: row.name,
      host: row.host,
      port: row.port,
      user: row.user,
      remotePort: row.remotePort,
    }
    if (existing !== undefined) {
      if (existing.password !== undefined)
        next.password = existing.password
      if (existing.passphrase !== undefined)
        next.passphrase = existing.passphrase
    }
    if (row.startCommand !== undefined && row.startCommand !== '')
      next.startCommand = row.startCommand
    if (row.color !== undefined && row.color !== '')
      next.color = row.color
    if (row.tintBorder === true)
      next.tintBorder = true
    if (secrets !== undefined) {
      if (secrets.password !== undefined && secrets.password !== '')
        next.password = secrets.password
      if (secrets.passphrase !== undefined && secrets.passphrase !== '')
        next.passphrase = secrets.passphrase
    }
    await this.scope.update({ machines: { [machineId]: next } })
  }

  /**
   * Delete one machine profile. The owner scope's `replace` restates the full
   * section (in-process values include the stored secrets), so the removal is
   * exact and nothing else is touched.
   * @param machineId - the profile id to drop (idempotent for absent ids).
   */
  async remove(machineId: MachineId): Promise<void> {
    const machines = machinesFromValue(this.scope.get())
    machines.delete(machineId)
    await this.scope.replace({ machines: Object.fromEntries(machines) })
  }
}

/** Cordis plugin name. */
export const name = SSH_PLUGIN_NAME

/** Required services: the settings seam (namespace) and the webserver (route mount). */
export const inject = ['settings', 'webServer']

/** Validated plugin config; schemastery applies defaults before construction. */
export const Config: z<SshRemoteConfig> = ConfigSchema

/**
 * Cordis plugin entry: instantiate the service.
 * @param ctx - the plugin context.
 * @param config - the plugin config.
 * @returns the service instance.
 */
export function apply(ctx: SshHostContext, config: SshRemoteConfig): SshRemoteService {
  return new SshRemoteService(ctx, config)
}

/**
 * The cordis plugin descriptor. The loader imports the module and reads
 * `apply`/`Config`/`inject`/`name` from the **default export object** — a
 * bare function default carries neither the schema nor the inject list, so
 * config defaults would never apply and the settings/webServer services
 * would not be injected.
 */
export default { apply, Config, inject, name }
