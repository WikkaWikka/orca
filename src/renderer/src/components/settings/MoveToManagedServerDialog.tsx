import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  OrcadManagedConversionPreview,
  OrcadManagedConversionResult
} from '../../../../shared/orcad-managed-runtime'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { conversionBlockerLabel, conversionMovesSummary } from './managed-server-copy'

type Phase = 'preview' | 'running' | 'done'

type MoveToManagedServerDialogProps = {
  api: ManagedOrcadPreloadApi
  target: SshTarget | null
  onClose: () => void
  onFinished: () => void
}

export function MoveToManagedServerDialog({
  api,
  target,
  onClose,
  onFinished
}: MoveToManagedServerDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [preview, setPreview] = useState<OrcadManagedConversionPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [phase, setPhase] = useState<Phase>('preview')
  const [result, setResult] = useState<OrcadManagedConversionResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) {
      return
    }
    setPreview(null)
    setPreviewError(null)
    setName(target.label)
    setConfirmed(false)
    setPhase('preview')
    setResult(null)
    setRunError(null)
    api.previewConversion({ sshTargetId: target.id }).then(
      (next) => mountedRef.current && setPreview(next),
      (error: unknown) =>
        mountedRef.current &&
        setPreviewError(error instanceof Error ? error.message : String(error))
    )
  }, [api, mountedRef, target])

  const blocked = !preview || preview.blockers.length > 0 || preview.terminals.verdict !== 'exited'

  const move = async (): Promise<void> => {
    if (!target) {
      return
    }
    setPhase('running')
    setRunError(null)
    try {
      const next = await api.convertSshHost({ sshTargetId: target.id, name: name.trim() })
      if (mountedRef.current) {
        setResult(next)
      }
      onFinished()
    } catch (error) {
      if (mountedRef.current) {
        setRunError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) {
        setPhase('done')
      }
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && phase !== 'running' && onClose()}
    >
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.managedServers.move.title',
              'Move to managed server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.managedServers.move.description',
              'Orca installs a server on {{host}} and moves this host’s projects onto it. The host keeps everything until the server confirms it has a copy.',
              { host: target?.label ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>

        {phase === 'preview' ? (
          <div className="space-y-3 text-sm">
            {previewError ? <p className="text-xs text-destructive">{previewError}</p> : null}
            {!preview && !previewError ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            {preview ? (
              <>
                <div className="space-y-0.5">
                  <Label>
                    {translate('auto.components.settings.managedServers.move.moves', 'What moves')}
                  </Label>
                  {conversionMovesSummary(preview.moves).map((line) => (
                    <p key={line} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
                {preview.terminals.verdict !== 'exited' ? (
                  <p className="text-xs text-destructive">{preview.terminals.reason}</p>
                ) : null}
                {preview.blockers.map((blocker) => (
                  <p key={blocker.code} className="text-xs text-destructive">
                    {conversionBlockerLabel(blocker)}
                  </p>
                ))}
                <div className="space-y-1">
                  <Label>
                    {translate(
                      'auto.components.settings.managedServers.deploy.name',
                      'Server name'
                    )}
                  </Label>
                  <Input value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(value) => setConfirmed(value === true)}
                  />
                  <span>
                    {translate(
                      'auto.components.settings.managedServers.move.confirm',
                      'I have closed every terminal on this host. Running terminals cannot move and stop the move.'
                    )}
                  </span>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {phase === 'running' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate(
              'auto.components.settings.managedServers.move.running',
              'Installing the server and copying projects. You can close Settings; the move resumes from where it stopped.'
            )}
          </div>
        ) : null}

        {phase === 'done' ? (
          <p className="text-sm">
            {runError ??
              (result?.outcome === 'converted'
                ? translate(
                    'auto.components.settings.managedServers.move.converted',
                    'Moved. {{name}} now serves these projects.',
                    {
                      name: result.environment.name
                    }
                  )
                : (result?.reason ?? ''))}
          </p>
        ) : null}

        <DialogFooter>
          {phase === 'preview' ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                {translate('auto.components.settings.managedServers.move.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                disabled={blocked || !confirmed || name.trim() === ''}
                onClick={() => void move()}
              >
                {translate('auto.components.settings.managedServers.move.submit', 'Move host')}
              </Button>
            </>
          ) : null}
          {phase === 'done' ? (
            <>
              {result?.outcome !== 'converted' ? (
                <Button type="button" variant="outline" onClick={() => void move()}>
                  {translate('auto.components.settings.managedServers.move.resume', 'Resume')}
                </Button>
              ) : null}
              <Button type="button" onClick={onClose}>
                {translate('auto.components.settings.managedServers.move.close', 'Close')}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
