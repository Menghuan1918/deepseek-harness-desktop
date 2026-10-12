import { AntennaSignal, Copy, Gear, TriangleExclamation } from '@gravity-ui/icons'
import { Button, Description, Modal, ProgressBar, Spinner, Tabs } from '@heroui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { deleteAccessTunnel, getAccess, postAccess, postAccessTunnel } from '@/apis/remote'
import { writeClipboardText } from '@/utils/clipboard'

interface AccessPairing {
  code: string
  expiresAt: number
  link: string
  qr: string
  tunnelLink?: string
  tunnelQr?: string
}

interface AccessTunnel {
  enabled?: boolean
  mode?: 'quick' | 'token'
  hostname?: string | null
  state?: 'stopped' | 'starting' | 'running' | 'error'
  url?: string
  port?: number
  link?: string
  qr?: string
  progress?: { stage?: string, url?: string, received?: number, total?: number }
  error?: string
}

interface AccessStatus {
  version?: number
  enabled?: boolean
  state?: 'stopped' | 'listening' | 'error'
  listening?: boolean
  listen?: { address?: string, port?: number }
  port?: number
  link?: string
  maskLink?: string
  qr?: string
  linkSource?: 'loopback' | 'lan'
  error?: string
  warnings?: string[]
  pairing?: AccessPairing
  tunnel?: AccessTunnel
}

const POLL_INTERVAL = 5000

const LOOPBACK_LINK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\[::\])(?::|\/|$)/i

function isShareableLink(link: string | undefined): link is string {
  return link !== undefined && link !== '' && !LOOPBACK_LINK.test(link)
}

function megabytesOf(bytes: number | undefined): string {
  return bytes === undefined ? '0' : (bytes / 1048576).toFixed(1)
}

function clockOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function RemoteShare({ onManage }: { onManage?: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<AccessStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const requestSeqRef = useRef(0)
  const refreshedExpiryRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current
    try {
      const raw = await getAccess() as unknown as AccessStatus
      if (seq !== requestSeqRef.current)
        return
      setStatus(raw)
      setError(raw.error ?? null)
    }
    catch (err) {
      if (seq !== requestSeqRef.current)
        return
      setError(String(err))
    }
  }, [])

  const run = useCallback(async (action: () => Promise<unknown>) => {
    const seq = ++requestSeqRef.current
    setBusy(true)
    setError(null)
    try {
      const raw = await action() as AccessStatus
      if (seq !== requestSeqRef.current)
        return
      setStatus(raw)
      setError(raw?.error ?? null)
    }
    catch (err) {
      if (seq !== requestSeqRef.current)
        return
      setError(String(err))
    }
    finally {
      if (seq === requestSeqRef.current)
        setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open)
      return
    void load()
    const timer = setInterval(() => {
      void load()
    }, POLL_INTERVAL)
    return () => {
      clearInterval(timer)
      requestSeqRef.current += 1
    }
  }, [open, load])

  useEffect(() => {
    if (!open)
      return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const pairing = status?.pairing
  useEffect(() => {
    if (!open || pairing === undefined || pairing.expiresAt > now)
      return
    if (refreshedExpiryRef.current === pairing.expiresAt)
      return
    refreshedExpiryRef.current = pairing.expiresAt
    void load()
  }, [open, pairing, now, load])

  function copyLink(link: string) {
    void writeClipboardText(link, t('remote.share.copied')).catch(() => {})
  }

  const listening = status?.state === 'listening' || status?.listening === true
  const shareLink = isShareableLink(pairing?.link) ? pairing.link : null
  const tunnel = status?.tunnel
  const tunnelState = tunnel?.state ?? 'stopped'
  const tunnelLink = isShareableLink(pairing?.tunnelLink) ? pairing.tunnelLink : null
  const stage = tunnel?.progress?.stage
  const received = tunnel?.progress?.received
  const total = tunnel?.progress?.total
  const pairingCode = (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line/40 px-2.5 py-2">
      <span className="text-[11px] text-muted">{t('remote.share.pairing')}</span>
      {pairing === undefined
        ? <span className="text-[11px] text-muted">{t('remote.share.pairing_absent')}</span>
        : (
            <>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base tracking-[0.2em] text-ink" data-testid="remote-share-pairing">
                  {pairing.code}
                </span>
                <Description className="ml-auto shrink-0 text-[11px] text-muted">
                  {t('remote.share.pairing_expires', { time: clockOf(pairing.expiresAt - now) })}
                </Description>
              </div>
              <span className="text-[11px] leading-4 text-muted">{t('remote.share.pairing_hint')}</span>
            </>
          )}
    </div>
  )

  return (
    <>
      <Button
        className="h-7 text-[12.5px] px-1.5 ml-1 gap-1.5"
        size="sm"
        variant="ghost"
        aria-label={t('remote.share')}
        onPress={() => setOpen(true)}
      >
        <AntennaSignal />
        <span>{t('remote.share')}</span>
      </Button>

      <Modal isOpen={open} onOpenChange={setOpen}>
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog className="w-[22rem] max-w-[92vw]">
              <Modal.CloseTrigger />
              <Modal.Header className="mb-2">
                <Modal.Heading>{t('remote.share')}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="space-y-3">
                <div className="flex items-center gap-2">
                  <Description className="text-xs">{t('remote.share.subtitle')}</Description>
                  <Button
                    className="ml-auto size-7 shrink-0"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={t('remote.share.settings')}
                    isDisabled={onManage == null}
                    onPress={onManage}
                  >
                    <Gear className="size-3.5" />
                  </Button>
                </div>

                <div className="flex flex-col gap-0.5 rounded-lg border border-line/40 px-2.5 py-2">
                  <span className="text-xs text-ink">{t('remote.share.mobile')}</span>
                  <span className="text-[11px] leading-4 text-muted">{t('remote.share.mobile_pending')}</span>
                </div>

                <If cond={error !== null}>
                  <Description className="break-all text-xs text-danger">
                    {t('remote.share.action_failed')}
                    {' · '}
                    {error}
                  </Description>
                </If>

                <Tabs defaultSelectedKey="lan" variant="primary">
                  <Tabs.ListContainer>
                    <Tabs.List aria-label={t('remote.share')}>
                      <Tabs.Tab id="lan" className="h-7 px-3 text-xs">
                        {t('remote.share.tab_lan')}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                      <Tabs.Tab id="tunnel" className="h-7 px-3 text-xs">
                        {t('remote.share.tab_tunnel')}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    </Tabs.List>
                  </Tabs.ListContainer>

                  <Tabs.Panel id="lan" className="space-y-3 pt-3">
                    <If cond={status === null}>
                      <Description className="flex items-center gap-1.5 text-xs">
                        <Spinner className="size-3" />
                        {t('remote.share.loading')}
                      </Description>
                    </If>

                    <If cond={status !== null && !listening}>
                      <Description className="text-xs">{t('remote.share.lan_off_desc')}</Description>
                      <Button
                        className="h-8 w-full text-xs"
                        variant="primary"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => void run(() => postAccess({ enabled: true }))}
                      >
                        {t('remote.share.lan_enable')}
                      </Button>
                    </If>

                    <If cond={status !== null && listening}>
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={cn('size-1.5 shrink-0 rounded-full', shareLink === null ? 'bg-warning' : 'bg-success')}
                        />
                        <Description className="text-xs">{t(`remote.share.lan_state.${status?.state ?? 'stopped'}`)}</Description>
                        <If cond={(status?.port ?? 0) > 0}>
                          <Description className="ml-auto shrink-0 text-[11px] text-muted">
                            {t('remote.share.lan_listen', { address: status?.listen?.address ?? '', port: status?.port ?? 0 })}
                          </Description>
                        </If>
                      </div>

                      {shareLink === null && (
                        <div className="flex items-start gap-2 rounded-lg border border-warning/40 px-2.5 py-2">
                          <TriangleExclamation className="mt-0.5 size-3.5 shrink-0 text-warning" />
                          <Description className="text-[11px] leading-4 text-warning">{t('remote.share.lan_local_only')}</Description>
                        </div>
                      )}

                      {shareLink !== null && (
                        <>
                          <Description className="break-all rounded-md bg-panel2 px-2 py-1.5 font-mono text-[11px]">
                            {shareLink}
                          </Description>
                          {pairing?.qr !== undefined && (
                            <div className="flex items-center justify-center rounded-lg bg-panel2 p-2">
                              <img src={pairing.qr} alt={t('remote.share.qr_alt')} className="size-36 rounded-md bg-white p-1" />
                            </div>
                          )}
                          <Description className="text-center text-[11px]">{t('remote.share.scan')}</Description>
                          <Button
                            className="h-8 w-full gap-1.5 text-xs"
                            variant="secondary"
                            size="sm"
                            onPress={() => copyLink(shareLink)}
                          >
                            <Copy className="size-3.5" />
                            {t('remote.share.copy')}
                          </Button>
                        </>
                      )}

                      {pairingCode}
                    </If>
                  </Tabs.Panel>

                  <Tabs.Panel id="tunnel" className="space-y-3 pt-3">
                    <If cond={status === null}>
                      <Description className="flex items-center gap-1.5 text-xs">
                        <Spinner className="size-3" />
                        {t('remote.share.loading')}
                      </Description>
                    </If>

                    <If cond={status !== null && tunnelState === 'stopped'}>
                      <Description className="text-xs">{t('remote.share.tunnel_off_desc')}</Description>
                      <Button
                        className="h-8 w-full text-xs"
                        variant="primary"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => void run(() => postAccessTunnel({ mode: 'quick' }))}
                      >
                        {t('remote.share.tunnel_enable')}
                      </Button>
                    </If>

                    <If cond={status !== null && tunnelState === 'starting'}>
                      <Description className="flex items-center gap-1.5 text-xs">
                        <Spinner className="size-3" />
                        {t('remote.share.tunnel_starting')}
                      </Description>
                      {stage !== undefined && (
                        <Description className="text-[11px] text-muted">{t(`remote.share.stage.${stage}`)}</Description>
                      )}
                      {total !== undefined && (
                        <>
                          <ProgressBar
                            value={Math.min(100, ((received ?? 0) / (total || 1)) * 100)}
                            aria-label={t('remote.share.tunnel_starting')}
                            className="w-full"
                          >
                            <ProgressBar.Track>
                              <ProgressBar.Fill className="bg-info" />
                            </ProgressBar.Track>
                          </ProgressBar>
                          <Description className="text-[11px] text-muted">
                            {t('remote.share.download_progress', { received: megabytesOf(received), total: megabytesOf(total) })}
                          </Description>
                        </>
                      )}
                      <Button
                        className="h-8 w-full text-xs"
                        variant="tertiary"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => void run(() => deleteAccessTunnel())}
                      >
                        {t('remote.share.tunnel_stop')}
                      </Button>
                    </If>

                    <If cond={status !== null && tunnelState === 'error'}>
                      <Description className="break-all text-xs text-danger">
                        {t('remote.share.tunnel_failed')}
                        {tunnel?.error === undefined ? '' : ` · ${tunnel.error}`}
                      </Description>
                      <Button
                        className="h-8 w-full text-xs"
                        variant="primary"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => void run(() => postAccessTunnel({ mode: tunnel?.mode ?? 'quick' }))}
                      >
                        {t('remote.connect.retry')}
                      </Button>
                    </If>

                    <If cond={status !== null && tunnelState === 'running'}>
                      <Description className="flex items-center gap-1.5 text-xs">
                        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
                        {t('remote.share.tunnel_ready')}
                      </Description>

                      {tunnelLink !== null && (
                        <>
                          <Description className="break-all rounded-md bg-panel2 px-2 py-1.5 font-mono text-[11px]">
                            {tunnelLink}
                          </Description>
                          <Button
                            className="h-8 w-full gap-1.5 text-xs"
                            variant="secondary"
                            size="sm"
                            onPress={() => copyLink(tunnelLink)}
                          >
                            <Copy className="size-3.5" />
                            {t('remote.share.copy')}
                          </Button>
                        </>
                      )}

                      {pairing?.tunnelQr !== undefined && (
                        <div className="flex items-center justify-center rounded-lg bg-panel2 p-2">
                          <img src={pairing.tunnelQr} alt={t('remote.share.qr_alt')} className="size-36 rounded-md bg-white p-1" />
                        </div>
                      )}

                      {pairingCode}

                      <Button
                        className="h-8 w-full text-xs"
                        variant="tertiary"
                        size="sm"
                        isDisabled={busy}
                        onPress={() => void run(() => deleteAccessTunnel())}
                      >
                        {t('remote.share.tunnel_stop')}
                      </Button>
                    </If>
                  </Tabs.Panel>
                </Tabs>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}
