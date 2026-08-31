'use client'

import { Check, Copy, ExternalLink, FileCheck } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { GovernmentLogo } from '@/components/government/government-logo'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { getDisplayTitle } from '@/lib/complaints/display'
import { getGovernmentEntityByName } from '@/lib/mock/government-entities'
import { formatDate } from '@/lib/utils/format'

const REFERENCE_NOTICE = 'رقم مرجعي داخلي في منصة واصل، وليس رقم البلاغ لدى الجهة الحكومية.'
const SUBMISSION_INSTRUCTION =
  'انتقل إلى الموقع الرسمي للجهة المختصة واتبع خطوات تقديم البلاغ المنشورة في المنصة، ثم الصق نص البلاغ الجاهز وأرفق المستندات المطلوبة إن طُلبت.'

// The real, database-backed status vocabulary (supabase/migrations/0001) —
// deliberately not the mock dashboard's 'draft'|'ready'|'submitted'|'completed'.
const STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  generated: 'جاهز للتقديم',
  completed: 'مكتمل',
}

export type ComplaintResult = {
  id: string
  referenceNumber: string
  title: string
  status: string
  submittedAt: string | null
  createdAt: string
  updatedAt: string
  entityName: string
  officialUrl: string
  subject: string
  complaintText: string
}

type ComplaintResultCardProps = {
  complaint: ComplaintResult
  onMarkSubmitted: () => void
  isMarkingSubmitted?: boolean
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground text-xs font-semibold">{title}</p>
      {children}
    </div>
  )
}

/**
 * The real complaint's result view — shown once `createComplaintAction`
 * succeeds. Deliberately a separate component from `RecommendationCard`
 * (which drives the *pre*-creation "ready to create" moment): the data shape
 * is genuinely different (a real reference number, real dates, the actual
 * generated letter) and never mixed with the legacy `ComplaintAnalysis`.
 */
export function ComplaintResultCard({
  complaint,
  onMarkSubmitted,
  isMarkingSubmitted = false,
}: ComplaintResultCardProps) {
  const { showToast } = useToast()
  const [justCopied, setJustCopied] = useState(false)

  const mockEntity = getGovernmentEntityByName(complaint.entityName)
  const displayTitle = getDisplayTitle({
    title: complaint.title,
    complaintSubject: complaint.subject,
  })

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(complaint.complaintText)
      setJustCopied(true)
      showToast('تم نسخ البلاغ')
      window.setTimeout(() => setJustCopied(false), 2000)
    } catch {
      showToast('تعذر نسخ البلاغ. حاول مرة أخرى.', 'error')
    }
  }

  return (
    <div className="bg-surface border-border shadow-soft flex flex-col gap-5 rounded-2xl border p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-base leading-snug font-semibold">{displayTitle}</h2>
        <p className="text-muted-foreground text-xs">المرجع الداخلي: {complaint.referenceNumber}</p>
        <p className="text-muted-foreground text-[11px] leading-relaxed">{REFERENCE_NOTICE}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="bg-secondary/12 text-secondary inline-flex rounded-full px-2.5 py-1 font-medium">
          {STATUS_LABELS[complaint.status] ?? complaint.status}
        </span>
        <span className="text-muted-foreground">أُنشئ: {formatDate(complaint.createdAt)}</span>
        <span className="text-muted-foreground">آخر تحديث: {formatDate(complaint.updatedAt)}</span>
        {complaint.submittedAt ? (
          <span className="text-muted-foreground">
            تم التقديم: {formatDate(complaint.submittedAt)}
          </span>
        ) : null}
      </div>

      <div className="flex items-start gap-3">
        <GovernmentLogo iconKey={mockEntity?.iconKey} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-secondary text-xs font-medium">الجهة المختصة</span>
          <h3 className="text-heading text-sm font-semibold">{complaint.entityName}</h3>
        </div>
      </div>

      <Section title="خطوات التقديم">
        <p className="text-muted-foreground text-sm leading-relaxed">{SUBMISSION_INSTRUCTION}</p>
      </Section>

      <Section title="نص البلاغ الرسمي">
        <p className="text-foreground text-sm font-medium break-words">{complaint.subject}</p>
        <p className="text-muted-foreground text-sm leading-relaxed break-words whitespace-pre-wrap">
          {complaint.complaintText}
        </p>
      </Section>

      <div className="border-border flex flex-col gap-2 border-t pt-4">
        <a
          href={complaint.officialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          الانتقال إلى الموقع الرسمي
        </a>

        <Button type="button" variant="outline" onClick={handleCopy} className="w-full">
          {justCopied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {justCopied ? 'تم نسخ البلاغ' : 'نسخ البلاغ'}
        </Button>

        <Button
          type="button"
          variant="ghost"
          onClick={onMarkSubmitted}
          isLoading={isMarkingSubmitted}
          disabled={Boolean(complaint.submittedAt)}
          className="w-full"
        >
          <FileCheck className="h-4 w-4" aria-hidden="true" />
          {complaint.submittedAt ? 'تم تقديم البلاغ' : 'تحديد كمُقدَّم'}
        </Button>

        <Link
          href="/dashboard/complaints"
          className="text-muted-foreground hover:text-primary text-center text-xs font-medium"
        >
          العودة إلى بلاغاتي
        </Link>
      </div>
    </div>
  )
}
