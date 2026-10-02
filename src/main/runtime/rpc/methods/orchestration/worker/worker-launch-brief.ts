/**
 * A worker's dispatch brief delivered on its agent's launch command line, in a sensitive launch
 * file, instead of pasted into the agent's screen once it looks ready.
 *
 * Why: a paste races the agent's startup; a fresh Codex lost or truncated worker briefs, and Enter
 * could land on a startup dialog (#23745). The brief names the worker's handle, so it is
 * allocated before the spawn.
 */
import { getAppEnvironment } from '../../../../../../shared/app-environment'
import { carryInLaunchFile, type LaunchFile } from '../../../../../../shared/launch-prompt-file'
import { agentReadsLaunchFile } from '../../../../../../shared/launch-prompt-carry'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { agentPromptRidesLaunchCommand } from '../../../../../../shared/tui-agent-startup'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { orcaSessionIdOrHandle } from '../../../../orchestration/orchestration-party'
import { resolveTerminalOrchestrationCliCommand } from '../../../../orchestration/cli-command'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'

export type WorkerLaunchBrief = {
  /** Pre-allocated: the brief names the worker's handle before its terminal exists. */
  handle: string
  startupPrompt: string
  launchFile: LaunchFile
  /** Taken before the spawn: only a prompt-carrying hook turn after it proves the brief landed. */
  launchStartedAt: number
}

export type WorkerLaunchBriefFactory = (worktreeId: string) => Promise<WorkerLaunchBrief>

export function createWorkerLaunchBriefFactory(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  agent: TuiAgent | undefined
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
}): WorkerLaunchBriefFactory | undefined {
  const { runtime, agent } = args
  // Why: an agent that takes its text only after start has no launch command to carry it, and one
  // not measured reading its launch file would stop on an approval; both keep the paste.
  if (!agent || !agentPromptRidesLaunchCommand(agent) || !agentReadsLaunchFile(agent)) {
    return undefined
  }
  return async (worktreeId) => {
    const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const target = {
      connectionId: scope.connectionId,
      isWsl: undefined,
      worktreeId,
      projectRuntime: runtime.resolveProjectRuntimeForWorktree(worktreeId)
    }
    const handle = runtime.createPreAllocatedTerminalHandle()
    const brief = buildDispatchPreamble({
      canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      taskSpec: args.taskSpec,
      coordinatorHandle: orcaSessionIdOrHandle(args.coordinatorHandle, args.db),
      workerHandle: handle,
      devMode: args.devMode,
      cliCommand: resolveTerminalOrchestrationCliCommand({
        ...target,
        runtimeCliCommand: getAppEnvironment().isPackaged() ? undefined : 'orca-dev'
      })
    })
    // Why sensitive: Orca's brief, not the user's words, is never shown as the worker's prompt or
    // used to name its worktree.
    const { prompt, launchFile } = carryInLaunchFile(brief, true)
    return { handle, startupPrompt: prompt, launchFile, launchStartedAt: Date.now() }
  }
}
