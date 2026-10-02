import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from '../../../../shared/constants'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'

const PROJECT_GROUP_HEADER_KEY_PREFIX = 'repo:'
const PROVIDER_PROJECT_HEADER_KEY_PREFIX = 'project:'

export function resolveRepoHeaderColor(badgeColor: string | null | undefined): string {
  const normalizedBadgeColor = normalizeRepoBadgeColor(badgeColor)
  if (!normalizedBadgeColor) {
    return DEFAULT_REPO_BADGE_COLOR
  }

  // Why: persisted repo colors are rendered as inline CSS here, so only
  // normalized hex values from the palette or custom picker reach the sidebar.
  return REPO_COLORS.find((repoColor) => repoColor === normalizedBadgeColor) ?? normalizedBadgeColor
}

export function resolveProjectGroupHeaderColor(args: {
  groupBy: string
  headerKey: string
  badgeColor: string | null | undefined
}): string | undefined {
  // Provider project IDs can contain slashes, so preserve direct project keys.
  // For nested grouping, locate the explicit repo/project segment after the
  // primary lane instead of treating the first slash as a hierarchy boundary.
  const directProjectHeader =
    args.headerKey.startsWith(PROJECT_GROUP_HEADER_KEY_PREFIX) ||
    args.headerKey.startsWith(PROVIDER_PROJECT_HEADER_KEY_PREFIX)
  const nestedRepoIndex = args.headerKey.indexOf(`/${PROJECT_GROUP_HEADER_KEY_PREFIX}`)
  const nestedProjectIndex = args.headerKey.indexOf(`/${PROVIDER_PROJECT_HEADER_KEY_PREFIX}`)
  const nestedHeaderIndex = [nestedRepoIndex, nestedProjectIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0]
  const projectHeader = directProjectHeader || nestedHeaderIndex !== undefined
  if (args.groupBy !== 'repo' || !projectHeader) {
    return undefined
  }
  return resolveRepoHeaderColor(args.badgeColor)
}
