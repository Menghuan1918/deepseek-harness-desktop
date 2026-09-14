import type { SshMachineRow } from '@/store/modules/remote'
import { ArrowUpRightFromSquare, PencilToSquare, PlugConnection, Plus, Power, TrashBin } from '@gravity-ui/icons'
import { Button, Description, Input, Label, Modal, Switch } from '@heroui/react'
import { useOverlay } from '@overlastic/react'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { Modal as ConfirmModal } from '@/components/modal'
import { store } from '@/store'
import { dotClassOf, dotStyleOf, sshApi } from '@/store/modules/remote'
import { toast } from '@/utils/toast'

/** ID 合法性：小写字母/数字/连字符，字母或数字开头（与 ssh-ui 同一规则）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** 从主机派生 ID：剥掉 user@ 前缀后取小写 slug；空结果兜底 'machine'。 */
function slugOf(host: string): string {
  const slug = host
    .trim()
    .toLowerCase()
    .replace(/^.*@/u, '')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return slug === '' ? 'machine' : slug
}

/** 占用避让：id 已存在时 -2/-3 递增。 */
function freeIdOf(base: string, taken: readonly string[]): string {
  if (!taken.includes(base))
    return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.includes(candidate))
      return candidate
  }
}

interface FormState {
  id: string
  idTouched: boolean
  name: string
  host: string
  port: string
  user: string
  remotePort: string
  color: string
  tintBorder: boolean
  startCommand: string
  password: string
  passphrase: string
}

function formOf(machine?: SshMachineRow, taken: readonly string[] = []): FormState {
  const host = machine?.host ?? ''
  return {
    id: machine?.id ?? freeIdOf(slugOf(host), taken),
    idTouched: false,
    name: machine?.name ?? '',
    host,
    port: machine?.port !== undefined ? String(machine.port) : '',
    user: machine?.user ?? '',
    remotePort: machine?.remotePort !== undefined ? String(machine.remotePort) : '',
    color: machine?.color ?? '',
    tintBorder: machine?.tintBorder === true,
    startCommand: machine?.startCommand ?? '',
    password: '',
    passphrase: '',
  }
}

/** 表单校验：主机必填；新增时 ID 合法且不占用。返回 locale key 或 null。 */
function formErrorOf(form: FormState, isNew: boolean, taken: readonly string[]): string | null {
  if (form.host.trim() === '')
    return 'remote.form.host_required'
  if (isNew) {
    if (!ID_PATTERN.test(form.id))
      return 'remote.form.id_invalid'
    if (taken.includes(form.id))
      return 'remote.form.id_taken'
  }
  return null
}

/**
 * 壳层原生远端机器管理面板：切换器「管理机器…」直达。
 *
 * 列表即态：色点/名称/连接目标/连接状态 + 行内动作（连接或断开、新窗口、
 * 编辑、删除——删除经确认对话框且立即生效）。表单内联展开（顶部），新增时
 * ID 从主机自动派生（手改后停止）；保存立即落盘（敏感值留空=保留已存），
 * 全部经 `/api-ssh` 数据面（sshApi），成功后远端列表随轮询刷新。
 */
export function RemoteManager({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const { t } = useTranslation()
  const { machines, activeId } = useStore(store.remote)
  const [dialogHolder, openConfirm] = useOverlay(ConfirmModal, { type: 'holder' })
  /** 'new' 或机器 id；null = 收起表单 */
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => formOf())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const isNew = editing === 'new'
  const editingRow = isNew ? undefined : machines.find(machine => machine.id === editing)
  const takenIds = machines.map(machine => machine.id)
  const formError = editing === null ? null : formErrorOf(form, isNew, takenIds)

  function openForm(target: 'new' | SshMachineRow) {
    setEditing(target === 'new' ? 'new' : target.id)
    setForm(formOf(target === 'new' ? undefined : target, takenIds))
    setError(null)
    setTestResult(null)
  }

  function patchForm(patch: Partial<FormState>) {
    setForm((previous) => {
      const next = { ...previous, ...patch }
      // 主机变更且未手改 ID：跟随派生
      if (patch.host !== undefined && !next.idTouched && isNew)
        next.id = freeIdOf(slugOf(patch.host), takenIds)
      return next
    })
    setTestResult(null)
  }

  async function handleSave() {
    if (editing === null || formError !== null)
      return
    setBusy(true)
    setError(null)
    try {
      await sshApi().save({
        id: form.id,
        name: form.name.trim() === '' ? form.host.trim() : form.name.trim(),
        host: form.host.trim(),
        ...form.port.trim() !== '' && Number(form.port) > 0 ? { port: Number(form.port) } : {},
        ...form.user.trim() !== '' ? { user: form.user.trim() } : {},
        ...form.remotePort.trim() !== '' && Number(form.remotePort) > 0 ? { remotePort: Number(form.remotePort) } : {},
        ...form.color.trim() !== '' ? { color: form.color.trim() } : {},
        ...form.tintBorder ? { tintBorder: true } : {},
        ...form.startCommand.trim() !== '' ? { startCommand: form.startCommand.trim() } : {},
      }, {
        ...form.password !== '' ? { password: form.password } : {},
        ...form.passphrase !== '' ? { passphrase: form.passphrase } : {},
      })
      setEditing(null)
      await store.remote.refresh()
    }
    catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    if (editing === null)
      return
    setBusy(true)
    setTestResult(null)
    try {
      // 探测针对已存机器（新增需先保存）
      const result = await sshApi().test(form.id)
      setTestResult(result.ok ? (result.banner ?? 'ok') : 'failed')
    }
    catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err))
    }
    finally {
      setBusy(false)
    }
  }

  async function handleRemove(machine: SshMachineRow) {
    try {
      await openConfirm({
        status: 'danger',
        title: t('remote.manager.remove_title'),
        description: <p>{t('remote.manager.remove_desc', { name: machine.name })}</p>,
      })
    }
    catch {
      return
    }
    try {
      await sshApi().remove(machine.id)
      if (editing === machine.id)
        setEditing(null)
      await store.remote.refresh()
    }
    catch (err) {
      toast(err instanceof Error ? err.message : String(err), {})
    }
  }

  function handleOpenWindow(machine: SshMachineRow) {
    if (machine.tunnelBaseUrl === undefined)
      return
    invoke('remote_open_window', { machineId: machine.id, url: machine.tunnelBaseUrl })
      .catch((err: unknown) => {
        toast(t('remote.open_window_failed'), {})
        console.warn('[remote] open window failed:', err)
      })
  }

  const fieldClass = 'h-8 rounded-md text-xs'

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open)
          onClose()
      }}
    >
      {dialogHolder}
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header className="mb-3">
              <Modal.Heading>{t('remote.manager.title')}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3">
              <div className="flex items-center justify-between">
                <Description>{t('remote.manager.subtitle')}</Description>
                <Button
                  className="rounded-md"
                  size="sm"
                  variant="primary"
                  isDisabled={editing !== null}
                  onPress={() => openForm('new')}
                >
                  <Plus className="size-3.5" />
                  {t('remote.manager.add')}
                </Button>
              </div>

              {/* 内联表单：新增/编辑 */}
              <If cond={editing !== null}>
                <div className="space-y-2.5 rounded-lg border border-line bg-panel2/50 p-3" data-testid="machine-form">
                  <Label className="text-xs font-medium text-ink">
                    {isNew ? t('remote.manager.add') : t('remote.manager.edit', { name: editingRow?.name ?? '' })}
                  </Label>
                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">
                        {t('remote.form.host')}
                        {' '}
                        *
                      </span>
                      <Input variant="secondary" className={fieldClass} value={form.host} aria-label={t('remote.form.host')} onChange={e => patchForm({ host: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.name')}</span>
                      <Input variant="secondary" className={fieldClass} value={form.name} aria-label={t('remote.form.name')} placeholder={form.host} onChange={e => patchForm({ name: e.target.value })} />
                    </label>
                    <If cond={isNew}>
                      <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted">{t('remote.form.id')}</span>
                        <Input variant="secondary" className={cn(fieldClass, 'font-mono')} value={form.id} aria-label={t('remote.form.id')} onChange={e => patchForm({ id: e.target.value, idTouched: true })} />
                      </label>
                    </If>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.port')}</span>
                      <Input variant="secondary" type="number" className={cn(fieldClass, '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none')} value={form.port} aria-label={t('remote.form.port')} placeholder="22" onChange={e => patchForm({ port: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.user')}</span>
                      <Input variant="secondary" className={fieldClass} value={form.user} aria-label={t('remote.form.user')} onChange={e => patchForm({ user: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.remote_port')}</span>
                      <Input variant="secondary" type="number" className={cn(fieldClass, '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none')} value={form.remotePort} aria-label={t('remote.form.remote_port')} placeholder="3081" onChange={e => patchForm({ remotePort: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.password')}</span>
                      <Input variant="secondary" type="password" className={fieldClass} value={form.password} aria-label={t('remote.form.password')} placeholder={!isNew && editingRow?.hasPassword === true ? t('remote.form.keep_blank') : ''} onChange={e => patchForm({ password: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.passphrase')}</span>
                      <Input variant="secondary" type="password" className={fieldClass} value={form.passphrase} aria-label={t('remote.form.passphrase')} placeholder={!isNew && editingRow?.hasPassphrase === true ? t('remote.form.keep_blank') : ''} onChange={e => patchForm({ passphrase: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.color')}</span>
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-4 shrink-0 rounded-full border border-line" style={form.color !== '' ? { backgroundColor: form.color } : undefined} />
                        <Input variant="secondary" className={cn(fieldClass, 'font-mono')} value={form.color} aria-label={t('remote.form.color')} placeholder="#7c5cff" onChange={e => patchForm({ color: e.target.value })} />
                      </span>
                    </label>
                    <span className="flex items-end pb-1">
                      <Switch isSelected={form.tintBorder} aria-label={t('remote.form.tint_border')} onChange={selected => patchForm({ tintBorder: selected })}>
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                        </Switch.Content>
                      </Switch>
                      <span className="ml-2 text-xs text-muted">{t('remote.form.tint_border')}</span>
                    </span>
                    <label className="col-span-2 flex flex-col gap-1">
                      <span className="text-xs text-muted">{t('remote.form.start_command')}</span>
                      <Input variant="secondary" className={cn(fieldClass, 'font-mono')} value={form.startCommand} aria-label={t('remote.form.start_command')} placeholder={t('remote.form.start_command_hint')} onChange={e => patchForm({ startCommand: e.target.value })} />
                    </label>
                  </div>
                  <If cond={formError !== null}>
                    <Description className="text-danger">{t(formError ?? '')}</Description>
                  </If>
                  <If cond={error !== null}>
                    <Description className="text-danger break-all">{error}</Description>
                  </If>
                  <If cond={testResult !== null}>
                    <Description className="break-all">{testResult}</Description>
                  </If>
                  <div className="flex items-center justify-end gap-2">
                    <If cond={!isNew}>
                      <Button className="rounded-md" size="sm" variant="ghost" isDisabled={busy} onPress={() => { void handleTest() }}>
                        {t('remote.manager.test')}
                      </Button>
                    </If>
                    <Button className="rounded-md" size="sm" variant="tertiary" isDisabled={busy} onPress={() => setEditing(null)}>
                      {t('buttons.cancel')}
                    </Button>
                    <Button className="rounded-md" size="sm" variant="primary" isDisabled={busy || formError !== null} onPress={() => { void handleSave() }}>
                      {t('buttons.save')}
                    </Button>
                  </div>
                </div>
              </If>

              {/* 机器列表 */}
              <If cond={machines.length === 0 && editing === null}>
                <Description className="py-4 text-center">{t('remote.manager.empty')}</Description>
              </If>
              <div className="flex flex-col gap-1.5">
                {machines.map(machine => (
                  <div key={machine.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2" data-testid={`manager-${machine.id}`}>
                    <span
                      aria-hidden="true"
                      className={cn('size-2 shrink-0 rounded-full', machine.id === activeId ? 'bg-success' : dotClassOf(machine))}
                      style={machine.id === activeId ? undefined : dotStyleOf(machine)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Label className="truncate text-sm">{machine.name}</Label>
                      <Description className="truncate text-[11px] leading-4">
                        {machine.host !== undefined ? `${machine.user !== undefined ? `${machine.user}@` : ''}${machine.host}${machine.port !== undefined ? `:${machine.port}` : ''}` : machine.id}
                      </Description>
                    </span>
                    <Description className="shrink-0">{t(`remote.state.${machine.state}`)}</Description>
                    <span className="flex shrink-0 items-center gap-1">
                      <If
                        cond={machine.state === 'connected'}
                        else={(
                          <Button
                            isIconOnly
                            aria-label={t('remote.manager.connect')}
                            className="size-7 rounded-md"
                            size="sm"
                            variant="ghost"
                            onPress={() => {
                              store.remote.switchTo(machine.id)
                              onClose()
                            }}
                          >
                            <PlugConnection className="size-3.5" />
                          </Button>
                        )}
                      >
                        <Button isIconOnly aria-label={t('remote.manager.disconnect')} className="size-7 rounded-md" size="sm" variant="ghost" onPress={() => { void store.remote.disconnect(machine.id) }}>
                          <Power className="size-3.5" />
                        </Button>
                      </If>
                      <If cond={machine.state === 'connected' && machine.tunnelBaseUrl !== undefined}>
                        <Button isIconOnly aria-label={t('remote.open_new_window')} className="size-7 rounded-md" size="sm" variant="ghost" onPress={() => handleOpenWindow(machine)}>
                          <ArrowUpRightFromSquare className="size-3.5" />
                        </Button>
                      </If>
                      <Button isIconOnly aria-label={t('remote.manager.edit_action')} className="size-7 rounded-md" size="sm" variant="ghost" onPress={() => openForm(machine)}>
                        <PencilToSquare className="size-3.5" />
                      </Button>
                      <Button isIconOnly aria-label={t('remote.manager.remove_action')} className="size-7 rounded-md text-danger" size="sm" variant="ghost" onPress={() => { void handleRemove(machine) }}>
                        <TrashBin className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
