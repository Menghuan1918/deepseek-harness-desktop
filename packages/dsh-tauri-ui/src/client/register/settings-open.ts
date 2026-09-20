import type { ClientContext } from 'dsh-tauri/client'
import { defineRegister, listenParent } from 'dsh-tauri/client'
import { settings } from '../store/modules/settings'

export const SETTINGS_OPEN_MESSAGE = 'dsh://settings:open'

/**
 * 壳层 deep-link：宿主窗口 postMessage `dsh://settings:open`（payload
 * `{ section }`，可省略）→ 打开设置浮层并定位到对应分区。桌面壳的
 * 「管理机器」等入口经此直达插件的设置分区，替代壳内重复管理面板。
 */
export const registerSettingsOpen = defineRegister<ClientContext>((controller) => {
  controller.add(listenParent((message) => {
    const section = (message.payload as { section?: unknown } | undefined)?.section
    settings.openAt(typeof section === 'string' && section !== '' ? section : undefined)
  }, SETTINGS_OPEN_MESSAGE))
})
