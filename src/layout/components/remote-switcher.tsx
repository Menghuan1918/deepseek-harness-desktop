import { Globe } from '@gravity-ui/icons'
import { Button, Description, Dropdown, Label } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { cn } from 'tailwind-variants'
import { useStore } from 'valtio-define'
import { useRemoteMachines } from '@/hooks/use-remote-machines'
import { store } from '@/store'
import { dotClassOf, dotStyleOf } from '@/store/modules/remote'
import { toast } from '@/utils/toast'

/**
 * 导航栏远端机器切换器：本地实例 ↔ 各远端机器。
 *
 * 数据面全部来自本地实例 `/api-ssh`（`useRemoteMachines` 启动秒级轮询 +
 * 聚焦刷新）；点击已连接机器直接切换视图，点击未连接机器发起连接、就绪后
 * 自动切换；点击「本地」回到本地实例（不断开远端）。机器的增删改与断开
 * 入口在内嵌 web 设置页的 SSH 面板（本组件只提供引导）。
 *
 * 色点语义（S3 词汇表）：机器标识色优先 → 已连接绿 → 重连/进行中琥珀 →
 * 放弃红 → 其余中性灰；未连接行整体降不透明度。本地实例不可达时进入降级
 * 态：远端项禁用 + 顶部提示，恢复后自动复原（轮询静默重试，不弹错误）。
 */
export function RemoteSwitcher() {
  const { t } = useTranslation()
  useRemoteMachines()
  const { machines, activeId, available, pendingId } = useStore(store.remote)

  const activeMachine = machines.find(machine => machine.id === activeId)
  const activeColor = activeMachine?.color

  function handleManage() {
    // 机器管理唯一入口 = 内嵌 web 设置页的 SSH 面板（web 应用无 URL 路由，
    // 壳层无法深链，给出路径引导）
    toast(t('remote.manage_hint'), {})
  }

  return (
    <Dropdown>
      <Button
        className="rounded-lg h-6 text-xs px-1.5 ml-1 gap-1.5"
        size="sm"
        variant="ghost"
        aria-label={t('remote.switcher')}
      >
        <Globe className={cn('size-3.5', !available && 'text-warning')} />
        <span className="max-w-28 truncate">{activeMachine ? activeMachine.name : t('remote.local')}</span>
        <If cond={activeColor !== undefined}>
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full"
            style={activeColor !== undefined ? { backgroundColor: activeColor } : undefined}
          />
        </If>
      </Button>
      <Dropdown.Popover className="rounded-md w-64!">
        <Dropdown.Menu>
          <If cond={!available}>
            <Dropdown.Item className="rounded-md" id="remote-degraded" isDisabled textValue={t('remote.degraded')}>
              <Description className="text-warning">{t('remote.degraded')}</Description>
            </Dropdown.Item>
          </If>
          <Dropdown.Item
            className="rounded-md"
            id="remote-local"
            textValue={t('remote.local')}
            onAction={() => { store.remote.backToLocal() }}
          >
            <span className="flex w-full items-center gap-2">
              <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-full', activeMachine === undefined ? 'bg-success' : 'bg-line-strong')}
              />
              <Label>{t('remote.local')}</Label>
            </span>
          </Dropdown.Item>
          <If cond={machines.length === 0}>
            <Dropdown.Item className="rounded-md" id="remote-empty" isDisabled textValue={t('remote.empty')}>
              <Description>{t('remote.empty')}</Description>
            </Dropdown.Item>
          </If>
          {machines.map(machine => (
            <Dropdown.Item
              key={machine.id}
              className="rounded-md"
              id={`remote-${machine.id}`}
              textValue={machine.name}
              isDisabled={!available || pendingId !== null}
              onAction={() => { store.remote.switchTo(machine.id) }}
            >
              <span
                title={machine.lastError}
                className={cn(
                  'flex w-full items-center gap-2',
                  machine.state === 'connected' ? '' : 'opacity-60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', dotClassOf(machine))}
                  style={dotStyleOf(machine)}
                />
                <Label className="min-w-0 truncate">{machine.name}</Label>
                {/* 待切换的机器在首轮轮询回报前尚无 connecting 状态：由
                     pendingId 立即给出「连接中」反馈，避免点了没反应 */}
                <Description className={cn('ml-auto shrink-0', pendingId === machine.id && 'text-warning')}>
                  {pendingId === machine.id ? t('remote.state.connecting') : t(`remote.state.${machine.state}`)}
                </Description>
              </span>
            </Dropdown.Item>
          ))}
          <Dropdown.Item
            className="rounded-md"
            id="remote-manage"
            textValue={t('remote.manage')}
            onAction={handleManage}
          >
            <Label>{t('remote.manage')}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
