import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { readFetchResponseTextWithinLimit } from '../../../shared/fetch-response-body'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getVersionChannel, MAIN_RELEASE_REPO } from '../../../shared/release-channel'
import { getMainHttpClient } from '../../network/http-client'
import { writePluginFileAtomically } from '../../plugins/plugin-atomic-file-write'
import {
  activateAgentStateRules,
  bundledAgentStateRules,
  getActiveAgentStateRules,
  overlayOnBundledAgentStateRules,
  type ActiveAgentStateRules,
  type AgentStateRulesSource
} from './active-agent-state-rules'
import {
  AGENT_STATE_RULES_BUNDLE_MAX_BYTES,
  BUNDLED_AGENT_STATE_RULES_VERSION,
  compareAgentStateRulesVersions,
  parseAgentStateRulesBundle,
  type AgentStateRulesBundle
} from './agent-state-rules-bundle'
import { AGENT_STATE_RULES_ENGINE_VERSION } from './agent-state-rules-schema'

/** The published asset's name; each channel caches it under its own name. */
const AGENT_STATE_RULES_FILE_NAME = 'agent-state-rules.json'

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

export type AgentStateRulesChannel = 'next' | 'stable'

/** Stable apps read the stable tag; RC, hourly, daily and adhoc builds soak the next one first. */
export function agentStateRulesChannelForAppVersion(
  appVersion: string
): AgentStateRulesChannel | null {
  const channel = getVersionChannel(appVersion)
  if (!channel) {
    return null
  }
  return channel === 'stable' ? 'stable' : 'next'
}

// Why a fixed release-download URL: no API call or rate limit, and no "latest" lookup to steer.
export function agentStateRulesDownloadUrl(channel: AgentStateRulesChannel): string {
  const tag = `agent-state-rules-engine-${AGENT_STATE_RULES_ENGINE_VERSION}-${channel}`
  return `https://github.com/${MAIN_RELEASE_REPO}/releases/download/${tag}/${AGENT_STATE_RULES_FILE_NAME}`
}

// Why per channel: stable and RC builds share userData, and a stable app must not run, or be
// held below, rules that only next has published.
export function agentStateRulesCacheFileName(channel: AgentStateRulesChannel): string {
  return `agent-state-rules-${channel}.json`
}

type LiveUpdateSettings = Pick<GlobalSettings, 'agentStateRulesPath' | 'agentStateRulesLiveUpdates'>

export type AgentStateRulesLiveUpdateDeps = {
  userDataPath: string
  appVersion: string
  /** Unpackaged dev and test runs never download. */
  isPackaged: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  readSettings: () => LiveUpdateSettings | null | undefined
  env: NodeJS.ProcessEnv
  /** Called when the active version or source changes, for diagnostics and crash reports. */
  onActivated: (rules: { version: string; source: AgentStateRulesSource }) => void
}

type BundleRead = { bundle: AgentStateRulesBundle | null; error: string | null }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isNewerThan(bundle: AgentStateRulesBundle, version: string): boolean {
  return compareAgentStateRulesVersions(bundle.version, version) > 0
}

function parseBundleRead(
  label: string,
  text: string,
  scope: 'live-updatable' | 'any-agent'
): BundleRead {
  const parsed = parseAgentStateRulesBundle(text, scope)
  return parsed.ok
    ? { bundle: parsed.bundle, error: null }
    : { bundle: null, error: `${label} rejected: ${parsed.error}` }
}

async function readBundleFile(
  label: string,
  path: string,
  scope: 'live-updatable' | 'any-agent',
  missingIsError: boolean
): Promise<BundleRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = isMissingFile(error) && !missingIsError
    return { bundle: null, error: missing ? null : `${label} unreadable: ${describeError(error)}` }
  }
  return parseBundleRead(label, text, scope)
}

/**
 * Keeps the active agent state rules current: a local override, else a downloaded copy newer than
 * the bundled one, else the bundled rules. Any failure keeps the last good copy active.
 */
export class AgentStateRulesLiveUpdater {
  private override: AgentStateRulesBundle | null = null
  /** Always newer than the bundled rules, so it is also the floor a download must clear. */
  private downloaded: AgentStateRulesBundle | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  // Why: a settings change restarts while an earlier start or fetch may still be pending, and a
  // superseded one must not change the active rules.
  private generation = 0

  constructor(private readonly deps: AgentStateRulesLiveUpdateDeps) {}

  /** Loads the override and the cached download, then fetches now and on an interval. Re-run it
   *  when the settings it reads change. */
  async start(): Promise<void> {
    this.stop()
    const generation = this.generation
    const channel = this.liveUpdateChannel()
    const [override, cached] = await Promise.all([
      this.readOverride(),
      channel
        ? readBundleFile('cached rules', this.cachePath(channel), 'live-updatable', false)
        : null
    ])
    if (generation !== this.generation) {
      return
    }
    this.warn(override?.error)
    this.warn(cached?.error)
    this.override = override?.bundle ?? null
    // Why re-check the version: an app update may have bundled rules newer than the cache.
    const downloaded = cached?.bundle
    this.downloaded =
      downloaded && isNewerThan(downloaded, BUNDLED_AGENT_STATE_RULES_VERSION) ? downloaded : null
    this.activate()
    if (!channel) {
      return
    }
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
    this.timer.unref?.()
    await this.refresh()
  }

  stop(): void {
    this.generation += 1
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Fetches the channel's file now; does nothing unless started with live updates on. */
  async refresh(): Promise<void> {
    const channel = this.liveUpdateChannel()
    if (!this.timer || !channel) {
      return
    }
    const generation = this.generation
    const fetched = await this.fetchText(channel)
    if (generation !== this.generation) {
      return
    }
    if (typeof fetched !== 'string') {
      this.warn(fetched.error)
      return
    }
    const { bundle, error } = parseBundleRead('download', fetched, 'live-updatable')
    this.warn(error)
    // Why newer than both: an app whose bundled rules already hold a fix must not be shadowed by
    // an older download, and a cached copy must never be replaced by an older one.
    const floor = this.downloaded?.version ?? BUNDLED_AGENT_STATE_RULES_VERSION
    if (!bundle || !isNewerThan(bundle, floor)) {
      return
    }
    this.downloaded = bundle
    this.activate()
    try {
      await writePluginFileAtomically(this.cachePath(channel), fetched)
    } catch (error) {
      this.warn(`downloaded rules not cached: ${describeError(error)}`)
    }
  }

  /** The channel to fetch, or null when this build or its settings take no downloads. */
  private liveUpdateChannel(): AgentStateRulesChannel | null {
    const enabled =
      this.deps.isPackaged &&
      this.deps.env.ORCA_DISABLE_AGENT_STATE_RULES_UPDATES !== '1' &&
      this.deps.readSettings()?.agentStateRulesLiveUpdates !== false
    return enabled ? agentStateRulesChannelForAppVersion(this.deps.appVersion) : null
  }

  private cachePath(channel: AgentStateRulesChannel): string {
    return join(this.deps.userDataPath, agentStateRulesCacheFileName(channel))
  }

  private warn(error: string | null | undefined): void {
    if (error) {
      console.warn(`[agent-state-rules] ${error}`)
    }
  }

  private readOverride(): Promise<BundleRead> | null {
    const path =
      this.deps.env.ORCA_AGENT_STATE_RULES_PATH || this.deps.readSettings()?.agentStateRulesPath
    // Why any agent: the user chose this file, so the transcript gate on releases does not apply.
    return path ? readBundleFile(`override ${path}`, path, 'any-agent', true) : null
  }

  /** The published file's text, or why there is none. */
  private async fetchText(channel: AgentStateRulesChannel): Promise<string | { error: string }> {
    try {
      const response = await this.deps.fetch(agentStateRulesDownloadUrl(channel), {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        // Why not fatal: a 404 is also what a re-upload in progress looks like.
        return { error: `download failed: HTTP ${response.status}` }
      }
      return await readFetchResponseTextWithinLimit(response, AGENT_STATE_RULES_BUNDLE_MAX_BYTES)
    } catch (error) {
      return { error: `download failed: ${describeError(error)}` }
    }
  }

  private resolveActive(): ActiveAgentStateRules {
    const chosen = this.override ?? (this.downloaded?.bundledOnly ? null : this.downloaded)
    if (!chosen) {
      return bundledAgentStateRules()
    }
    return {
      files: overlayOnBundledAgentStateRules(chosen.files),
      version: chosen.version,
      source: chosen === this.override ? 'override' : 'downloaded'
    }
  }

  private activate(): void {
    const previous = getActiveAgentStateRules()
    const next = this.resolveActive()
    activateAgentStateRules(next)
    if (previous.version !== next.version || previous.source !== next.source) {
      this.deps.onActivated({ version: next.version, source: next.source })
    }
  }
}

/**
 * Starts live updates on this host: the desktop, `orca serve` and orcad each fetch their own copy,
 * so a paired client never supplies the rules a host evaluates with.
 */
export function startAgentStateRulesLiveUpdates(options: {
  readSettings: () => LiveUpdateSettings | null | undefined
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => void
  onActivated: AgentStateRulesLiveUpdateDeps['onActivated']
}): void {
  const environment = getAppEnvironment()
  const updater = new AgentStateRulesLiveUpdater({
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    readSettings: options.readSettings,
    env: process.env,
    onActivated: options.onActivated
  })
  void updater.start()
  options.onSettingsChanged((updates) => {
    if ('agentStateRulesPath' in updates || 'agentStateRulesLiveUpdates' in updates) {
      void updater.start()
    }
  })
  environment.onWillQuit(() => updater.stop())
}
