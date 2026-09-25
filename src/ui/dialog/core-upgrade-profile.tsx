import type { PropsWithOverlays } from '@overlastic/react'
import { AlertDialog, Button, Input, Label, Link } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeProfileId } from '@/utils/profile-id'

/** 跨主/次版本升级时的选择：切到配套档案，或无视风险直接切核心 */
export type CoreUpgradeChoice
  = | { mode: 'profile', name: string }
    | { mode: 'ignore' }

export interface CoreUpgradeProfileDialogProps extends PropsWithOverlays {
  /** 当前使用中的核心版本（展示用） */
  fromVersion: string
  /** 目标核心版本（展示用） */
  toVersion: string
  /** 档案名默认值：目标版本的主/次版本号（`x.x`） */
  defaultName: string
}

/**
 * 「跨主/次版本升级」警告对话框：核心与档案配套，跨版本升级可能破坏当前档案里的插件与设置。
 *
 * - 确认：resolve `{ mode: 'profile', name }`，由调用方创建/切换档案后再切核心并重启；
 * - 「无视风险切换」：resolve `{ mode: 'ignore' }`，跳过档案切换直接切核心；
 * - 取消/关闭：reject，调用方中止本次切换。
 */
export function CoreUpgradeProfileDialog(props: CoreUpgradeProfileDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  const [name, setName] = useState(props.defaultName)
  const profileId = normalizeProfileId(name)

  function confirmProfile() {
    if (!profileId)
      return
    disclosure.confirm({ mode: 'profile', name })
  }

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>{t('core.breaking_title')}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="space-y-3">
              <p className="text-xs leading-[1.7] text-muted">
                {t('core.breaking_desc', { from: props.fromVersion, to: props.toVersion })}
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('core.breaking_profile_label')}</Label>
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 w-full rounded-md"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      confirmProfile()
                  }}
                />
              </div>
              <Link
                className="text-xs text-warning"
                onPress={() => disclosure.confirm({ mode: 'ignore' })}
              >
                {t('core.breaking_ignore')}
              </Link>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button className="rounded-md" variant="tertiary" onPress={disclosure.cancel}>
                {t('buttons.cancel')}
              </Button>
              <Button
                className="rounded-md"
                variant="primary"
                isDisabled={!profileId}
                onPress={confirmProfile}
              >
                {t('buttons.confirm')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
