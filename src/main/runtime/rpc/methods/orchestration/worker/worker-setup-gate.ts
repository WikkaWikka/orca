import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
import {
  applyWaitForSetupOutcome,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'

function residualWorkerEffects(effects: WorkerEffect[]): WorkerEffect[] {
  // 'reused_agent_terminal' is the retired verb agent-first creation used for its own agent
  // terminal; rows persisted before the rename still carry it.
  return effects.filter(
    (effect) => effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal'
  )
}

type WorkerSetupStageArgs = {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  /** Absent while a created worktree's agent terminal waits on setup. */
  terminalHandle?: string
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
}

export function persistWorkerReadinessStage(args: WorkerSetupStageArgs): void {
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_readying',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}

export function persistGatedSetupSpawnFailure(args: WorkerSetupStageArgs): boolean {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'spawn_failed') {
    return false
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'setup_start',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
  return true
}

export function persistWorkerSetupWaitOutcome(
  args: WorkerSetupStageArgs & { wait: { satisfied: boolean; status: string } }
): void {
  applyWaitForSetupOutcome(args.setup, args.effects, args.wait)
  if (args.setup.startupPolicy !== 'wait-for-setup') {
    return
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: args.setup.state === 'failed' ? 'setup_failed' : 'setup_settled',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}

/**
 * Holds a created worktree's agent terminal until its wait-for-setup gate settles. Agent-first
 * creation sequences the launch line behind setup in the shell; a worker whose brief rides that
 * line creates its terminal afterwards, so it has to wait here instead.
 */
export function createSetupBeforeAgentGate(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
  db: OrchestrationDb
  dispatchId: string
  effects: WorkerEffect[]
  timeoutMs: number
  onStage: (stage: string) => void
  /** A failed gate throws before placement returns, so the failure receipt needs this copy. */
  onSetupReceipt: (setup: WorkerSetupReceipt) => void
}): (worktreeId: string, setup: WorkerSetupReceipt) => Promise<void> {
  return async (worktreeId, setup) => {
    args.onSetupReceipt(setup)
    const setupStage = {
      db: args.db,
      dispatchId: args.dispatchId,
      worktreeId,
      setup,
      effects: args.effects
    }
    if (persistGatedSetupSpawnFailure(setupStage)) {
      args.onStage('setup_start')
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    args.onStage('setup_wait')
    const wait = await awaitStructuredWorkerSetupGate({
      runtime: args.runtime,
      setup,
      effects: args.effects,
      timeoutMs: args.timeoutMs
    })
    if (wait) {
      persistWorkerSetupWaitOutcome({ ...setupStage, wait })
      if (!wait.satisfied) {
        throw new Error(`Setup did not finish before the worker's agent started (${wait.status}).`)
      }
    }
  }
}

/**
 * What a launched brief's turn start may still wait once the setup gate has run: setup and turn
 * share one start budget, as setup and agent boot did when the brief was pasted. The floor keeps
 * the turn the window a pasted brief always had.
 */
export function remainingLaunchObservationMs(
  timeoutMs: number,
  setupGateStartedAt: number | undefined
): number {
  return setupGateStartedAt === undefined
    ? timeoutMs
    : Math.max(setupGateStartedAt + timeoutMs - Date.now(), AGENT_PROMPT_EFFECT_TIMEOUT_MS)
}
