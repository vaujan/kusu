import { useEffect, useRef } from 'react'
import { IconAdjustmentsHorizontal, IconNote, IconPlus, IconTrash } from '@tabler/icons-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ShortcutKbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ItemFilterMenuGroups, ItemSortMenuGroup } from '@/features/items/item-retrieval-menu'
import { DEFAULT_ITEM_SORT, type ItemSort } from '@/features/items/item-sort'
import type { ItemTypeFilter } from '@/features/items/item-view'
import { LibrarySearchInput } from '@/features/search/library-search-input'
import { ShellSidebarTrigger } from '@/features/shell/shell-sidebar-trigger'
import { WindowControls } from '@/features/shell/window-controls'
import { useNativeTitleBar } from '@/hooks/use-native-title-bar'

export function AppToolbar({
  menu,
  newItemOpen,
  hasDraft,
  newItemFocusRequest,
  onNewNote,
  onNewItem,
  onDiscardDraft,
  destinationLabel,
  searchQuery,
  searchPending,
  searchFocusRequest,
  onSearchQueryChange,
  typeFilters,
  onTypeFilterChange,
  showReferencedAttachments,
  onShowReferencedAttachmentsChange,
  onClearFilters,
  sort,
  onSortChange,
  onWindowClose
}: {
  menu: React.ReactNode
  newItemOpen: boolean
  hasDraft: boolean
  newItemFocusRequest: number
  onNewNote: () => void
  onNewItem: () => void
  onDiscardDraft: () => void
  destinationLabel: string
  searchQuery: string
  searchPending: boolean
  searchFocusRequest: number
  onSearchQueryChange: (query: string) => void
  typeFilters: ItemTypeFilter[]
  onTypeFilterChange: (type: ItemTypeFilter, selected: boolean) => void
  showReferencedAttachments: boolean
  onShowReferencedAttachmentsChange: (show: boolean) => void
  onClearFilters: () => void
  sort: ItemSort
  onSortChange: (sort: ItemSort) => void
  onWindowClose?: () => void
}): React.JSX.Element {
  const isMac = window.electron.window.platform === 'darwin'
  const commandKey = isMac ? 'Cmd' : 'Ctrl'
  const ariaCommandKey = isMac ? 'Meta' : 'Control'
  const newItemRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filterCount = typeFilters.length + Number(showReferencedAttachments)
  const retrievalActive = filterCount > 0 || sort !== DEFAULT_ITEM_SORT

  useEffect(() => {
    if (newItemFocusRequest > 0) newItemRef.current?.focus()
  }, [newItemFocusRequest])

  useEffect(() => {
    if (searchFocusRequest > 0) searchInputRef.current?.focus()
  }, [searchFocusRequest])

  const nativeTitleBar = useNativeTitleBar()

  return (
    <header
      className="window-toolbar flex h-12 shrink-0 select-none items-center [-webkit-app-region:drag]"
      data-tauri-drag-region={
        window.electron.window.titleBar && !nativeTitleBar ? 'deep' : undefined
      }
    >
      <div className="@container/toolbar min-w-0 flex-1">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 @min-[44rem]/toolbar:gap-3 @min-[44rem]/toolbar:px-5 @min-[64rem]/toolbar:px-7">
          <div className="flex min-w-0 items-center justify-start gap-1">
            <ShellSidebarTrigger />
            {menu}
          </div>

          <div
            className="flex min-w-0 w-full max-w-[28rem] items-center justify-self-center gap-1 [-webkit-app-region:no-drag]"
            data-tauri-drag-region="false"
          >
            <LibrarySearchInput
              inputRef={searchInputRef}
              value={searchQuery}
              onValueChange={onSearchQueryChange}
              pending={searchPending}
              scopeLabel={destinationLabel}
              className="h-8 flex-1 rounded-4xl"
            />
            <Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <TooltipTrigger
                      render={
                        <Button
                          className="gap-1"
                          size={filterCount > 0 ? 'sm' : 'icon-sm'}
                          variant={retrievalActive ? 'tonal' : 'ghost'}
                          data-lifted={retrievalActive}
                          aria-label={`Sort and filter ${destinationLabel}`}
                        />
                      }
                    />
                  }
                >
                  <IconAdjustmentsHorizontal data-icon="inline-start" aria-hidden="true" />
                  {filterCount > 0 ? (
                    <Badge
                      className="min-w-4 justify-center tabular-nums"
                      size="sm"
                      variant="default"
                    >
                      {filterCount}
                    </Badge>
                  ) : null}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <ItemSortMenuGroup sort={sort} onSortChange={onSortChange} />
                  <DropdownMenuSeparator />
                  <ItemFilterMenuGroups
                    typeFilters={typeFilters}
                    onTypeFilterChange={onTypeFilterChange}
                    showReferencedAttachments={showReferencedAttachments}
                    onShowReferencedAttachmentsChange={onShowReferencedAttachmentsChange}
                    onClearFilters={onClearFilters}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
              <TooltipContent>Sort and filter items</TooltipContent>
            </Tooltip>
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1 [-webkit-app-region:no-drag]">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    className="@min-[48rem]/toolbar:w-auto @min-[48rem]/toolbar:gap-1 @min-[48rem]/toolbar:px-3 @min-[48rem]/toolbar:has-data-[icon=inline-start]:pl-2"
                    data-lifted="true"
                    aria-keyshortcuts={`${ariaCommandKey}+N`}
                    aria-label="Create new note"
                    onClick={onNewNote}
                  />
                }
              >
                <IconNote data-icon="inline-start" aria-hidden="true" />
                <span className="hidden @min-[48rem]/toolbar:inline">New note</span>
              </TooltipTrigger>
              <TooltipContent>
                New note <ShortcutKbd shortcut={`${commandKey}+N`} />
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    ref={newItemRef}
                    size="icon-sm"
                    className="@min-[48rem]/toolbar:w-auto @min-[48rem]/toolbar:gap-1 @min-[48rem]/toolbar:px-3 @min-[48rem]/toolbar:has-data-[icon=inline-start]:pl-2"
                    variant="tonal"
                    data-lifted={newItemOpen || hasDraft}
                    data-new-item-button
                    aria-expanded={newItemOpen}
                    aria-keyshortcuts={`${ariaCommandKey}+Shift+N`}
                    aria-label={hasDraft && !newItemOpen ? 'Continue Add item draft' : 'Add item'}
                    onClick={onNewItem}
                  />
                }
              >
                <IconPlus data-icon="inline-start" aria-hidden="true" />
                <span className="hidden @min-[48rem]/toolbar:inline">Add item</span>
              </TooltipTrigger>
              <TooltipContent>
                {hasDraft && !newItemOpen ? 'Continue draft' : 'Add item'}{' '}
                <ShortcutKbd shortcut={`${commandKey}+Shift+N`} />
              </TooltipContent>
            </Tooltip>
            {hasDraft ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Discard New item draft"
                      onClick={onDiscardDraft}
                    />
                  }
                >
                  <IconTrash aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>Discard draft</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
      <WindowControls onClose={onWindowClose} />
    </header>
  )
}
