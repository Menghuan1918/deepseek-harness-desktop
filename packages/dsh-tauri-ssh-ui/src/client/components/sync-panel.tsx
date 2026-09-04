'use no memo'

/**
 * The sync-to-remote panel: pick a connected target machine, multi-select
 * local plugins and user-level skills (independent Set semantics — the old
 * desktop panel behaved like a radio group over its chips, silently dropping
 * every earlier pick), then sync. Every requested item settles into a
 * per-item outcome row — partial failures render with their reasons instead
 * of vanishing into a success toast. All domain state lives in the injected
 * {@link MachinesStore}; only the selection is local.
 * @module dsh-tauri-ssh-ui/client/components/sync-panel
 */

import type { ReactNode } from 'react'
import type { SshKey } from '../locales/index.js'
import type { MachineRow, MachinesStore } from '../store/index.js'
import type { SyncItemResult } from '../types/index.js'
import { Button, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toggleSelection } from '../store/index.js'
import css from './machines-section.module.css'

/** The panel props: the framework `t` seat plus the injected store. */
export interface SyncPanelProps {
  store: MachinesStore
  t: (key: SshKey) => string
}

/** Render the sync panel over the store snapshot. */
export function SyncPanel({ store, t }: SyncPanelProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [targetId, setTargetId] = useState<string | null>(null)

  useEffect(() => {
    if (state.sync.status === 'idle')
      void store.loadSyncPreview()
  }, [state.sync.status, store])

  const connected = connectedMachinesOf(state.machines, state.discovered, state.statuses)
  const target = connected.find(machine => machine.id === (targetId ?? connected[0]?.id))
  const preview = state.sync.preview
  const selectedPlugins = preview?.plugins.filter(plugin => selected.has(`plugin:${plugin.spec}`)) ?? []
  const selectedSkills = preview?.skills.filter(skill => selected.has(`skill:${skill.root}:${skill.name}`)) ?? []
  const canApply = target !== undefined && !state.sync.applying && (selectedPlugins.length > 0 || selectedSkills.length > 0)

  const apply = (): void => {
    if (target === undefined)
      return
    void store.applySync(target.id, selectedPlugins, selectedSkills)
  }

  return (
    <section className={css.syncPanel} data-testid="sync-panel">
      <h3 className={css.groupTitle}>{t('sync.title')}</h3>
      <p className={css.groupHint}>{t('sync.desc')}</p>
      {connected.length === 0
        ? <p className={css.hint}>{t('sync.notConnected')}</p>
        : (
            <>
              <div className={css.syncTargets}>
                <span className={css.fieldLabel}>{t('sync.target')}</span>
                {connected.map(machine => (
                  <Pill
                    key={machine.id}
                    active={machine.id === target?.id}
                    onClick={() => setTargetId(machine.id)}
                    aria-pressed={machine.id === target?.id}
                  >
                    {machine.name}
                  </Pill>
                ))}
              </div>
              {state.sync.status === 'error'
                ? null
                : preview === null || state.sync.status === 'loading'
                  ? <p className={css.hint}>{t('loading')}</p>
                  : (
                      <div className={css.syncGroups}>
                        <div className={css.syncGroup}>
                          <span className={css.fieldLabel}>{t('sync.plugins')}</span>
                          {preview.plugins.length === 0
                            ? <p className={css.hint}>{t('sync.noPlugins')}</p>
                            : (
                                <ul className={css.syncItems}>
                                  {preview.plugins.map(plugin => (
                                    <li key={`plugin:${plugin.spec}`} className={css.syncItem}>
                                      <Pill
                                        active={selected.has(`plugin:${plugin.spec}`)}
                                        disabled={!plugin.syncable}
                                        title={plugin.syncable ? undefined : plugin.reason}
                                        aria-pressed={selected.has(`plugin:${plugin.spec}`)}
                                        data-testid={`sync-plugin-${plugin.name}`}
                                        onClick={() => setSelected(current => toggleSelection(current, `plugin:${plugin.spec}`))}
                                      >
                                        {plugin.name}
                                      </Pill>
                                      {!plugin.syncable && plugin.reason !== undefined
                                        ? <span className={css.syncReason}>{plugin.reason}</span>
                                        : null}
                                    </li>
                                  ))}
                                </ul>
                              )}
                        </div>
                        <div className={css.syncGroup}>
                          <span className={css.fieldLabel}>{t('sync.skills')}</span>
                          {preview.skills.length === 0
                            ? <p className={css.hint}>{t('sync.noSkills')}</p>
                            : (
                                <ul className={css.syncItems}>
                                  {preview.skills.map(skill => (
                                    <li key={`skill:${skill.root}:${skill.name}`} className={css.syncItem}>
                                      <Pill
                                        active={selected.has(`skill:${skill.root}:${skill.name}`)}
                                        aria-pressed={selected.has(`skill:${skill.root}:${skill.name}`)}
                                        data-testid={`sync-skill-${skill.root}-${skill.name}`}
                                        onClick={() => setSelected(current => toggleSelection(current, `skill:${skill.root}:${skill.name}`))}
                                      >
                                        {skill.name}
                                        <span className={css.syncRoot}>{skill.root}</span>
                                      </Pill>
                                    </li>
                                  ))}
                                </ul>
                              )}
                        </div>
                      </div>
                    )}
              <div className={css.syncActions}>
                <Button variant="primary" size="sm" disabled={!canApply} data-testid="sync-apply" onClick={apply}>
                  {state.sync.applying ? t('sync.applying') : t('sync.apply')}
                </Button>
                <Button variant="outline" size="sm" disabled={state.sync.status === 'loading'} onClick={() => void store.loadSyncPreview()}>
                  {t('sync.refresh')}
                </Button>
              </div>
            </>
          )}
      {state.sync.status === 'error'
        ? (
            <p className={css.error} role="alert">
              {t('sync.loadFailed')}
              {state.sync.error}
            </p>
          )
        : null}
      {state.sync.error !== null && state.sync.status !== 'error'
        ? (
            <p className={css.error} role="alert">
              {t('sync.applyFailed')}
              {state.sync.error}
            </p>
          )
        : null}
      {state.sync.results !== null
        ? <SyncResults results={state.sync.results} t={t} />
        : null}
    </section>
  )
}

/** The per-item outcome list: every requested item, success and failure alike. */
function SyncResults({ results, t }: { results: SyncItemResult[], t: (key: SshKey) => string }): ReactNode {
  const okCount = results.filter(item => item.ok).length
  return (
    <div className={css.syncResults} data-testid="sync-results">
      <p className={css.syncSummary}>{t('sync.done').replace('{ok}', String(okCount)).replace('{total}', String(results.length))}</p>
      <ul className={css.syncItems}>
        {results.map(item => (
          <li
            key={`${item.kind}:${item.root ?? ''}:${item.name}`}
            className={css.syncResult}
            data-testid={`sync-result-${item.name}`}
            data-ok={item.ok}
          >
            <StateDot state={item.ok ? 'done' : 'error'} size={8} />
            <span className={css.syncResultName}>
              {item.name}
              {item.root !== undefined ? ` (${item.root})` : ''}
            </span>
            {item.ok
              ? <span className={css.syncOk}>{t('sync.itemOk')}</span>
              : (
                  <span className={css.statusError} role="alert">
                    {t('sync.itemFailed')}
                    {item.error === undefined ? '' : `：${item.error}`}
                  </span>
                )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The connected machines, manual first then discovered, in list order. */
function connectedMachinesOf(
  machines: readonly MachineRow[],
  discovered: readonly MachineRow[],
  statuses: Record<string, { state: string }>,
): MachineRow[] {
  return [...machines, ...discovered].filter(machine => statuses[machine.id]?.state === 'connected')
}
