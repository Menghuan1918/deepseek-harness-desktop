'use no memo'

/**
 * The SSH-machines settings section, in the DSH settings design language
 * (see packages/client/ui-models ModelsSection.module.css): token-resolved
 * colors, 32px fields, capsule controls, hairline row cards. One card per
 * machine with the config form (secrets write-only), the connection plane
 * (test/connect/open/disconnect), and the save/refresh chrome. All state
 * lives in the injected {@link MachinesStore}; the component is a thin
 * renderer over its snapshot.
 * @module dsh-tauri-ssh-ui/client/components/machines-section
 */

import type { CSSProperties, ReactNode } from 'react'
import type { SshKey } from '../locales/index.js'
import type { InstallResult, MachineRow, MachinesStore, MachineStatus, SecretValues } from '../store/index.js'
import { useEffect, useState, useSyncExternalStore } from 'react'
import css from './machines-section.module.css'

/** Registrant-owned dependencies of the section. */
export interface MachinesSectionInjected {
  store: MachinesStore
}

/** Full section props: the framework `t` seat plus the injected store. */
export interface MachinesSectionProps extends MachinesSectionInjected {
  t: (key: SshKey) => string
}

/** One editable draft row (a `new-…` key marks an unsaved machine). */
interface Draft {
  key: string
  row: MachineRow
}

/** The dirty-secret map the form carries: machine key → typed secret values. */
type DirtySecrets = Record<string, SecretValues>

/** A secret field name. */
export type SecretFieldName = 'password' | 'passphrase'

/** The connection-state dot data attribute (the StateDot vocabulary). */
type DotState = 'done' | 'ongoing' | 'idle'

const DEFAULT_PORT = 22
const DEFAULT_REMOTE_PORT = 3080

/** window.open features for the Open action: a real popup window, not a tab. */
export const OPEN_WINDOW_FEATURES = 'width=1280,height=860,noopener'

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
  { draft, t, secretSet, status, busy, dirty, onChange, onSecret, onRemove, onTest, onConnect, onDisconnect, onOpen, onInstall, installResult }: {
    draft: Draft
    t: (key: SshKey) => string
    secretSet: Record<string, boolean>
    status: MachineStatus | undefined
    busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
    dirty: SecretValues
    onChange: (key: string, patch: Partial<MachineRow>) => void
    onSecret: (key: string, field: SecretFieldName, value: string) => void
    onRemove: (key: string) => void
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
  const connecting = status?.state === 'connecting'
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
          <span className={css.stateDot} data-state={dotStateOf(status)} aria-hidden="true" />
          {color !== undefined
            ? <span className={css.colorPip} style={{ background: color }} aria-hidden="true" />
            : null}
          <span className={css.rowName}>{row.name === '' ? row.id : row.name}</span>
          <span className={css.rowTag}>{row.host}</span>
          <span className={css.status} data-testid={`status-${id}`}>{statusTextOf(status, t)}</span>
        </span>
        <span className={css.rowActions}>
          <button
            type="button"
            className={`${css.button} ${css.secondary} ${css.sm}`}
            disabled={busy !== undefined || connecting}
            onClick={() => onTest(id)}
          >
            {t('test')}
          </button>
          {connected
            ? (
                <>
                  <button
                    type="button"
                    className={`${css.button} ${css.primary} ${css.sm}`}
                    disabled={busy !== undefined}
                    title={t('open.tip')}
                    onClick={() => onOpen(id)}
                  >
                    {t('open')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.secondary} ${css.sm}`}
                    disabled={busy !== undefined}
                    onClick={() => onDisconnect(id)}
                  >
                    {t('disconnect')}
                  </button>
                </>
              )
            : (
                <button
                  type="button"
                  className={`${css.button} ${css.primary} ${css.sm}`}
                  disabled={busy !== undefined || connecting}
                  onClick={() => onConnect(id)}
                >
                  {t('connect')}
                </button>
              )}
          <button
            type="button"
            className={`${css.button} ${css.danger} ${css.sm}`}
            disabled={busy !== undefined}
            onClick={() => onRemove(draft.key)}
          >
            {t('remove')}
          </button>
        </span>
      </div>
      <div className={css.editor}>
        <div className={css.grid}>
          <Field label={t('field.id')}>
            <input
              className={css.input}
              value={row.id}
              disabled={!draft.key.startsWith('new-')}
              onChange={event => onChange(draft.key, { id: event.target.value })}
            />
          </Field>
          <Field label={t('field.name')}>
            <input
              className={css.input}
              value={row.name}
              onChange={event => onChange(draft.key, { name: event.target.value })}
            />
          </Field>
          <Field label={t('field.host')}>
            <input
              className={css.input}
              value={row.host}
              onChange={event => onChange(draft.key, { host: event.target.value })}
            />
          </Field>
          <Field label={t('field.port')}>
            <input
              className={css.input}
              type="number"
              value={row.port}
              onChange={event => onChange(draft.key, { port: numberOf(event.target.value, DEFAULT_PORT) })}
            />
          </Field>
          <Field label={t('field.user')}>
            <input
              className={css.input}
              value={row.user}
              onChange={event => onChange(draft.key, { user: event.target.value })}
            />
          </Field>
          <Field label={t('field.remotePort')}>
            <input
              className={css.input}
              type="number"
              value={row.remotePort}
              onChange={event => onChange(draft.key, { remotePort: numberOf(event.target.value, DEFAULT_REMOTE_PORT) })}
            />
          </Field>
          <Field label={t('field.startCommand')}>
            <input
              className={css.input}
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
      {status?.tunnelBaseUrl !== undefined ? <p className={css.link}>{status.tunnelBaseUrl}</p> : null}
      {installResult !== undefined
        ? <p className={css.installNote} data-testid={`install-note-${id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </li>
  )
}

/**
 * One read-only machine card from ~/.ssh/config: identity, status, and the
 *  connection plane only — nothing here is stored or editable.
 */
function DiscoveredCard({ row, t, status, busy, onTest, onConnect, onDisconnect, onOpen, onInstall, installResult }: {
  row: MachineRow
  t: (key: SshKey) => string
  status: MachineStatus | undefined
  busy: 'test' | 'connect' | 'disconnect' | 'install' | undefined
  onTest: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onOpen: (id: string) => void
  onInstall: (id: string) => void
  installResult: InstallResult | undefined
}): ReactNode {
  const connected = status?.state === 'connected'
  const connecting = status?.state === 'connecting'
  return (
    <li className={css.rowCard} data-testid={`machine-${row.id}`}>
      <div className={css.rowHead}>
        <span className={css.rowIdentity}>
          <span className={css.stateDot} data-state={dotStateOf(status)} aria-hidden="true" />
          <span className={css.rowName}>{row.name}</span>
          <span className={css.rowTag}>{t('configTag')}</span>
          <span className={css.status} data-testid={`status-${row.id}`}>{statusTextOf(status, t)}</span>
        </span>
        <span className={css.rowActions}>
          <button
            type="button"
            className={`${css.button} ${css.secondary} ${css.sm}`}
            disabled={busy !== undefined || connecting}
            onClick={() => onTest(row.id)}
          >
            {t('test')}
          </button>
          {connected
            ? (
                <>
                  <button
                    type="button"
                    className={`${css.button} ${css.primary} ${css.sm}`}
                    disabled={busy !== undefined}
                    title={t('open.tip')}
                    onClick={() => onOpen(row.id)}
                  >
                    {t('open')}
                  </button>
                  <button
                    type="button"
                    className={`${css.button} ${css.secondary} ${css.sm}`}
                    disabled={busy !== undefined}
                    onClick={() => onDisconnect(row.id)}
                  >
                    {t('disconnect')}
                  </button>
                </>
              )
            : (
                <button
                  type="button"
                  className={`${css.button} ${css.primary} ${css.sm}`}
                  disabled={busy !== undefined || connecting}
                  onClick={() => onConnect(row.id)}
                >
                  {t('connect')}
                </button>
              )}
        </span>
      </div>
      {status?.dshMissing === true
        ? <InstallPanel status={status} busy={busy} t={t} onInstall={() => onInstall(row.id)} />
        : null}
      {status?.lastError !== undefined ? <p className={css.statusError} role="alert">{status.lastError}</p> : null}
      {status?.tunnelBaseUrl !== undefined ? <p className={css.link}>{status.tunnelBaseUrl}</p> : null}
      {installResult !== undefined
        ? <p className={css.installNote} data-testid={`install-note-${row.id}`}>{installNoteOf(installResult, t)}</p>
        : null}
    </li>
  )
}

/** The dsh-missing install surface: a one-click install, or the live log while it runs. */
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
        <pre className={css.installLog} data-testid="install-log">{status.progress?.log ?? ''}</pre>
      </div>
    )
  }
  return (
    <div className={css.installBox}>
      <p className={css.installHint}>{t('install.hint')}</p>
      <button
        type="button"
        className={`${css.button} ${css.primary} ${css.sm}`}
        disabled={busy !== undefined}
        onClick={onInstall}
      >
        {t('install.action')}
      </button>
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
      <input
        className={css.input}
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

/** The connection-state dot color vocabulary. */
function dotStateOf(status: MachineStatus | undefined): DotState {
  if (status?.state === 'connected')
    return 'done'
  if (status?.state === 'connecting')
    return 'ongoing'
  return 'idle'
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
  if (status?.state === 'connected')
    return t('status.connected')
  if (status?.state === 'connecting')
    return t('status.connecting')
  return t('status.disconnected')
}

/** Parse a number input; non-numbers fall back to the default. */
function numberOf(raw: string, fallback: number): number {
  const parsed = Number(raw)
  return raw !== '' && Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Render the SSH-machines settings page.
 * @returns the page element tree.
 */
export function MachinesSection({ t, store }: MachinesSectionProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dirty, setDirty] = useState<DirtySecrets>({})
  const [addCounter, setAddCounter] = useState(0)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    void store.load()
  }, [store])

  // While any machine has an operation in flight, poll the host every 1.5 s
  // so the live progress (handshake / starting / probing) stays current.
  const anyInFlight = Object.keys(state.busy).length > 0
    || Object.values(state.statuses).some(status => status.state === 'connecting')
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
    const key = `new-${addCounter}`
    setAddCounter(addCounter + 1)
    setDrafts(previous => ({
      ...previous,
      [key]: {
        key,
        row: {
          id: '',
          name: '',
          host: '',
          port: DEFAULT_PORT,
          user: '',
          hasPassword: false,
          hasPassphrase: false,
          remotePort: DEFAULT_REMOTE_PORT,
        },
      },
    }))
  }

  const removeDraft = (key: string): void => {
    setDrafts((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  const invalid = Object.values(drafts).some(draft =>
    draft.row.id === '' || draft.row.name === '' || draft.row.host === '')

  const save = (): void => {
    void store.persist(Object.values(drafts).map(draft => draft.row), dirty)
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.chrome}>
        <button
          type="button"
          className={`${css.button} ${css.secondary}`}
          disabled={state.status === 'loading'}
          onClick={() => void store.load()}
        >
          {t('refresh')}
        </button>
        <button
          type="button"
          className={`${css.button} ${css.add}`}
          disabled={state.status === 'loading'}
          onClick={addMachine}
        >
          {t('addMachine')}
        </button>
        <button
          type="button"
          className={`${css.button} ${css.primary}`}
          disabled={invalid || state.status === 'loading'}
          onClick={save}
        >
          {t('save')}
        </button>
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
                    installResult={state.installResults[row.id]}
                    onTest={id => void store.test(id)}
                    onConnect={id => void store.connect(id)}
                    onDisconnect={id => void store.disconnect(id)}
                    onInstall={id => void store.install(id)}
                    onOpen={(id) => {
                      const tunnelBaseUrl = state.statuses[id]?.tunnelBaseUrl
                      if (tunnelBaseUrl !== undefined)
                        window.open(tunnelBaseUrl, '_blank', OPEN_WINDOW_FEATURES)
                    }}
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
            installResult={state.installResults[draft.row.id]}
            dirty={dirty[draft.key] ?? {}}
            onChange={patchDraft}
            onSecret={patchDirty}
            onRemove={removeDraft}
            onTest={id => void store.test(id)}
            onConnect={id => void store.connect(id)}
            onDisconnect={id => void store.disconnect(id)}
            onInstall={id => void store.install(id)}
            onOpen={(id) => {
              const tunnelBaseUrl = state.statuses[id]?.tunnelBaseUrl
              if (tunnelBaseUrl !== undefined)
                window.open(tunnelBaseUrl, '_blank', OPEN_WINDOW_FEATURES)
            }}
          />
        ))}
      </ul>
    </div>
  )
}
