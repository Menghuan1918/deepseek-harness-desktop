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
import type { SshKey } from '../locales/index'
import type { MachineRow, MachinesStore } from '../store/index'
import type { SyncItemResult } from '../types/index'
import { Button, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { toggleSelection } from '../store/index'
import { cls } from '../styles'

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
    <section className={cls.section} data-testid="sync-panel">
      <div className={cls.sectionHead}>
        <div>
          <h2 className={cls.title}>{t('sync.title')}</h2>
          <p className={cls.intro}>{t('sync.desc')}</p>
        </div>
      </div>
      {connected.length === 0
        ? <p className={cls.hint}>{t('sync.notConnectedHint')}</p>
        : (
            <>
              <div className={cls.syncTargets}>
                <span className={cls.fieldLabel}>{t('sync.target')}</span>
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
                  ? <p className={cls.hint}>{t('loading')}</p>
                  : (
                      <div className={cls.syncGroups}>
                        <div className={cls.syncGroup}>
                          <span className={cls.fieldLabel}>{t('sync.plugins')}</span>
                          {preview.plugins.length === 0
                            ? <p className={cls.hint}>{t('sync.noPlugins')}</p>
                            : (
                                <ul className={cls.syncItems}>
                                  {preview.plugins.map(plugin => (
                                    <li key={`plugin:${plugin.spec}`} className={cls.syncItem}>
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
                                        ? <span className={cls.syncReason}>{plugin.reason}</span>
                                        : null}
                                    </li>
                                  ))}
                                </ul>
                              )}
                        </div>
                        <div className={cls.syncGroup}>
                          <span className={cls.fieldLabel}>{t('sync.skills')}</span>
                          {preview.skills.length === 0
                            ? <p className={cls.hint}>{t('sync.noSkills')}</p>
                            : (
                                <ul className={cls.syncItems}>
                                  {preview.skills.map(skill => (
                                    <li key={`skill:${skill.root}:${skill.name}`} className={cls.syncItem}>
                                      <Pill
                                        active={selected.has(`skill:${skill.root}:${skill.name}`)}
                                        aria-pressed={selected.has(`skill:${skill.root}:${skill.name}`)}
                                        data-testid={`sync-skill-${skill.root}-${skill.name}`}
                                        onClick={() => setSelected(current => toggleSelection(current, `skill:${skill.root}:${skill.name}`))}
                                      >
                                        {skill.name}
                                        <span className={cls.syncRoot}>{skill.root}</span>
                                      </Pill>
                                    </li>
                                  ))}
                                </ul>
                              )}
                        </div>
                      </div>
                    )}
              <div className={cls.syncActions}>
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
            <p className={cls.error} role="alert">
              {t('sync.loadFailed')}
              {state.sync.error}
            </p>
          )
        : null}
      {state.sync.error !== null && state.sync.status !== 'error'
        ? (
            <p className={cls.error} role="alert">
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
    <div className={cls.syncResults} data-testid="sync-results">
      <p className={cls.syncSummary}>{t('sync.done').replace('{ok}', String(okCount)).replace('{total}', String(results.length))}</p>
      <ul className={cls.syncItems}>
        {results.map(item => (
          <li
            key={`${item.kind}:${item.root ?? ''}:${item.name}`}
            className={cls.syncResult}
            data-testid={`sync-result-${item.name}`}
            data-ok={item.ok}
          >
            <StateDot state={item.ok ? 'done' : 'error'} size={8} />
            <span className={cls.syncResultName}>
              {item.name}
              {item.root !== undefined ? ` (${item.root})` : ''}
            </span>
            {item.ok
              ? <span className={cls.syncOk}>{t('sync.itemOk')}</span>
              : (
                  <span className={cls.statusError} role="alert">
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
