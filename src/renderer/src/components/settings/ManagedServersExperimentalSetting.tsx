import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { getExperimentalSearchEntry } from './experimental-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'

type ManagedServersExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ManagedServersExperimentalSetting({
  settings,
  updateSettings
}: ManagedServersExperimentalSettingProps): React.JSX.Element {
  const entry = getExperimentalSearchEntry().managedServers
  const enabled = settings.experimentalManagedServers === true

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="max-w-none space-y-4 py-2"
      id="managed-servers"
    >
      <div className="flex max-w-3xl items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.managedServersExperimentalSetting.description',
              'Shows Managed servers under Remote servers, and Move to managed server on SSH hosts. macOS and Linux hosts only.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.managedServersExperimentalSetting.toggleLabel',
            'Toggle Managed servers'
          )}
          onChange={() => updateSettings({ experimentalManagedServers: !enabled })}
        />
      </div>
    </SearchableSetting>
  )
}
