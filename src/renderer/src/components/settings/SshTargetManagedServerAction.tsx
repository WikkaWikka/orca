import { ArrowRightLeft } from 'lucide-react'
import { useState } from 'react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { MoveToManagedServerDialog } from './MoveToManagedServerDialog'
import { canMoveHostToManagedServer } from './managed-server-hosts'

type SshTargetManagedServerActionProps = {
  target: SshTarget
  onMoved: () => unknown
}

/** "Move to managed server" under an SSH host, behind the Managed servers experiment. */
export function SshTargetManagedServerAction({
  target,
  onMoved
}: SshTargetManagedServerActionProps): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.experimentalManagedServers === true)
  const state = useAppStore((s) => s.sshConnectionStates.get(target.id))
  const api = window.api.runtimeEnvironments.managedOrcad
  const [open, setOpen] = useState(false)
  if (!enabled || !api || !canMoveHostToManagedServer(state)) {
    return null
  }
  return (
    <>
      <div className="flex justify-end px-1">
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(true)}>
          <ArrowRightLeft />
          {translate(
            'auto.components.settings.managedServers.move.action',
            'Move to managed server'
          )}
        </Button>
      </div>
      <MoveToManagedServerDialog
        api={api}
        target={open ? target : null}
        onClose={() => setOpen(false)}
        onFinished={() => void onMoved()}
      />
    </>
  )
}
