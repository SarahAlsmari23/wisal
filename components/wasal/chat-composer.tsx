'use client'

import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Loader2, Paperclip, X } from 'lucide-react'
import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils/cn'

const ACCEPTED_TYPES =
  '.pdf,.doc,.docx,image/png,image/jpeg,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TEXTAREA_HEIGHT = 160

export type PendingAttachment = {
  name: string
  size: number
  type: string
}

type ChatComposerProps = {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  attachment: PendingAttachment | null
  onAttachmentChange: (attachment: PendingAttachment | null) => void
  disabled?: boolean
  /** Brief spinner on the attachment chip while the file is being read. */
  isUploading?: boolean
  placeholder?: string
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  attachment,
  onAttachmentChange,
  disabled = false,
  isUploading = false,
  placeholder = 'صف مشكلتك...',
}: ChatComposerProps) {
  const { showToast } = useToast()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Grow with the content up to a cap, then scroll internally.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [value])

  const canSend = value.trim() !== '' && !disabled

  function handleSend() {
    if (!canSend) return
    onSend()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset immediately so re-picking the same file still fires a change.
    event.target.value = ''
    if (!file) return

    if (file.size > MAX_FILE_BYTES) {
      showToast('حجم الملف يتجاوز الحد المسموح (5 ميجابايت).', 'error')
      return
    }

    onAttachmentChange({ name: file.name, size: file.size, type: file.type })
  }

  return (
    // Mobile chat UI review, Part 2 — the single authoritative safe-area
    // source for this page: `pb-[max(...)]` guarantees at least the normal
    // 0.75rem breathing room while also reserving the iOS home-indicator
    // inset when the browser is actually rendering edge-to-edge (this app's
    // viewport meta doesn't set `viewport-fit=cover`, so `env()` resolves to
    // 0px today and this is a no-op in practice — kept as a deliberate,
    // singular guard rather than duplicated across parent wrappers, so nothing
    // needs revisiting if that ever changes). No other element in this tree
    // adds bottom padding/margin/offset of its own.
    <div className="border-border bg-background/85 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-lg sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <AnimatePresence initial={false}>
          {attachment ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="border-border bg-surface mb-2 flex items-center gap-2 rounded-xl border px-3 py-2">
                {isUploading ? (
                  <Loader2
                    className="text-secondary h-3.5 w-3.5 shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Paperclip className="text-secondary h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                <span className="text-foreground flex-1 truncate text-xs font-medium">
                  {attachment.name}
                </span>
                <button
                  type="button"
                  onClick={() => onAttachmentChange(null)}
                  aria-label="إزالة الملف المرفق"
                  className="text-muted-foreground hover:text-danger rounded p-0.5 transition-colors"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="border-border bg-surface shadow-soft focus-within:border-primary/50 flex items-end gap-2 rounded-2xl border p-2 transition-colors">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            onChange={handleFileChange}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachment !== null}
            aria-label="إرفاق ملف (PDF أو صورة أو Word)"
            title={attachment ? 'يمكن إرفاق ملف واحد فقط' : 'إرفاق ملف'}
            className="text-muted-foreground hover:bg-primary/6 hover:text-foreground shrink-0 rounded-xl p-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
          </button>

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={placeholder}
            aria-label="رسالتك إلى واصل"
            className="text-foreground placeholder:text-muted-foreground/70 max-h-40 flex-1 resize-none bg-transparent py-2.5 text-sm leading-relaxed focus:outline-none disabled:opacity-60"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="إرسال"
            className={cn(
              'shrink-0 rounded-xl p-2.5 transition-all duration-200',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-primary/10 text-muted-foreground cursor-not-allowed',
            )}
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="text-muted-foreground mt-2 text-center text-[11px]">
          اضغط Enter للإرسال · Shift + Enter لسطر جديد
        </p>
      </div>
    </div>
  )
}
