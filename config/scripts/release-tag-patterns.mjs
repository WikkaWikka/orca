// The tag families published as GitHub releases of this repo. Every release-triggered workflow and
// every script that lists releases classifies tags through this file, so a new family (like the
// agent state rules) is excluded or admitted in one place; release-tag-pattern-census.test.mjs
// enforces that.

const NUMBER = '(?:0|[1-9][0-9]*)'
const VERSION = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`

/** The stable desktop tag as a bash `[[ =~ ]]` pattern, for workflows that gate inline. */
export const DESKTOP_STABLE_TAG_SHELL_PATTERN =
  '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'

export const DESKTOP_STABLE_TAG = new RegExp(DESKTOP_STABLE_TAG_SHELL_PATTERN)
export const DESKTOP_RC_TAG = new RegExp(`^v${VERSION}-rc\\.${NUMBER}(?:\\.[0-9A-Za-z]+)?$`)
export const MOBILE_TAG = new RegExp(`^mobile(?:-android)?-v${VERSION}$`)

/** The agent state rules bundle, one release per rules engine and channel, updated in place. */
export const AGENT_STATE_RULES_TAG_PREFIX = 'agent-state-rules-'
export const AGENT_STATE_RULES_TAG = new RegExp(
  `^${AGENT_STATE_RULES_TAG_PREFIX}engine-([1-9][0-9]*)-(next|stable)$`
)
export const AGENT_STATE_RULES_ASSET = 'agent-state-rules.json'

export function isAgentStateRulesTag(tag) {
  return AGENT_STATE_RULES_TAG.test(tag)
}

export function agentStateRulesTag(engineVersion, channel) {
  const tag = `${AGENT_STATE_RULES_TAG_PREFIX}engine-${engineVersion}-${channel}`
  if (!isAgentStateRulesTag(tag)) {
    throw new Error(`not an agent state rules tag: ${tag}`)
  }
  return tag
}

/** Desktop app releases: the only ones the updater, the docs site and the casks may act on. */
export function isDesktopReleaseTag(tag) {
  return DESKTOP_STABLE_TAG.test(tag) || DESKTOP_RC_TAG.test(tag)
}
