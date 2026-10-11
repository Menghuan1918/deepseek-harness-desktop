import type { ReactNode } from 'react'
import type { RemoteKey } from '../locales/index'
import type { AccessAddress, AccessScope, AccessStatus, TunnelMode, TunnelProgress } from '../types/index'
import { Button, Field, Input, SegmentedControl, Select, StateDot, Switch } from 'dsh-tauri-ui/client'
import { useStore } from 'dsh-tauri/client'
import { useEffect, useState } from 'react'
import { messageOf } from '../../shared/error'
import * as service from '../service/access'
import { store } from '../store/index'

interface AccessSectionProps {
  t: (key: RemoteKey) => string
}

const SCOPES: readonly AccessScope[] = ['public_only', 'all']

const MODES: readonly TunnelMode[] = ['quick', 'token']

const EVENT_TAIL = 6

/** 隧道进程日志尾：cloudflared 启动期会刷很多行，面板只保留最近几条。 */
const PROCESS_TAIL = 4

const WILDCARD = '0.0.0.0'

const LOOPBACK = '127.0.0.1'

export function AccessSection({ t }: AccessSectionProps): ReactNode {
  const view = useStore(store.access)
  const status = view.snapshot
  const [address, setAddress] = useState<string | null>(null)
  const [port, setPort] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [hostname, setHostname] = useState<string | null>(null)
  const [mode, setMode] = useState<TunnelMode | null>(null)

  useEffect(() => {
    // keep:effect 首次挂载时拉取面板数据（store 为空才发请求，重挂载不重复打接口）
    if (store.access.snapshot === null)
      void service.load()
  }, [])

  if (status === null) {
    return (
      <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="access-section">
        <p className="m-0 text-[12px] leading-[18px] text-tertiary">{view.status === 'error' ? view.error : t('access.loading')}</p>
      </div>
    )
  }

  const listenAddress = address ?? status.listen.address
  const listenPort = port ?? String(status.listen.port)
  const tunnelMode = mode ?? status.tunnel.mode
  const tunnelHost = hostname ?? status.tunnel.hostname ?? ''
  const busy = view.busy
  // cloudflared 的进程日志很密：状态行单独常驻，进程尾只留最近几条，关键结论不被刷掉。
  const tunnelStateLine = status.tunnel.events.filter(event => event.kind === 'state').at(-1)?.line
  const tunnelTail = status.tunnel.events.filter(event => event.kind === 'process').slice(-PROCESS_TAIL)
  const localLabel = status.linkSource === 'lan' ? t('access.entry.lan') : t('access.entry.local')
  const localMasked = status.link === undefined && status.maskLink !== undefined

  return (
    <div className="flex flex-col gap-[12px] max-w-[960px] text-primary" data-testid="access-section">
      <div className="flex flex-wrap items-center justify-between gap-[8px]" data-testid="access-header">
        <div className="flex items-center gap-[8px]">
          <StateDot state={dotStateOf(status)} size={8} />
          <span className="text-[13px] leading-[20px]">{t(stateKeyOf(status))}</span>
          {status.listening ? <span className="text-[12px] leading-[18px] text-tertiary">{`${status.listen.address}:${status.port}`}</span> : null}
        </div>
        <Button
          variant={status.enabled ? 'outline' : 'primary'}
          size="sm"
          disabled={busy}
          data-testid="access-toggle"
          onClick={() => void service.apply({ enabled: !status.enabled })}
        >
          {t(status.enabled ? 'access.disable' : 'access.enable')}
        </Button>
      </div>

      <p className="m-0 text-[12px] leading-[18px] text-tertiary" data-testid="access-intro">{t('access.intro')}</p>

      {view.error === null ? null : <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid="access-error">{view.error}</p>}
      {view.notice === null ? null : <p className="m-0 text-[12px] leading-[18px] text-tertiary" data-testid="access-notice">{view.notice}</p>}
      {status.error === undefined ? null : <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid="access-state-error">{status.error}</p>}
      {(status.warnings ?? []).map(warning => (
        <p key={warning} className="m-0 text-[12px] leading-[18px] text-tertiary" data-testid="access-warning">{warning}</p>
      ))}

      {view.generatedPassword === null
        ? null
        : (
            <section className="flex flex-col gap-[8px] rounded-[12px] border-[0.5px] border-primary bg-layer-2 px-[16px] py-[12px]" data-testid="access-generated-password">
              <span className="text-[13px] leading-[20px] font-medium">{t('access.generated.title')}</span>
              <div className="flex flex-wrap items-center gap-[8px]">
                <code className="break-all text-[14px] leading-[22px] text-primary" data-testid="access-generated-password-value">{view.generatedPassword}</code>
                <Button variant="outline" size="sm" data-testid="access-generated-password-copy" onClick={() => void copyLink(view.generatedPassword ?? '')}>
                  {t('access.generated.copy')}
                </Button>
                <Button variant="ghost" size="sm" data-testid="access-generated-password-dismiss" onClick={() => store.access.dismissGeneratedPassword()}>
                  {t('access.generated.dismiss')}
                </Button>
              </div>
              <span className="text-[12px] leading-[18px] text-tertiary">{t('access.generated.hint')}</span>
            </section>
          )}

      <Block title={t('access.entry.title')}>
        <div className="flex flex-col gap-[12px]">
          <Entry
            label={localLabel}
            testid="access-entry-local"
            value={status.link ?? status.maskLink}
            testidValue={localMasked ? 'access-mask-link' : 'access-link'}
            qr={status.qr}
            qrTestid="access-link-qr"
            copyTestid="access-link-copy"
            t={t}
            placeholder={t('access.entry.none')}
            action={status.enabled
              ? undefined
              : { label: t('access.enable'), testid: 'access-entry-local-action', run: () => void service.apply({ enabled: true }) }}
            onCopy={text => void copyLink(text)}
          />
          <Entry
            label={t('access.entry.tunnel')}
            testid="access-entry-tunnel"
            value={status.tunnel.link ?? status.tunnel.url}
            testidValue="access-tunnel-url"
            qr={status.tunnel.qr}
            qrTestid="access-tunnel-qr"
            copyTestid="access-tunnel-copy"
            t={t}
            placeholder={t('access.entry.tunnelNone')}
            action={status.tunnel.state === 'stopped' || status.tunnel.state === 'error'
              ? { label: t('access.entry.startTunnel'), testid: 'access-entry-tunnel-action', run: startTunnel }
              : undefined}
            onCopy={text => void copyLink(text)}
          />
        </div>
      </Block>

      <Block title={t('access.auth.title')}>
        <div className="flex flex-col gap-[12px]">
          <div className="flex items-center justify-between gap-[12px]">
            <span className="text-[13px] leading-[20px]">{t('access.auth.enable')}</span>
            <Switch
              checked={status.auth.enabled}
              disabled={busy}
              label={t('access.auth.enable')}
              data-testid="access-auth-toggle"
              onChange={next => void service.apply({ authEnabled: next })}
            />
          </div>
          <Field label={t('access.auth.scope')}>
            <SegmentedControl
              id="dsh-tauri-remote-access-scope"
              label={t('access.auth.scope')}
              value={status.auth.scope}
              options={SCOPES.map(value => ({ value, label: t(scopeKeyOf(value)) }))}
              onChange={(next) => {
                const scope = SCOPES.find(candidate => candidate === next)
                if (scope !== undefined)
                  void service.apply({ scope })
              }}
            />
          </Field>
          <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] items-end gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]">
            <Field className="col-span-6" label={t('access.auth.password')}>
              <Input
                className="box-border w-full"
                type="password"
                value={password}
                placeholder={status.auth.hasPassword === true ? t('access.auth.hasPassword') : t('access.auth.noPassword')}
                onChange={event => setPassword(event.target.value)}
              />
            </Field>
            <div className="col-span-6 flex gap-[8px]">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || password === ''}
                data-testid="access-password-save"
                onClick={() => {
                  const value = password
                  setPassword('')
                  void service.apply({ password: value })
                }}
              >
                {t('access.auth.passwordSave')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || status.auth.hasPassword !== true}
                data-testid="access-password-clear"
                onClick={() => {
                  setPassword('')
                  void service.apply({ password: null })
                }}
              >
                {t('access.auth.passwordClear')}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button variant="outline" size="sm" disabled={busy} data-testid="access-token-rotate" onClick={() => void service.rotateToken()}>
              {t('access.auth.tokenRotate')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy || status.auth.hasToken !== true} data-testid="access-token-revoke" onClick={() => void service.revokeToken()}>
              {t('access.auth.tokenRevoke')}
            </Button>
            <span className="text-[12px] leading-[18px] text-tertiary">{t(status.auth.hasToken === true ? 'access.auth.hasToken' : 'access.auth.noToken')}</span>
          </div>
        </div>
      </Block>

      <Block title={t('access.listen.title')}>
        <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]">
          <Field className="col-span-6" label={t('access.listen.address')}>
            <Select
              label={t('access.listen.address')}
              options={addressOptionsOf(status.addresses, t)}
              value={listenAddress}
              onChange={(next) => {
                setAddress(next)
                void service.apply({ address: next })
              }}
            />
          </Field>
          <Field className="col-span-4" label={t('access.listen.port')}>
            <Input
              className="box-border w-full"
              type="number"
              value={listenPort}
              onChange={event => setPort(event.target.value)}
              onBlur={() => {
                const next = Number(listenPort)
                setPort(null)
                if (Number.isInteger(next) && next > 0 && next <= 65535 && next !== status.listen.port)
                  void service.apply({ port: next })
              }}
            />
          </Field>
          <div className="col-span-12 flex items-center gap-[8px] text-[12px] leading-[18px] text-tertiary">
            <span data-testid="access-upstream">
              {status.localPort === undefined
                ? t('access.listen.noUpstream')
                : `${t('access.listen.desktopBackend')} 127.0.0.1:${status.localPort}`}
            </span>
          </div>
        </div>
      </Block>

      <Block title={t('access.tunnel.title')}>
        <div className="flex flex-col gap-[12px]">
          <p className="m-0 text-[12px] leading-[18px] text-tertiary">{t('access.tunnel.intro')}</p>
          <span className="text-[12px] leading-[18px] text-tertiary" data-testid="access-tunnel-auth-hint">{t('access.tunnel.authForced')}</span>
          <Field label={t('access.tunnel.mode')}>
            <SegmentedControl
              id="dsh-tauri-remote-access-tunnel-mode"
              label={t('access.tunnel.mode')}
              value={tunnelMode}
              options={MODES.map(value => ({ value, label: t(modeKeyOf(value)) }))}
              onChange={(next) => {
                const selected = MODES.find(candidate => candidate === next)
                if (selected !== undefined)
                  setMode(selected)
              }}
            />
          </Field>
          {tunnelMode !== 'token'
            ? null
            : (
                <div className="grid grid-cols-[repeat(12,minmax(0,1fr))] gap-[10px_12px] max-[760px]:grid-cols-[repeat(6,minmax(0,1fr))]">
                  <Field className="col-span-6" label={t('access.tunnel.token')}>
                    <Input className="box-border w-full" type="password" value={token} data-testid="access-tunnel-token" onChange={event => setToken(event.target.value)} />
                  </Field>
                  <Field className="col-span-6" label={t('access.tunnel.hostname')}>
                    <Input className="box-border w-full" value={tunnelHost} placeholder="dsh.example.com" data-testid="access-tunnel-hostname" onChange={event => setHostname(event.target.value)} />
                  </Field>
                </div>
              )}
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button variant="primary" size="sm" disabled={busy} data-testid="access-tunnel-start" onClick={startTunnel}>
              {t(status.tunnel.state === 'running' || status.tunnel.state === 'starting' ? 'access.tunnel.restart' : 'access.tunnel.start')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || status.tunnel.state === 'stopped'}
              data-testid="access-tunnel-stop"
              onClick={() => void service.stopTunnel()}
            >
              {t('access.tunnel.stop')}
            </Button>
            <span className="text-[12px] leading-[18px] text-tertiary" data-testid="access-tunnel-state">{t(tunnelStateKeyOf(status))}</span>
          </div>
          {status.tunnel.progress === undefined ? null : <TunnelProgressBar progress={status.tunnel.progress} t={t} />}
          {status.tunnel.port === undefined ? null : <span className="text-[12px] leading-[18px] text-tertiary">{`${t('access.tunnel.port')} 127.0.0.1:${status.tunnel.port}`}</span>}
          {status.tunnel.mode === 'token' && status.tunnel.state !== 'stopped' ? <span className="text-[12px] leading-[18px] text-tertiary">{t('access.tunnel.dashboardHint')}</span> : null}
          {status.tunnel.error === undefined ? null : <p className="m-0 text-[12px] leading-[18px] text-error" role="alert" data-testid="access-tunnel-error">{status.tunnel.error}</p>}
          {tunnelStateLine === undefined
            ? null
            : <span className="break-all text-[12px] leading-[18px] text-secondary" data-testid="access-tunnel-ready">{tunnelStateLine}</span>}
          {tunnelTail.length === 0
            ? null
            : (
                <div className="flex flex-col gap-[2px]" data-testid="access-tunnel-events">
                  {tunnelTail.map(event => (
                    <span key={event.seq} className="break-all text-[12px] leading-[18px] text-tertiary">{`${event.ts} ${event.line}`}</span>
                  ))}
                </div>
              )}
        </div>
      </Block>

      {status.events.length === 0
        ? null
        : (
            <Block title={t('access.events.title')}>
              <div className="flex flex-col gap-[2px]" data-testid="access-events">
                {status.events.slice(-EVENT_TAIL).map(event => (
                  <span key={event.seq} className="break-all text-[12px] leading-[18px] text-tertiary">{`${event.ts} ${event.line}`}</span>
                ))}
              </div>
            </Block>
          )}
    </div>
  )

  function startTunnel(): void {
    void service.startTunnel({
      mode: tunnelMode,
      ...tunnelMode === 'token' ? { token, hostname: tunnelHost } : {},
    })
    setToken('')
  }

  async function copyLink(text: string): Promise<void> {
    if (text === '')
      return
    try {
      await navigator.clipboard.writeText(text)
      store.access.setNotice(t('access.link.copied'))
    }
    catch (error) {
      store.access.setNotice(messageOf(error))
    }
  }
}

function Block({ title, children }: { title: string, children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-[12px] rounded-[12px] border-[0.5px] border-border-l2 bg-layer-1 px-[16px] py-[14px]">
      <h3 className="m-0 text-[13px] leading-[20px] font-medium">{title}</h3>
      {children}
    </section>
  )
}

interface EntryProps {
  label: string
  testid: string
  value: string | undefined
  testidValue: string
  qr: string | undefined
  qrTestid: string
  copyTestid: string
  t: (key: RemoteKey) => string
  placeholder: string
  action?: { label: string, testid: string, run: () => void }
  onCopy: (text: string) => void
}

/** 访问入口一行：来源标签 + 地址 + 复制 + 二维码；没有地址时给占位与直接操作入口。 */
function Entry({ label, testid, value, testidValue, qr, qrTestid, copyTestid, t, placeholder, action, onCopy }: EntryProps): ReactNode {
  return (
    <div className="flex flex-col gap-[10px] rounded-[10px] border-[0.5px] border-border-l2 bg-layer-2 px-[12px] py-[10px]" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-[8px]">
        <span className="rounded-[6px] bg-layer-1 px-[8px] py-[2px] text-[11px] leading-[18px] text-secondary">{label}</span>
        {value === undefined
          ? <span className="text-[12px] leading-[18px] text-tertiary" data-testid={`${testid}-placeholder`}>{placeholder}</span>
          : (
              <>
                <code className="break-all text-[12px] leading-[18px] text-secondary" data-testid={testidValue}>{value}</code>
                <Button variant="ghost" size="sm" data-testid={copyTestid} onClick={() => onCopy(value)}>{t('access.link.copy')}</Button>
              </>
            )}
        {value !== undefined || action === undefined
          ? null
          : <Button variant="outline" size="sm" data-testid={action.testid} onClick={action.run}>{action.label}</Button>}
      </div>
      {qr === undefined ? null : <img className="h-[132px] w-[132px] rounded-[8px] bg-white p-[6px]" src={qr} alt={t('access.link.qr')} data-testid={qrTestid} />}
    </div>
  )
}

/** 只有下载阶段有确定百分比：其余阶段只给阶段文字，不画一条会被误读成「已完成」的满格进度条。 */
function TunnelProgressBar({ progress, t }: { progress: TunnelProgress, t: (key: RemoteKey) => string }): ReactNode {
  const percent = progress.total === undefined || progress.total <= 0 ? undefined : Math.min(100, Math.floor((progress.received ?? 0) * 100 / progress.total))
  return (
    <div className="flex flex-col gap-[6px]" data-testid="access-tunnel-progress">
      <span className="text-[12px] leading-[18px] text-secondary" data-testid="access-tunnel-progress-line">
        {`${t(progressKeyOf(progress))}${percent === undefined ? '' : ` ${percent}%`}`}
      </span>
      {percent === undefined
        ? null
        : (
            <div className="h-[6px] w-full overflow-hidden rounded-[3px] bg-layer-3">
              <div className="h-full rounded-[3px] bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} data-testid="access-tunnel-progress-bar" />
            </div>
          )}
    </div>
  )
}

// --- internal ---
function progressKeyOf(progress: TunnelProgress): RemoteKey {
  if (progress.stage === 'download')
    return 'access.tunnel.progress.download'
  if (progress.stage === 'extract')
    return 'access.tunnel.progress.extract'
  if (progress.stage === 'verify')
    return 'access.tunnel.progress.verify'
  if (progress.stage === 'spawn')
    return 'access.tunnel.progress.spawn'
  if (progress.stage === 'domain')
    return 'access.tunnel.progress.domain'
  if (progress.stage === 'ready')
    return 'access.tunnel.progress.ready'
  return 'access.tunnel.progress.check'
}

function stateKeyOf(status: AccessStatus): RemoteKey {
  if (status.state === 'error')
    return 'access.state.error'
  return status.listening ? 'access.state.listening' : 'access.state.stopped'
}

function dotStateOf(status: AccessStatus): 'done' | 'ongoing' | 'error' | 'idle' {
  if (status.state === 'error')
    return 'error'
  if (status.listening)
    return 'done'
  return status.enabled ? 'ongoing' : 'idle'
}

function tunnelStateKeyOf(status: AccessStatus): RemoteKey {
  if (status.tunnel.state === 'running')
    return 'access.tunnel.state.running'
  if (status.tunnel.state === 'starting')
    return 'access.tunnel.state.starting'
  if (status.tunnel.state === 'error')
    return 'access.tunnel.state.error'
  return 'access.tunnel.state.stopped'
}

function scopeKeyOf(scope: AccessScope): RemoteKey {
  return scope === 'all' ? 'access.auth.scope.all' : 'access.auth.scope.public_only'
}

function modeKeyOf(mode: TunnelMode): RemoteKey {
  return mode === 'token' ? 'access.tunnel.mode.token' : 'access.tunnel.mode.quick'
}

function addressOptionsOf(addresses: readonly AccessAddress[], t: (key: RemoteKey) => string): Array<{ value: string, label: string }> {
  const options = [{ value: LOOPBACK, label: LOOPBACK }, { value: WILDCARD, label: `${WILDCARD}（${t('access.listen.allInterfaces')}）` }]
  for (const entry of addresses) {
    if (entry.address === LOOPBACK || entry.address === WILDCARD)
      continue
    options.push({ value: entry.address, label: entry.recommended ? `${entry.address}（${t('access.listen.recommended')}）` : entry.address })
  }
  return options
}
