import { z } from 'zod'
import release from './agent-state-rules-release.json'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import {
  AGENT_STATE_RULES_ENGINE_VERSION,
  type AgentStateRulesFile
} from './agent-state-rules-schema'

/**
 * The published bundle, `agent-state-rules.json`: the live-updatable agents' rule files, built by
 * config/scripts/agent-state-rules-bundle.mjs from the per-agent files and
 * agent-state-rules-release.json. `bundledOnly` tells apps to fall back to the rules they shipped.
 */

// Why a cap: the file comes off the network and is parsed on the main thread.
export const AGENT_STATE_RULES_BUNDLE_MAX_BYTES = 256 * 1024

const MAX_BUNDLE_FILES = 64

// Dotted numbers compared numerically, so `2026.10.01.1` sorts after `2026.9.30.4`.
const VersionSchema = z
  .string()
  .regex(/^\d{1,9}(?:\.\d{1,9}){0,7}$/, 'must be dotted numbers, like 2026.10.01.1')

export function compareAgentStateRulesVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) {
      return Math.sign(difference)
    }
  }
  return 0
}

const ReleaseSchema = z
  .object({ version: VersionSchema, liveUpdatable: z.array(z.string()).min(1) })
  .strict()

const RELEASE = ReleaseSchema.parse(release)

/** The version of the rules this build ships; a download must be newer to replace them. */
export const BUNDLED_AGENT_STATE_RULES_VERSION = RELEASE.version

/** The rule files a rules release may carry: those the publish gate can replay transcripts for. */
export const LIVE_UPDATABLE_AGENT_STATE_RULE_IDS: ReadonlySet<string> = new Set(
  RELEASE.liveUpdatable
)

const BundleEnvelopeSchema = z
  .object({
    version: VersionSchema,
    engineVersion: z.number().int(),
    bundledOnly: z.boolean().optional(),
    files: z.array(z.unknown()).max(MAX_BUNDLE_FILES)
  })
  .strict()

export type AgentStateRulesBundle = {
  version: string
  bundledOnly: boolean
  files: readonly AgentStateRulesFile[]
}

export type AgentStateRulesBundleParse =
  | { ok: true; bundle: AgentStateRulesBundle }
  | { ok: false; error: string }

function reject(error: string): AgentStateRulesBundleParse {
  return { ok: false, error }
}

/**
 * Validates a bundle whole: a file that fails any check is rejected, never partly applied.
 * `any-agent` is for the local override, which the user chose, so it may carry any agent.
 */
export function parseAgentStateRulesBundle(
  text: string,
  scope: 'live-updatable' | 'any-agent'
): AgentStateRulesBundleParse {
  if (Buffer.byteLength(text, 'utf8') > AGENT_STATE_RULES_BUNDLE_MAX_BYTES) {
    return reject(`larger than ${AGENT_STATE_RULES_BUNDLE_MAX_BYTES} bytes`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return reject('not JSON')
  }
  const envelope = BundleEnvelopeSchema.safeParse(json)
  if (!envelope.success) {
    return reject(envelope.error.message)
  }
  const { version, engineVersion, bundledOnly, files } = envelope.data
  // Why before the files: a newer engine's files fail this schema for a reason that is not theirs.
  if (engineVersion !== AGENT_STATE_RULES_ENGINE_VERSION) {
    return reject(
      `built for rules engine ${engineVersion}; this build runs engine ${AGENT_STATE_RULES_ENGINE_VERSION}`
    )
  }
  let parsed: AgentStateRulesFile[]
  try {
    parsed = parseAgentStateRuleFiles(files)
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error))
  }
  const outside = parsed.find((file) => !LIVE_UPDATABLE_AGENT_STATE_RULE_IDS.has(file.id))
  if (scope === 'live-updatable' && outside) {
    return reject(`carries ${outside.id}, which has no transcript suite to gate it`)
  }
  return { ok: true, bundle: { version, bundledOnly: bundledOnly ?? false, files: parsed } }
}
