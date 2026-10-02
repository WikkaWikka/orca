/** The live collaborators a host conversion needs: the relay, the direct session and the server. */
import { encodePairingOffer } from '../../shared/pairing'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { getSshPtyProvider } from '../ipc/pty/provider/registry'
import { disconnectRegisteredSshTarget } from '../ipc/ssh-session-teardown'
import { toRelaySshPtyId } from '../providers/ssh-pty-id'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'
import {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} from './orcad-migration-catalog-client'
import type { OrcadManagedConversionArgs } from './orcad-runtime-conversion'

const RELAY_INVENTORY_DEADLINE_MS = 10_000

/** The T6-9 client against this server, pinned to the runtime it paired with. */
export function orcadMigrationDestinationFor(
  environment: KnownRuntimeEnvironment
): OrcadMigrationDestinationCatalog {
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  return {
    readState: (manifest) => readRemoteOrcadMigrationCatalogState(pairingCode, manifest, options),
    stage: (manifest) => stageRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    commit: (manifest) => commitRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    abort: (manifest) => abortRemoteOrcadMigrationCatalog(pairingCode, manifest, options),
    stageChunk: (request) => stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request, options)
  }
}

/** The relay's own process list; `null` when there is no live relay to ask. */
export function relayPtyInventoryFor(
  sshTargetId: string
): OrcadManagedConversionArgs['listRelayPtyIds'] {
  const provider = getSshPtyProvider(sshTargetId)
  if (!provider) {
    return null
  }
  return async () =>
    (await provider.listProcesses({ deadlineMs: RELAY_INVENTORY_DEADLINE_MS })).map((process) =>
      toRelaySshPtyId(sshTargetId, process.id)
    )
}

export function conversionCollaborators(
  sshTargetId: string
): Pick<OrcadManagedConversionArgs, 'destinationFor' | 'listRelayPtyIds' | 'releaseDirectSession'> {
  return {
    destinationFor: orcadMigrationDestinationFor,
    listRelayPtyIds: relayPtyInventoryFor(sshTargetId),
    releaseDirectSession: disconnectRegisteredSshTarget
  }
}
