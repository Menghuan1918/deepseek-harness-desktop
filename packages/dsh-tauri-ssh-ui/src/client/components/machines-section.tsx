'use no memo'

/**
 * The SSH-machines settings section, redrawn on the official UI primitives
 * (Button / Input / StateDot / Modal / Pill — the same atoms the DSH settings
 * pages use), with CSS Modules keeping only layout and token alignment. One
 * card per machine: the config form (secrets write-only, presence-flagged),
 * the connection plane (test/connect/open/disconnect) over the C-STATE
 * vocabulary (reconnecting and given-up included, with the next-retry hint),
 * the streaming log (the S2 machine.events channel, falling back to the
 * status progress log), and a delete confirmation modal. The open-in-window
 * affordance only exists where the desktop iframe bridge answers
 * (remote_bridge_ping); a bridge failure surfaces as a visible error. All
 * state lives in the injected {@link MachinesStore}; the component is a thin
 * renderer over its snapshot.
 * @module dsh-tauri-ssh-ui/client/components/machines-section
 */

import type { CSSProperties, ReactNode } from 'react'
import type { SshKey } from '../locales/index.js'
import type { InstallResult, MachineRow, MachinesStore, MachineStatus, SecretValues } from '../store/index.js'
import type { MachineLifecycleState, RemoteBridge } from '../types/index.js'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import css from './machines-section.module.css'
import { SyncPanel } from './sync-panel.js'

/** A secret field name. */
export type SecretFieldName = 'password' | 'passphrase'

/** Registrant-owned dependencies of the section. */
export interface MachinesSectionInjected {
  store: MachinesStore
  /** The desktop iframe bridge (defaults to the real one at registration). */
  bridge?: RemoteBridge
}

/** Full section props: the framework `t` seat plus the injected store. */
export interface MachinesSectionProps extends MachinesSectionInjected {
  t: (key: SshKey) => string
}

/** One editable draft row (key is the machine id; rows always mirror saved machines). */
interface Draft {
  key: string
  row: MachineRow
}

/** The dirty-secret map the form carries: machine key → typed secret values. */
type DirtySecrets = Record<string, SecretValues>

/** The StateDot vocabulary the connection states map onto ('idle' is hollow). */
type DotState = 'done' | 'ongoing' | 'error' | 'idle'

/** The desktop-context verdict of the bridge probe. */
type BridgeAvailability = 'unknown' | 'desktop' | 'web'

/** One pending delete, driving the confirmation modal. */
interface RemoveTarget {
  key: string
  id: string
  name: string
}

const DEFAULT_PORT = 22
const DEFAULT_REMOTE_PORT = 3080

/** Derive the machine id from a host: lowercase alnum-dash slug of the first label. */
function slugOf(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^.*@/u, '')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/** The first free id: the slug itself, else slug-2, slug-3, … */
function freeIdOf(base: string, taken: ReadonlySet<string>): string {
  if (base !== '' && !taken.has(base))
    return base
  const stem = base === '' ? 'machine' : base
  for (let n = 2;; n += 1) {
    const candidate = `${stem}-${n}`
    if (!taken.has(candidate))
      return candidate
  }
}

/** The id vocabulary (starts lowercase alnum; dashes allowed inside). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** The identity-color palette (fits the DSH status hue family). */
const COLOR_CHOICES = [
  '#4176E6',
  '#0EA5E9',
  '#14B8A6',
  '#22C55E',
  '#F59E0B',
  '#F97316',
  '#EF4444',
  '#A855F7',
]

/** One machine's editable config card. */
export function MachineCard(
  { draft, t, secretSet, status, busy, dirty, logLines, bridgeOpen, bridgeError, onChange, onSecret, onRemove, onTest, onConnect, onDisconnect, onOpen, onInstall, installResult }: {
    draft: Draft
    t: (key: SshKey) => string
    secretSet: Record<string, boolean>
    status: MachineStatus | undefined
    busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
    dirty: SecretValues
    logLines: readonly string[]
    /** Whether the desktop bridge answers (the Open button only exists then). */
    bridgeOpen: boolean
    /** The visible error of a failed bridge open call, if any. */
    bridgeError: string | undefined
    onChange: (key: string, patch: Partial<MachineRow>) => void
    onSecret: (key: string, field: SecretFieldName, value: string) => void
    onRemove: (target: RemoveTarget) => void
    onTest: (id: string) => void
    onConnect: (id: string) => void
    onDisconnect: (id: string) => void
    onOpen: (id: string) => void
    onInstall: (id: string) => void
    installResult: InstallResult | undefined
  },
): ReactNode {
  const { row } = draft
  const connected = status?.state === 'connected'
  const held = status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting'
  const id = row.id
  const color = colorOf(row)
  return (
    <li
      className={css.rowCard}
      data-testid={`machine-${id}`}
      style={row.tintBorder === true && color !== undefined ? { borderColor: color } : undefined}
    >
      <div className={css.rowHead}>
        <span className={css.rowIdentity}>
          <StateDotOf status={status} />
          {color !== undefined
            ? <span className={css.colorPip} style={{ background: color }} aria-hidden="true" />
            : null}
          <span className={css.rowName}>{row.name === '' ? row.id : row.name}</span>
          <span className={css.rowTag}>{row.host}</span>
          <span className={css.status} data-testid={`status-${id}`}>{statusTextOf(status, t)}</span>
        </span>
        <span className={css.rowActions}>
          <Button variant="outline" size="sm" disabled={busy !== undefined || held} onClick={() => onTest(id)}>
            {t('test')}
          </Button>
          {connected
            ? (
                <>
                  {bridgeOpen
                    ? (
                        <Button variant="primary" size="sm" disabled={busy !== undefined} title={t('open.tip')} onClick={() => onOpen(id)}>
                          {t('open')}
                        </Button>
                      )
                    : null}
                  <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => onDisconnect(id)}>
                    {t('disconnect')}
                  </Button>
                </>
              )
            : (
                <Button variant="primary" size="sm" disabled={busy !== undefined || held} onClick={() => onConnect(id)}>
                  {t('connect')}
                </Button>
              )}
          <Button variant="ghost" size="sm" className={moduleClass(css.dangerAction)} disabled={busy !== undefined} onClick={() => onRemove({ key: draft.key, id, name: row.name === '' ? id : row.name })}>
            {t('remove')}
          </Button>
        </span>
      </div>
      <div className={css.editor}>
        <div className={css.grid}>
          <Field label={t('field.id')}>
            <Input
              className={moduleClass(css.fieldInput)}
              value={row.id}
              disabled
              onChange={event => onChange(draft.key, { id: event.target.value })}
            />
          </Field>
          <Field label={t('field.name')}>
            <Input
              className={moduleClass(css.fieldInput)}
              value={row.name}
              onChange={event => onChange(draft.key, { name: event.target.value })}
            />
          </Field>
          <Field label={t('field.host')}>
            <Input
              className={moduleClass(css.fieldInput)}
              value={row.host}
              onChange={event => onChange(draft.key, { host: event.target.value })}
            />
          </Field>
          <Field label={t('field.port')}>
            <Input
              className={moduleClass(css.fieldInput)}
              type="number"
              value={row.port}
              onChange={event => onChange(draft.key, { port: numberOf(event.target.value, DEFAULT_PORT) })}
            />
          </Field>
          <Field label={t('field.user')}>
            <Input
              className={moduleClass(css.fieldInput)}
              value={row.user}
              onChange={event => onChange(draft.key, { user: event.target.value })}
            />
          </Field>
          <Field label={t('field.remotePort')}>
            <Input
              className={moduleClass(css.fieldInput)}
              type="number"
              value={row.remotePort}
              onChange={event => onChange(draft.key, { remotePort: numberOf(event.target.value, DEFAULT_REMOTE_PORT) })}
            />
          </Field>
          <Field label={t('field.startCommand')}>
            <Input
              className={moduleClass(css.fieldInput)}
              value={row.startCommand ?? ''}
              onChange={event => onChange(draft.key, { startCommand: event.target.value })}
            />
          </Field>
        </div>
        <div className={css.grid}>
          <SecretField
            field="password"
            label={t('field.password')}
            keyName={draft.key}
            secretSet={secretSet}
            t={t}
            value={dirty.password ?? ''}
            onValue={onSecret}
          />
          <SecretField
            field="passphrase"
            label={t('field.passphrase')}
            keyName={draft.key}
            secretSet={secretSet}
            t={t}
            value={dirty.passphrase ?? ''}
            onValue={onSecret}
          />
        </div>
        <AppearanceEditor row={row} t={t} onChange={onChange} draftKey={draft.key} />
      </div>
      {status?.dshMissing === true
        ? <InstallPanel status={status} busy={busy} t={t} onInstall={() => onInstall(id)} />
        : null}
      {status?.lastError !== undefined ? <p className={css.statusError} role="alert">{status.lastError}</p> : null}
      {bridgeError !== undefined
        ? (
            <p className={css.statusError} role="alert" data-testid={`bridge-error-${id}`}>
              {t('bridge.error')}
              {bridgeError}
            </p>
          )
        : null}
      {status?.tunnelBaseUrl !== undefined ? <p className={css.link}>{status.tunnelBaseUrl}</p> : null}
      <LogStream id={id} lines={logLines} fallback={status?.progress?.log} />
      {installResult !== undefined
        ? <p className={css.installNote} data-testid={`install-note-${id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </li>
  )
}

/**
 * One read-only machine card from ~/.ssh/config: identity, status, and the
 * connection plane only — nothing here is stored or editable (no password,
 * no color, no delete).
 */
function DiscoveredCard({ row, t, status, busy, logLines, bridgeOpen, bridgeError, onTest, onConnect, onDisconnect, onOpen, onInstall, installResult }: {
  row: MachineRow
  t: (key: SshKey) => string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  logLines: readonly string[]
  bridgeOpen: boolean
  bridgeError: string | undefined
  onTest: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onOpen: (id: string) => void
  onInstall: (id: string) => void
  installResult: InstallResult | undefined
}): ReactNode {
  const connected = status?.state === 'connected'
  const held = status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting'
  return (
    <li className={css.rowCard} data-testid={`machine-${row.id}`}>
      <div className={css.rowHead}>
        <span className={css.rowIdentity}>
          <StateDotOf status={status} />
          <span className={css.rowName}>{row.name}</span>
          <span className={css.rowTag}>{t('configTag')}</span>
          <span className={css.status} data-testid={`status-${row.id}`}>{statusTextOf(status, t)}</span>
        </span>
        <span className={css.rowActions}>
          <Button variant="outline" size="sm" disabled={busy !== undefined || held} onClick={() => onTest(row.id)}>
            {t('test')}
          </Button>
          {connected
            ? (
                <>
                  {bridgeOpen
                    ? (
                        <Button variant="primary" size="sm" disabled={busy !== undefined} title={t('open.tip')} onClick={() => onOpen(row.id)}>
                          {t('open')}
                        </Button>
                      )
                    : null}
                  <Button variant="outline" size="sm" disabled={busy !== undefined} onClick={() => onDisconnect(row.id)}>
                    {t('disconnect')}
                  </Button>
                </>
              )
            : (
                <Button variant="primary" size="sm" disabled={busy !== undefined || held} onClick={() => onConnect(row.id)}>
                  {t('connect')}
                </Button>
              )}
        </span>
      </div>
      {status?.dshMissing === true
        ? <InstallPanel status={status} busy={busy} t={t} onInstall={() => onInstall(row.id)} />
        : null}
      {status?.lastError !== undefined ? <p className={css.statusError} role="alert">{status.lastError}</p> : null}
      {bridgeError !== undefined
        ? (
            <p className={css.statusError} role="alert" data-testid={`bridge-error-${row.id}`}>
              {t('bridge.error')}
              {bridgeError}
            </p>
          )
        : null}
      {status?.tunnelBaseUrl !== undefined ? <p className={css.link}>{status.tunnelBaseUrl}</p> : null}
      <LogStream id={row.id} lines={logLines} fallback={status?.progress?.log} />
      {installResult !== undefined
        ? <p className={css.installNote} data-testid={`install-note-${row.id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </li>
  )
}

/** The state dot: a primitive StateDot for live states, hollow CSS for idle. */
function StateDotOf({ status }: { status: MachineStatus | undefined }): ReactNode {
  const state = dotStateOf(status)
  if (state === 'idle')
    return <span className={css.stateDot} data-state="idle" aria-hidden="true" />
  return <StateDot state={state} size={8} />
}

/** The streaming log: the S2 event lines when present, else the progress log. */
function LogStream({ id, lines, fallback }: { id: string, lines: readonly string[], fallback: string | undefined }): ReactNode {
  const output = lines.length > 0
    ? lines.join('\n')
    : (fallback ?? '')
  if (output === '')
    return null
  return (
    <pre className={css.logStream} data-testid={`machine-log-${id}`}>
      {output}
    </pre>
  )
}

/** The dsh-missing install surface: a one-click install (the log lives in the card stream). */
function InstallPanel({ status, busy, t, onInstall }: {
  status: MachineStatus
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  t: (key: SshKey) => string
  onInstall: () => void
}): ReactNode {
  const installing = busy === 'install' || status.progress?.phase === 'installing'
  if (installing) {
    return (
      <div className={css.installBox}>
        <p className={css.installHint}>{t('progress.installing')}</p>
      </div>
    )
  }
  return (
    <div className={css.installBox}>
      <p className={css.installHint}>{t('install.hint')}</p>
      <Button variant="primary" size="sm" disabled={busy !== undefined} onClick={onInstall}>
        {t('install.action')}
      </Button>
    </div>
  )
}

/** One operator-facing line for a finished install. */
function installNoteOf(result: InstallResult, t: (key: SshKey) => string): string {
  if (result.credentialsError !== undefined) {
    return t('install.done.error') + result.credentialsError
  }
  return result.credentialsCopied ? t('install.done.copied') : t('install.done.nokey')
}

/** One labeled field row. */
function Field({ label, children }: { label: string, children: ReactNode }): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

/**
 * The appearance row of one machine card: an identity-color swatch set
 * (plus a "default" reset) and the tint-the-border switch, which is only
 * meaningful while a color is chosen. Clearing writes the empty-string
 * (off) form — the save path drops it.
 */
function AppearanceEditor({ row, t, onChange, draftKey }: {
  row: MachineRow
  t: (key: SshKey) => string
  onChange: (key: string, patch: Partial<MachineRow>) => void
  draftKey: string
}): ReactNode {
  const color = colorOf(row)
  return (
    <div className={css.appearance}>
      <span className={css.fieldLabel}>{t('field.color')}</span>
      <div className={css.swatches}>
        {COLOR_CHOICES.map(choice => (
          <button
            key={choice}
            type="button"
            className={css.swatch}
            data-selected={color === choice}
            style={{ '--swatch-color': choice } as CSSProperties}
            aria-label={`${t('field.color')}: ${choice}`}
            aria-pressed={color === choice}
            onClick={() => onChange(draftKey, { color: color === choice ? '' : choice })}
          />
        ))}
        <button
          type="button"
          className={`${css.swatch} ${css.swatchNone}`}
          data-selected={color === undefined}
          aria-label={t('color.none')}
          aria-pressed={color === undefined}
          title={t('color.none')}
          onClick={() => onChange(draftKey, { color: '', tintBorder: false })}
        />
        <span className={css.switchRow}>
          <button
            type="button"
            role="switch"
            aria-checked={row.tintBorder === true}
            className={css.switch}
            disabled={color === undefined}
            onClick={() => onChange(draftKey, { tintBorder: row.tintBorder !== true })}
          />
          <span className={css.fieldLabel}>{t('field.tintBorder')}</span>
        </span>
      </div>
    </div>
  )
}

/** One write-only secret input; the placeholder reports whether a value is stored. */
export function SecretField({ field, label, keyName, secretSet, t, value, onValue }: {
  field: SecretFieldName
  label: string
  keyName: string
  secretSet: Record<string, boolean>
  t: (key: SshKey) => string
  value: string
  onValue: (key: string, field: SecretFieldName, value: string) => void
}): ReactNode {
  const placeholder = secretSet[`${keyName}.${field}`] ? t('secret.set') : t('secret.unset')
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <Input
        className={moduleClass(css.fieldInput)}
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={event => onValue(keyName, field, event.target.value)}
      />
    </label>
  )
}

/** The write-only secret presence flags of one draft row, keyed like the stored sidecar. */
function secretFlagsOf(row: MachineRow): Record<string, boolean> {
  return {
    [`${row.id}.password`]: row.hasPassword,
    [`${row.id}.passphrase`]: row.hasPassphrase,
  }
}

/** The row's effective identity color ('' and undefined both mean none). */
function colorOf(row: MachineRow): string | undefined {
  return row.color === undefined || row.color === '' ? undefined : row.color
}

/** The connection-state dot vocabulary (StateDot states; idle renders hollow). */
function dotStateOf(status: MachineStatus | undefined): DotState {
  if (status?.state === 'connected')
    return 'done'
  if (status?.state === 'connecting' || status?.state === 'testing' || status?.state === 'reconnecting')
    return 'ongoing'
  if (status?.state === 'given-up')
    return 'error'
  return 'idle'
}

/** The status-label key of each lifecycle state (the hyphenated state maps to camelCase keys). */
const STATUS_KEY_OF: Record<MachineLifecycleState, SshKey> = {
  'disconnected': 'status.disconnected',
  'testing': 'status.testing',
  'connecting': 'status.connecting',
  'connected': 'status.connected',
  'reconnecting': 'status.reconnecting',
  'given-up': 'status.givenUp',
}

/** The status line: live progress text while an operation is in flight, else the state label. */
function statusTextOf(status: MachineStatus | undefined, t: (key: SshKey) => string): string {
  const progress = status?.progress
  if (progress?.phase === 'handshake')
    return t('progress.handshake')
  if (progress?.phase === 'starting')
    return t('progress.starting')
  if (progress?.phase === 'installing')
    return t('progress.installing')
  if (progress?.phase === 'probing') {
    return t('progress.probing')
      .replace('{attempt}', String(progress.attempt ?? '?'))
      .replace('{total}', String(progress.total ?? '?'))
  }
  const base = status === undefined
    ? t('status.disconnected')
    : t(STATUS_KEY_OF[status.state])
  if (status?.state === 'reconnecting' && status.nextRetryHint !== undefined && status.nextRetryHint !== '') {
    return base + t('status.nextRetry').replace('{hint}', status.nextRetryHint)
  }
  return base
}

/** Parse a number input; non-numbers fall back to the default. */
function numberOf(raw: string, fallback: number): number {
  const parsed = Number(raw)
  return raw !== '' && Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Resolve one (possibly absent) CSS-module class for a primitive's optional
 * className seat: the module map reads as `string | undefined`, and
 * exactOptionalPropertyTypes forbids passing undefined where the prop is
 * merely optional.
 */
function moduleClass(name: string | undefined): string {
  return name ?? ''
}

/** One operator-facing description of a bridge failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The add-machine dialog: one focused form, saved immediately on submit
 * (the parent appends the row to the store). The id auto-derives from the
 * host until the operator touches the field. Remount per open (the parent
 * keys it by the open flag) so every open starts from a clean form.
 */
function AddMachineDialog({ t, saving, takenIds, onSubmit, onClose }: {
  t: (key: SshKey) => string
  saving: boolean
  /** Ids the new machine must not collide with. */
  takenIds: ReadonlySet<string>
  onSubmit: (row: MachineRow) => void
  onClose: () => void
}): ReactNode {
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [user, setUser] = useState('')
  const [remotePort, setRemotePort] = useState(String(DEFAULT_REMOTE_PORT))

  const slug = slugOf(host)
  const effectiveId = idTouched ? id.trim() : (slug === '' ? '' : freeIdOf(slug, takenIds))
  const trimmedHost = host.trim()
  const errorKey: SshKey | null
    = trimmedHost === '' ? 'add.host_required'
      : !ID_PATTERN.test(effectiveId) ? 'add.id_invalid'
        : takenIds.has(effectiveId) ? 'add.id_taken'
          : null

  function submit(): void {
    if (errorKey !== null || saving)
      return
    onSubmit({
      id: effectiveId,
      name: name.trim() === '' ? effectiveId : name.trim(),
      host: trimmedHost,
      port: numberOf(port, DEFAULT_PORT),
      user: user.trim(),
      hasPassword: false,
      hasPassphrase: false,
      remotePort: numberOf(remotePort, DEFAULT_REMOTE_PORT),
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('add.title')}
      closeLabel={t('add.cancel')}
      footer={(
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>{t('add.cancel')}</Button>
          <Button variant="primary" disabled={saving || errorKey !== null} onClick={submit}>{t('add.submit')}</Button>
        </>
      )}
    >
      <div className={cls.grid}>
        <Field label={t('field.host')}>
          <Input
            className={cls.fieldInput}
            value={host}
            autoFocus
            disabled={saving}
            onChange={event => setHost(event.target.value)}
          />
        </Field>
        <Field label={t('field.name')}>
          <Input className={cls.fieldInput} value={name} disabled={saving} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('field.id')}>
          <Input
            className={cls.fieldInput}
            value={idTouched ? id : effectiveId}
            placeholder={t('add.id_auto')}
            disabled={saving}
            onChange={(event) => {
              setIdTouched(true)
              setId(event.target.value)
            }}
          />
        </Field>
        <Field label={t('field.user')}>
          <Input className={cls.fieldInput} value={user} disabled={saving} onChange={event => setUser(event.target.value)} />
        </Field>
        <Field label={t('field.port')}>
          <Input className={cls.fieldInput} value={port} disabled={saving} onChange={event => setPort(event.target.value)} />
        </Field>
        <Field label={t('field.remotePort')}>
          <Input className={cls.fieldInput} value={remotePort} disabled={saving} onChange={event => setRemotePort(event.target.value)} />
        </Field>
      </div>
      {errorKey === null
        ? <p className={cls.hint}>{t('add.id_auto')}</p>
        : <p className={cls.error} role="alert">{t(errorKey)}</p>}
    </Modal>
  )
}

/**
 * Render the SSH-machines settings page.
 * @returns the page element tree.
 */
export function MachinesSection({ t, store, bridge }: MachinesSectionProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirty, setDirty] = useState<DirtySecrets>({})
  const [addOpen, setAddOpen] = useState(false)
  const [addSaving, setAddSaving] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [availability, setAvailability] = useState<BridgeAvailability>(() => bridge?.probe === undefined ? 'web' : 'unknown')
  const [bridgeErrors, setBridgeErrors] = useState<Record<string, string>>({})
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)

  useEffect(() => {
    void store.load()
  }, [store])

  // Probe the desktop bridge once: an answer means the popup affordance
  // exists; a timeout or rejection means pure web, where it never shows.
  // (No bridge at all settled synchronously in the initial state.)
  useEffect(() => {
    const probe = bridge?.probe
    if (probe === undefined)
      return
    let current = true
    probe().then(
      () => {
        if (current)
          setAvailability('desktop')
      },
      () => {
        if (current)
          setAvailability('web')
      },
    )
    return () => {
      current = false
    }
  }, [bridge])

  // While any machine has an operation in flight, poll the host every 1.5 s
  // so the live progress (handshake / starting / probing) and the event log
  // stay current.
  const anyInFlight = Object.keys(state.busy).length > 0
    || Object.values(state.statuses).some(status =>
      status.state === 'connecting' || status.state === 'reconnecting' || status.state === 'testing')
  useEffect(() => {
    if (!anyInFlight)
      return
    const timer = setInterval(() => void store.poll(), 1500)
    return () => clearInterval(timer)
  }, [anyInFlight, store])

  // Initialize the draft buffer once the first load lands; later loads keep
  // the operator's in-progress edits (the buffer is the source until save).
  useEffect(() => {
    if (initialized || state.status !== 'ready')
      return
    // eslint-disable-next-line react/set-state-in-effect -- load-once hydration: the draft buffer cannot exist before the first machine.list lands, and must not reset on later loads
    setInitialized(true)
    // eslint-disable-next-line react/set-state-in-effect -- same hydrate-once guard as setInitialized above
    setDrafts(Object.fromEntries(state.machines.map(row => [row.id, { key: row.id, row: { ...row } }])))
  }, [initialized, state.status, state.machines])

  const patchDraft = (key: string, patch: Partial<MachineRow>): void => {
    setDrafts(previous => ({
      ...previous,
      [key]: { key, row: { ...previous[key]!.row, ...patch } },
    }))
  }

  const patchDirty = (key: string, field: SecretFieldName, value: string): void => {
    setDirty(previous => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
  }

  const addMachine = (): void => {
    setAddOpen(true)
  }

  /** Add = create-and-save now: persist the saved set plus the new row; other
   *  staged edits stay staged (we pass state.machines, not the drafts). */
  const submitAdd = async (row: MachineRow): Promise<void> => {
    setAddSaving(true)
    const ok = await store.persist([...store.getSnapshot().machines, row], {})
    setAddSaving(false)
    if (!ok)
      return
    setDrafts(previous => ({ ...previous, [row.id]: { key: row.id, row: { ...row } } }))
    setAddOpen(false)
  }

  const confirmRemove = (): void => {
    if (removeTarget === null)
      return
    const { key, id } = removeTarget
    setRemoveTarget(null)
    // 删除立即生效：确认即调 machine.remove，成功后摘掉草稿与脏密钥
    void store.remove(id).then((ok) => {
      if (!ok)
        return
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
      setDirty((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
    })
  }

  /** Ask the desktop shell for the remote window; failures surface per machine. */
  const openRemoteWindow = (id: string): void => {
    const url = state.statuses[id]?.tunnelBaseUrl
    if (url === undefined || bridge === undefined)
      return
    bridge.openWindow(id, url).then(
      () => {
        setBridgeErrors((previous) => {
          if (previous[id] === undefined)
            return previous
          const next = { ...previous }
          delete next[id]
          return next
        })
      },
      (error: unknown) => {
        setBridgeErrors(previous => ({ ...previous, [id]: messageOf(error) }))
      },
    )
  }

  const invalid = Object.values(drafts).some(draft =>
    draft.row.id === '' || draft.row.name === '' || draft.row.host === '')

  const save = (): void => {
    void store.persist(Object.values(drafts).map(draft => draft.row), dirty)
  }

  const bridgeOpen = availability === 'desktop'

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.chrome}>
        <Button variant="outline" disabled={state.status === 'loading'} onClick={() => void store.load()}>
          {t('refresh')}
        </Button>
        <Button variant="outline" className={moduleClass(css.addAction)} disabled={state.status === 'loading'} onClick={addMachine}>
          {t('addMachine')}
        </Button>
        <Button variant="primary" disabled={invalid || state.status === 'loading'} onClick={save}>
          {t('save')}
        </Button>
      </div>
      {state.notice !== null ? <p className={css.notice} data-testid="notice">{state.notice}</p> : null}
      {state.error !== null
        ? (
            <p className={css.error} role="alert">
              {t('error.banner')}
              {state.error}
            </p>
          )
        : null}
      {invalid ? <p className={css.hint}>{t('saveHint')}</p> : null}
      {state.status === 'loading' ? <p className={css.hint}>{t('loading')}</p> : null}
      {state.status === 'error'
        ? (
            <div className={css.emptyBlock}>
              <p className={css.empty}>{t('loadFailed')}</p>
              <Button variant="outline" size="sm" onClick={() => void store.load()}>{t('refresh')}</Button>
            </div>
          )
        : null}
      {state.status === 'ready' && Object.keys(drafts).length === 0 && state.discovered.length === 0
        ? <p className={css.empty}>{t('empty')}</p>
        : null}
      {state.discovered.length > 0
        ? (
            <>
              <div className={css.group}>
                <h3 className={css.groupTitle}>{t('configHosts')}</h3>
                <p className={css.groupHint}>{t('configHostsHint')}</p>
              </div>
              <ul className={css.rows}>
                {state.discovered.map(row => (
                  <DiscoveredCard
                    key={row.id}
                    row={row}
                    t={t}
                    status={state.statuses[row.id]}
                    busy={state.busy[row.id]}
                    logLines={state.logs[row.id] ?? []}
                    bridgeOpen={bridgeOpen}
                    bridgeError={bridgeErrors[row.id]}
                    installResult={state.installResults[row.id]}
                    onTest={id => void store.test(id)}
                    onConnect={id => void store.connect(id)}
                    onDisconnect={id => void store.disconnect(id)}
                    onInstall={id => void store.install(id)}
                    onOpen={openRemoteWindow}
                  />
                ))}
              </ul>
            </>
          )
        : null}
      <ul className={css.rows}>
        {Object.values(drafts).map(draft => (
          <MachineCard
            key={draft.key}
            draft={draft}
            t={t}
            secretSet={secretFlagsOf(draft.row)}
            status={state.statuses[draft.row.id]}
            busy={state.busy[draft.row.id]}
            logLines={state.logs[draft.row.id] ?? []}
            bridgeOpen={bridgeOpen}
            bridgeError={bridgeErrors[draft.row.id]}
            installResult={state.installResults[draft.row.id]}
            dirty={dirty[draft.key] ?? {}}
            onChange={patchDraft}
            onSecret={patchDirty}
            onRemove={setRemoveTarget}
            onTest={id => void store.test(id)}
            onConnect={id => void store.connect(id)}
            onDisconnect={id => void store.disconnect(id)}
            onInstall={id => void store.install(id)}
            onOpen={openRemoteWindow}
          />
        ))}
      </ul>
      <SyncPanel store={store} t={t} />
      {addOpen
        ? (
            <AddMachineDialog
              t={t}
              saving={addSaving}
              takenIds={new Set([...state.machines.map(row => row.id), ...Object.values(drafts).map(draft => draft.row.id)])}
              onSubmit={row => void submitAdd(row)}
              onClose={() => {
                if (!addSaving)
                  setAddOpen(false)
              }}
            />
          )
        : null}
      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t('remove.confirm.title')}
        closeLabel={t('remove.confirm.cancel')}
        description={removeTarget === null ? '' : t('remove.confirm.description').replace('{name}', removeTarget.name)}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>{t('remove.confirm.cancel')}</Button>
            <Button variant="primary" className={moduleClass(css.dangerAction)} onClick={confirmRemove}>{t('remove.confirm.ok')}</Button>
          </>
        )}
      />
    </div>
  )
}
