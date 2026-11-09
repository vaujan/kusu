import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useNativeTitleBar } from '@/hooks/use-native-title-bar'

export function TauriSettings(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const nativeTitleBar = useNativeTitleBar()

  useEffect(() => {
    const openSettings = (): void => {
      setError(false)
      setOpen(true)
    }
    window.addEventListener('kusu:open-settings', openSettings)
    return () => window.removeEventListener('kusu:open-settings', openSettings)
  }, [])

  const changeTitleBar = async (native: boolean): Promise<void> => {
    setError(false)
    setPending(true)
    try {
      await window.electron.window.titleBar?.setNative(native)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance</DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal" data-disabled={pending || undefined}>
          <FieldContent>
            <FieldLabel htmlFor="settings-native-title-bar">Use system title bar</FieldLabel>
            <FieldDescription>Show the Windows title bar above Kusu’s toolbar.</FieldDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                Couldn’t change the title bar. Try again.
              </p>
            ) : null}
          </FieldContent>
          <Switch
            id="settings-native-title-bar"
            checked={nativeTitleBar}
            disabled={pending}
            onCheckedChange={(native) => void changeTitleBar(native)}
          />
        </Field>
      </DialogContent>
    </Dialog>
  )
}
