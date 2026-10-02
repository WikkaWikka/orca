import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getManagedServersSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('auto.components.settings.managedServers.search.title', 'Managed servers'),
  description: translate(
    'auto.components.settings.managedServers.search.description',
    'Deploy and run an Orca server on your own SSH hosts, and move an SSH host’s projects onto one.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'auto.components.settings.experimental.search.0d24759f14',
      'experimental'
    ),
    ...translateSearchKeyword('auto.components.settings.managedServers.search.keywordSsh', 'ssh'),
    ...translateSearchKeyword(
      'auto.components.settings.managedServers.search.keywordServer',
      'server'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.managedServers.search.keywordMigrate',
      'migrate'
    )
  ],
  targetSectionId: 'managed-servers'
}))
