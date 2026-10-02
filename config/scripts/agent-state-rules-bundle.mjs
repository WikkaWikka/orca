// Builds and checks the published agent state rules bundle (agent-state-rules.json) for the PR
// gate and the publish workflow. The app's loader validates the same file with zod
// (src/main/runtime/agent-state-rules/agent-state-rules-bundle.ts); this script only assembles it
// and enforces the publishing rules a single file cannot express.
//
//   node config/scripts/agent-state-rules-bundle.mjs build <out> [--bundled-only]
//   node config/scripts/agent-state-rules-bundle.mjs gate-files
//   node config/scripts/agent-state-rules-bundle.mjs publish <tag> <file> <target-commit>
//   node config/scripts/agent-state-rules-bundle.mjs promote <target-commit>

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AGENT_STATE_RULES_ASSET,
  AGENT_STATE_RULES_TAG,
  DESKTOP_STABLE_TAG,
  agentStateRulesTag
} from './release-tag-patterns.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
export const AGENT_STATE_RULES_DIR = join(REPO_ROOT, 'src/main/runtime/agent-state-rules')
const VERSION_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,7}$/

export function isAgentStateRulesVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version)
}

// Mirrors compareAgentStateRulesVersions in the app; the bundle test pins that they agree.
export function compareAgentStateRulesVersions(left, right) {
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The live-updatable agents' files, in release order, under the release's version. */
export function buildAgentStateRulesBundle({
  rulesDir = AGENT_STATE_RULES_DIR,
  bundledOnly = false
} = {}) {
  const release = readJson(join(rulesDir, 'agent-state-rules-release.json'))
  if (!isAgentStateRulesVersion(release.version)) {
    throw new Error(
      `agent-state-rules-release.json: bad version ${JSON.stringify(release.version)}`
    )
  }
  const files = release.liveUpdatable.map((id) => {
    const file = readJson(join(rulesDir, `${id}.json`))
    if (file.id !== id) {
      throw new Error(`${id}.json declares id ${file.id}`)
    }
    return file
  })
  const engineVersions = new Set(files.map((file) => file.engineVersion))
  if (engineVersions.size !== 1) {
    throw new Error(`rule files disagree on engineVersion: ${[...engineVersions].join(', ')}`)
  }
  const [engineVersion] = engineVersions
  const bundle = {
    version: release.version,
    engineVersion,
    ...(bundledOnly ? { bundledOnly: true } : {}),
    files
  }
  return { bundle, text: `${JSON.stringify(bundle, null, 2)}\n` }
}

/**
 * Why strictly newer: apps refuse a version they already have, so republishing one would reach
 * nobody, and a lower one would be refused by every app that took the higher.
 */
export function assertNewerThanPublished(candidateText, publishedText) {
  const candidate = JSON.parse(candidateText)
  if (publishedText === null) {
    return
  }
  const published = JSON.parse(publishedText)
  if (compareAgentStateRulesVersions(candidate.version, published.version) <= 0) {
    throw new Error(
      `version ${candidate.version} is not newer than the published ${published.version}; bump agent-state-rules-release.json`
    )
  }
}

/** The release GitHub serves as Latest is what the app updater follows: it must stay an app. */
export function assertLatestIsAppRelease(tag) {
  if (!DESKTOP_STABLE_TAG.test(tag)) {
    throw new Error(`GitHub's latest release is ${tag}, not a stable desktop release`)
  }
}

const GATE_TEST_FILE =
  /^(?:src\/main\/runtime\/agent-state-rules\/|src\/main\/runtime\/readiness-census|src\/main\/runtime\/[^/]*transcripts?\.test\.ts$|config\/scripts\/agent-state-rules-bundle\.test\.mjs$)/

/** The tests a rules change must pass: schema and regex safety, the bundle, and every replay. */
export async function agentStateRulesGateTestFiles(root = REPO_ROOT) {
  // Why lazy: it needs vitest installed, and the publish jobs run this script without dependencies.
  const { discoverUnitFiles } = await import('./ci-unit-files.mjs')
  return discoverUnitFiles(root)
    .filter((file) => GATE_TEST_FILE.test(file))
    .toSorted()
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function ghOrThrow(gh, args) {
  const result = gh(args)
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function releaseExists(gh, repo, tag) {
  const result = gh(['release', 'view', tag, '--repo', repo])
  if (result.status === 0) {
    return true
  }
  if (/not found/i.test(result.stderr)) {
    return false
  }
  throw new Error(`gh release view ${tag} failed: ${result.stderr.trim()}`)
}

/**
 * Puts `file` on `tag`'s release and proves GitHub's Latest is still the desktop app. `gh` is
 * injectable so the sequence is testable without a repository.
 */
export function publishAgentStateRules({ repo, tag, file, target, gh = runGh }) {
  const [, engine, channel] = AGENT_STATE_RULES_TAG.exec(tag) ?? []
  if (!channel) {
    throw new Error(`not an agent state rules tag: ${tag}`)
  }
  if (basename(file) !== AGENT_STATE_RULES_ASSET) {
    throw new Error(`the asset must be named ${AGENT_STATE_RULES_ASSET}, not ${basename(file)}`)
  }
  const candidateText = readFileSync(file, 'utf8')
  const candidate = JSON.parse(candidateText)
  // Why: apps on one engine fetch one tag, and refuse a file built for another engine.
  if (String(candidate.engineVersion) !== engine) {
    throw new Error(`${file} is built for rules engine ${candidate.engineVersion}, not ${tag}`)
  }
  const title = `Agent state rules ${candidate.version} (${channel})`
  if (releaseExists(gh, repo, tag)) {
    const publishedDir = mkdtempSync(join(tmpdir(), 'agent-state-rules-published-'))
    // Why throw on a missing asset: a release without its file means an earlier upload broke.
    ghOrThrow(gh, [
      'release',
      'download',
      tag,
      '--repo',
      repo,
      '--pattern',
      AGENT_STATE_RULES_ASSET,
      '--dir',
      publishedDir
    ])
    assertNewerThanPublished(
      candidateText,
      readFileSync(join(publishedDir, AGENT_STATE_RULES_ASSET), 'utf8')
    )
    // Why --clobber on the same tag: the tag never moves, so the app's fixed URL stays valid, and
    // a fetch that lands mid-upload gets a 404 and keeps its last good copy.
    ghOrThrow(gh, ['release', 'upload', tag, file, '--repo', repo, '--clobber'])
    ghOrThrow(gh, [
      'release',
      'edit',
      tag,
      '--repo',
      repo,
      '--prerelease',
      '--latest=false',
      '--title',
      title
    ])
  } else {
    assertNewerThanPublished(candidateText, null)
    ghOrThrow(gh, [
      'release',
      'create',
      tag,
      file,
      '--repo',
      repo,
      '--target',
      target,
      '--prerelease',
      '--latest=false',
      '--title',
      title,
      '--notes',
      'Agent state rules for Orca. Running apps download this file; it is not an app release.'
    ])
  }
  const latest = ghOrThrow(gh, ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'])
  assertLatestIsAppRelease(latest.trim())
  return latest.trim()
}

/**
 * Why no rebuild and no re-gate: stable gets exactly the bytes RC and dev builds soaked on next,
 * which only the gated publish-next job writes. A bundledOnly next is promoted too: that is how
 * stable rolls back to the rules it shipped.
 */
export function promoteAgentStateRules({ repo, nextTag, stableTag, target, gh = runGh }) {
  const nextDir = mkdtempSync(join(tmpdir(), 'agent-state-rules-next-'))
  ghOrThrow(gh, [
    'release',
    'download',
    nextTag,
    '--repo',
    repo,
    '--pattern',
    AGENT_STATE_RULES_ASSET,
    '--dir',
    nextDir
  ])
  return publishAgentStateRules({
    repo,
    tag: stableTag,
    file: join(nextDir, AGENT_STATE_RULES_ASSET),
    target,
    gh
  })
}

function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }
  console.log(lines.join('\n'))
}

function requireRepo() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY is not set')
  }
  return repo
}

async function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'build': {
      const out = args.find((arg) => !arg.startsWith('--'))
      if (!out) {
        throw new Error('usage: build <out> [--bundled-only]')
      }
      const { bundle, text } = buildAgentStateRulesBundle({
        bundledOnly: args.includes('--bundled-only')
      })
      writeFileSync(out, text)
      writeOutputs({ next_tag: agentStateRulesTag(bundle.engineVersion, 'next') })
      return
    }
    case 'gate-files':
      console.log((await agentStateRulesGateTestFiles()).join('\n'))
      return
    case 'publish': {
      const [tag, file, target] = args
      const latest = publishAgentStateRules({ repo: requireRepo(), tag, file, target })
      console.log(`Published ${file} to ${tag}; Latest is still ${latest}.`)
      return
    }
    case 'promote': {
      const [target] = args
      const { engineVersion } = buildAgentStateRulesBundle().bundle
      const nextTag = agentStateRulesTag(engineVersion, 'next')
      const stableTag = agentStateRulesTag(engineVersion, 'stable')
      const latest = promoteAgentStateRules({ repo: requireRepo(), nextTag, stableTag, target })
      console.log(`Promoted ${nextTag} to ${stableTag}; Latest is still ${latest}.`)
      return
    }
    default:
      throw new Error(`unknown command ${command ?? '(none)'}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
