import type { ReactElement } from 'react'
import type { IconComponent } from '../components/icon'
import { get } from 'dsh-tauri/client'
import { Icon } from '../components/icon'
import { Database, Gear, Server, Person, Puzzle } from '../components/icons'
import { useMountStyle } from '../hooks/use-mount-style'
import settingsNavIconStyle from './nav-icon.cssr'

const SETTINGS_NAV_ICON_STYLE_ID = 'dsh-tauri-ui-settings-nav-icon-styles'

const NAV_ICONS: Record<string, IconComponent> = {
  'models': Database,
  'agent-presets': Person,
  'plugins': Puzzle,
  // 远程（dsh-tauri-ssh）：网络图标，与壳层切换器的 Globe 同一语义
  'dsh-tauri-ssh': Server,
}

export function SettingsNavIcon({ id }: { id: string }): ReactElement {
  useMountStyle(settingsNavIconStyle, SETTINGS_NAV_ICON_STYLE_ID)
  console.log('id', id)
  const NavIcon = get(NAV_ICONS, id, Gear)
  return <Icon as={NavIcon} size={16} className="dshp-settings-nav-icon" />
}
