import type { ClientContext } from 'dsh-tauri/client'
import type { SshKey } from '../locales/index'
import type { MachinesStore } from '../store/index'
import { definePanel, defineRegister } from 'dsh-tauri/client'
import { SyncPanel } from '../components/sync-panel'

export const SYNC_PANEL_ID = 'dsh-tauri-ssh-sync'
export const SYNC_PANEL_ORDER = 45

/**
 * dsh 主侧边栏的「同步到远端」面板：definePanel 注册 sidebar.panellist 图标与
 * main 槽内容，一处点击直达插件/Skill 同步（原先埋在设置页机器列表尾部）。
 */
export function syncPanelFeature(store: MachinesStore, t: (key: SshKey) => string) {
  return defineRegister<ClientContext>((controller, ctx) => {
    if (typeof window === 'undefined' || window.parent === window)
      return
    controller.add(
      definePanel(ctx, {
        id: SYNC_PANEL_ID,
        order: SYNC_PANEL_ORDER,
        label: () => t('sync.panelLabel'),
        icon: ({ size, active }) => (
          <svg
            aria-hidden="true"
            fill="none"
            height={size}
            stroke={active ? 'currentColor' : 'currentColor'}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            viewBox="0 0 16 16"
            width={size}
          >
            <path d="M8 13V3" />
            <path d="m3.5 7.5 4.5-4.5 4.5 4.5" />
            <path d="M2.5 13.5h11" />
          </svg>
        ),
        render: () => <SyncPanel embedded store={store} t={t} />,
      }).dispose,
    )
  })
}
