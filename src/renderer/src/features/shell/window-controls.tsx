import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { useNativeTitleBar } from '@/hooks/use-native-title-bar'

const WINDOWS_CAPTION_GLYPHS = {
  minimize: '\uE921',
  maximize: '\uE922',
  restore: '\uE923',
  close: '\uE8BB'
} as const

function LinuxCaptionIcon({
  name
}: {
  name: 'minimize' | 'maximize' | 'restore' | 'close'
}): React.JSX.Element {
  return (
    <svg
      className="size-3"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="square"
      strokeLinejoin="miter"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      {name === 'minimize' ? <path d="M2.5 6.25h7" /> : null}
      {name === 'maximize' ? <rect x="2.5" y="2.5" width="7" height="7" /> : null}
      {name === 'restore' ? (
        <>
          <path d="M4 2.5h5.5V8" />
          <rect x="2.5" y="4" width="5.5" height="5.5" />
        </>
      ) : null}
      {name === 'close' ? <path d="m3 3 6 6M9 3 3 9" /> : null}
    </svg>
  )
}

export function CaptionTileButton({
  label,
  onClick,
  close = false,
  disabled = false,
  appearance = 'windows',
  className,
  children
}: {
  label: string
  onClick?: () => void
  close?: boolean
  disabled?: boolean
  appearance?: 'windows' | 'linux'
  className?: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'grid shrink-0 place-items-center border-0 bg-transparent p-0 text-foreground outline-none',
        'focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]',
        appearance === 'windows' &&
          'h-full w-[46px] hover:bg-black/[0.06] active:bg-black/[0.12] dark:hover:bg-white/[0.08] dark:active:bg-white/[0.12]',
        appearance === 'linux' &&
          'h-10 w-10 text-foreground/80 transition-colors hover:bg-foreground/[0.11] hover:text-foreground active:bg-foreground/[0.18] motion-reduce:transition-none',
        appearance === 'windows' &&
          close &&
          'hover:bg-[#c42b1c] hover:text-white active:bg-[#a4262c] active:text-white dark:hover:bg-[#c42b1c] dark:active:bg-[#a4262c]',
        appearance === 'linux' &&
          close &&
          'hover:bg-[#c42b1c] hover:text-white active:bg-[#a4262c] active:text-white',
        disabled && 'pointer-events-none opacity-40',
        className
      )}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="grid place-items-center" aria-hidden="true">
        {children}
      </span>
    </button>
  )
}

function CaptionButton({
  label,
  glyph,
  close = false,
  appearance = 'windows',
  onClick
}: {
  label: string
  glyph: ReactNode
  close?: boolean
  appearance?: 'windows' | 'linux'
  onClick: () => void
}): React.JSX.Element {
  return (
    <CaptionTileButton label={label} close={close} appearance={appearance} onClick={onClick}>
      <span
        className={cn(
          'grid place-items-center',
          appearance === 'windows' && 'windows-caption-glyph'
        )}
        aria-hidden="true"
      >
        {glyph}
      </span>
    </CaptionTileButton>
  )
}

export function WindowControls({
  onClose
}: { onClose?: () => void } = {}): React.JSX.Element | null {
  const { platform } = window.electron.window
  const nativeTitleBar = useNativeTitleBar()
  const isWindows = platform === 'win32'
  const hasCustomControls = platform !== 'darwin' && !nativeTitleBar
  const appearance = isWindows ? 'windows' : 'linux'
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!hasCustomControls) return

    let mounted = true
    void window.electron.window.isMaximized().then((value) => {
      if (mounted) setIsMaximized(value)
    })
    const unsubscribe = window.electron.window.onMaximizedChange(setIsMaximized)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [hasCustomControls])

  if (!hasCustomControls) return null

  const minimizeGlyph = isWindows ? (
    WINDOWS_CAPTION_GLYPHS.minimize
  ) : (
    <LinuxCaptionIcon name="minimize" />
  )
  const maximizeGlyph = isWindows ? (
    isMaximized ? (
      WINDOWS_CAPTION_GLYPHS.restore
    ) : (
      WINDOWS_CAPTION_GLYPHS.maximize
    )
  ) : isMaximized ? (
    <LinuxCaptionIcon name="restore" />
  ) : (
    <LinuxCaptionIcon name="maximize" />
  )
  const closeGlyph = isWindows ? WINDOWS_CAPTION_GLYPHS.close : <LinuxCaptionIcon name="close" />

  return (
    <div className="flex h-10 self-stretch [-webkit-app-region:no-drag]">
      <CaptionButton
        label="Minimize window"
        glyph={minimizeGlyph}
        appearance={appearance}
        onClick={window.electron.window.minimize}
      />
      <CaptionButton
        label={isMaximized ? 'Restore window' : 'Maximize window'}
        glyph={maximizeGlyph}
        appearance={appearance}
        onClick={window.electron.window.toggleMaximize}
      />
      <CaptionButton
        close
        label="Close window"
        glyph={closeGlyph}
        appearance={appearance}
        onClick={onClose ?? window.electron.window.close}
      />
    </div>
  )
}
