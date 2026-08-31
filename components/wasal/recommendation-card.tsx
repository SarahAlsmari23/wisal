'use client'

import { motion } from 'motion/react'
import { Check, Copy, ExternalLink, Save } from 'lucide-react'
import { useState } from 'react'
import { GovernmentLogo } from '@/components/government/government-logo'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import type { ComplaintAnalysis } from '@/types/wasal'

/*
 * No confidence score here by design. Once the analysis has settled on a final
 * authority, surfacing an internal certainty metric only undermines the result
 * it is attached to. `ComplaintAnalysis` still carries `confidence` and
 * `confidenceScore` for the matching logic — they are simply not user-facing.
 */

type RecommendationCardProps = {
  analysis: ComplaintAnalysis
  /** The deterministic pre-generation summary text (lib/complaints/summary.ts),
   * used by "نسخ الملخص". Omitted entirely (no copy button rendered) if ever
   * unavailable — never falls back to mock content. */
  letter?: string
  onSave: () => void
  isSaved?: boolean
  isSaving?: boolean
  /** When present, the save button is disabled and this notice is shown
   * instead of the normal label — used while routing persistence to the DB
   * is still being confirmed (Phase 6.6F). */
  saveDisabledNotice?: string
}

export function RecommendationCard({
  analysis,
  letter,
  onSave,
  isSaved = false,
  isSaving = false,
  saveDisabledNotice,
}: RecommendationCardProps) {
  const { showToast } = useToast()
  const [justCopied, setJustCopied] = useState(false)

  async function handleCopy() {
    if (!letter) return
    try {
      await navigator.clipboard.writeText(letter)
      setJustCopied(true)
      showToast('تم نسخ الملخص')
      window.setTimeout(() => setJustCopied(false), 2000)
    } catch {
      showToast('تعذر نسخ الملخص. حاول مرة أخرى.', 'error')
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="bg-surface border-border shadow-soft flex flex-col gap-5 rounded-2xl border p-5"
    >
      <div className="flex items-start gap-3">
        <GovernmentLogo iconKey={analysis.entityIconKey} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-secondary text-xs font-medium">الجهة المختصة</span>
          <h2 className="text-heading text-base leading-snug font-semibold">
            {analysis.entityName}
          </h2>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {analysis.entityDescription}
          </p>
        </div>
      </div>

      <Section title="تصنيف الشكوى">
        <span className="bg-secondary/12 text-secondary inline-flex rounded-full px-2.5 py-1 text-xs font-medium">
          {analysis.category}
        </span>
      </Section>

      <Section title="ملخص البلاغ">
        <p className="text-muted-foreground text-sm leading-relaxed break-words whitespace-pre-line">
          {analysis.summary}
        </p>
      </Section>

      {analysis.requiredDocuments.length > 0 ? (
        <Section title="المستندات المطلوبة">
          <ul className="flex flex-col gap-1.5">
            {analysis.requiredDocuments.map((document) => (
              <li key={document} className="text-muted-foreground flex gap-2 text-sm">
                <span
                  className="bg-secondary mt-1.5 h-1 w-1 shrink-0 rounded-full"
                  aria-hidden="true"
                />
                {document}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {analysis.submissionSteps.length > 0 ? (
        <Section title="خطوات التقديم">
          <ol className="flex flex-col gap-2">
            {analysis.submissionSteps.map((step, index) => (
              <li key={step} className="text-muted-foreground flex gap-2.5 text-sm">
                <span className="bg-primary/8 text-primary flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold">
                  {index + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <div className="border-border flex flex-col gap-2 border-t pt-4">
        <a
          href={analysis.officialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          الانتقال إلى الموقع الرسمي
        </a>

        {saveDisabledNotice ? (
          <p className="text-muted-foreground text-center text-xs">{saveDisabledNotice}</p>
        ) : null}

        <Button
          type="button"
          variant="outline"
          onClick={onSave}
          isLoading={isSaving}
          disabled={isSaved || Boolean(saveDisabledNotice)}
          className="lg:self-center"
        >
          {isSaving ? (
            'جارٍ إنشاء البلاغ...'
          ) : isSaved ? (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              تم حفظ البلاغ
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden="true" />
              إنشاء البلاغ
            </>
          )}
        </Button>

        {letter ? (
          <Button type="button" variant="ghost" onClick={handleCopy} className="w-full">
            {justCopied ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {justCopied ? 'تم نسخ الملخص' : 'نسخ الملخص'}
          </Button>
        ) : null}
      </div>
    </motion.div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground text-xs font-semibold">{title}</p>
      {children}
    </div>
  )
}
