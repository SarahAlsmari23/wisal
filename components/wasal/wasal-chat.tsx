'use client'

import { AnimatePresence } from 'motion/react'
import { FileSignature, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import {
  createConversationAction,
  saveAssistantMessageAction,
  saveCollectedFieldAction,
  saveUserMessageAction,
  updateConversationTitleAction,
} from '@/app/wasal/actions'
import { createComplaintAction, markComplaintSubmittedAction } from '@/app/wasal/complaint-actions'
import { AuthorityModal } from '@/components/wasal/authority-modal'
import { ChatComposer, type PendingAttachment } from '@/components/wasal/chat-composer'
import { ChatEmptyState, CHAT_GREETING } from '@/components/wasal/chat-empty-state'
import { ASSISTANT_SUGGESTIONS } from '@/components/wasal/suggestion-chips'
import { ChatMessage } from '@/components/wasal/chat-message'
import { ComplaintResultCard, type ComplaintResult } from '@/components/wasal/complaint-result-card'
import { LoginRequiredModal } from '@/components/wasal/login-required-modal'
import { ProgressTimeline } from '@/components/wasal/progress-timeline'
import { RecommendationCard } from '@/components/wasal/recommendation-card'
import { RecommendationSkeleton } from '@/components/wasal/recommendation-skeleton'
import { TypingIndicator } from '@/components/wasal/typing-indicator'
import { buildComplaintAnalysisFromRouting } from '@/lib/complaints/analysis'
import { deriveComplaintTitleFromFields } from '@/lib/complaints/formal-letter'
import { normalizeArabicInput } from '@/lib/ai/arabic-normalize'
import {
  inferFieldAnswerShape,
  isGreetingOnly,
  isIdentityQuestion,
  isLikelySideQuestion,
  isObviousOutOfScope,
  parseBooleanAnswer,
} from '@/lib/ai/intent-guards'
import { getGovernmentEntityByName, type GovernmentEntity } from '@/lib/mock/government-entities'
import { requestAssistantAnswer } from '@/lib/wasal/chat-client'
import { isComplaintContinuationFiller, wantsToCreateComplaint } from '@/lib/wasal/complaint-intent'
import {
  clearConversation,
  loadConversation,
  saveConversation,
} from '@/lib/wasal/conversation-storage'
import { matchEntity } from '@/lib/wasal/entity-matching'
import { detectFieldCorrection } from '@/lib/wasal/field-corrections'
import { sanitizeGenuineMessages } from '@/lib/wasal/message-classification'
import type { MockMessage } from '@/types/conversation'
import type { ComplaintAnalysis, WasalMode } from '@/types/wasal'

const MAX_HISTORY_ITEMS = 10
// Bounded client-side ceiling for createComplaintAction (Phase 6.8, Part 3) —
// the deterministic action itself normally completes in a few seconds; this
// exists purely so a genuinely stuck request (network stall, etc.) can never
// leave the create button spinning forever. The server action itself keeps
// running regardless — a retry after this fires safely recovers the same
// complaint via createComplaintAction's own ComplaintAlreadyExistsError path.
const CREATE_COMPLAINT_TIMEOUT_MS = 25_000

class ActionTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new ActionTimeoutError('Timed out')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type ChatStatus = 'idle' | 'thinking' | 'analyzing'

function createMessage(
  role: MockMessage['role'],
  content: string,
  extra?: Partial<Pick<MockMessage, 'attachment' | 'cta' | 'kind'>>,
): MockMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    kind: role,
    ...extra,
  }
}

// Phase 8, Part 1/16 — a fixed opening prompt only ever appears once, before
// anything at all is known about the complaint (no routing, no fields, no
// hardcoded question script to fall back on afterward). `problem_description`
// is always the first required field for every complaint type, so this
// single, sector-agnostic question is the only thing that can be asked
// deterministically before the real state machine has anything to work with
// — every question after this one is always computed dynamically from
// complaint_types.required_fields (see lib/wasal/conversation-state.ts).
const COMPLAINT_OPENING_MESSAGE =
  'سأساعدك في إعداد بلاغ احترافي جاهز للتقديم.\n\nصف لي المشكلة التي تواجهها بالتفصيل، وسأحدد الجهة المختصة وأكمل معك بقية التفاصيل.'

/** The first complaint-builder prompt, appended to the ongoing conversation. */
function buildComplaintOpeningMessage(): MockMessage {
  return createMessage('assistant', COMPLAINT_OPENING_MESSAGE, {
    kind: 'complaint_opening',
  })
}

// Phase 7.5, Part 4 — two of the four suggested-question starters are meta-
// questions about how واصل itself works, not government-service questions,
// so they get a fixed, deterministic answer shown instantly, client-side,
// with no AI/backend call at all (no prompt, no route, no RAG involved).
// The other two starters ("لدي مشكلة مع شركة اتصالات", "أريد تقديم شكوى ضد
// متجر") are genuine grievances — they get no special casing here and flow
// through the exact same pipeline as manually typed text (Part 3), which
// already starts the complaint builder for them via `wantsToCreateComplaint`
// (for the commerce one) or the general assistant/RAG pipeline (for the
// telecom one), identically to typing them by hand.
const FIXED_STARTER_ANSWERS: Record<string, string> = {
  [normalizeArabicInput('كيف أعرف الجهة المختصة؟')]:
    'إذا لم تكن تعرف الجهة المختصة، فقط صف المشكلة بلغتك الطبيعية، وسيقوم واصل بتحليلها وتحديد الجهة الحكومية المناسبة، ثم يوضح لك سبب الاختيار وخطوات التقديم.',
  [normalizeArabicInput('لدي مشكلة في خدمة حكومية')]:
    'أخبرني بتفاصيل المشكلة أو اسم الجهة أو الخدمة، وسأساعدك في تحديد الجهة المختصة أو تجهيز الشكوى إذا لزم الأمر.',
}

function getFixedStarterAnswer(content: string): string | null {
  return FIXED_STARTER_ANSWERS[normalizeArabicInput(content)] ?? null
}

// Emergency Fix #2, Parts 1/3/4 — the two starters that lock a sector
// ("لدي مشكلة مع شركة اتصالات", "أريد تقديم شكوى ضد متجر") are generic
// trigger text, never a real description of the issue. Two independent
// places previously re-derived "the real problem_description" from this
// same generic text and disagreed about it: `deriveComplaintResumeState`
// (only guarded for the telecom starter, via `isGenericStarterTrigger`
// below) seeded it as the initial value, while `runComplaintTurn`'s own
// per-turn answer-merge logic (unconditional, unaware of where `content`
// came from) re-derived and persisted the exact same generic text as
// `problem_description` regardless — for BOTH starters, since that merge
// never checked for this case at all. Once poisoned with non-descriptive
// text, the next turn's real answer was rejected by the stale-pending-field
// guard (the real answer differs from the "already known" generic text) and
// the assistant looped on the same subtype-clarification question forever.
// Root-caused via a live trace of the exact reported production failure
// (commerce starter → "تأخر في تسليم الطلب..." → repeated question); fixed
// by using this single shared set at both call sites instead of one
// starter-specific special case in only one of them.
const GENERIC_SECTOR_STARTER_MESSAGES = new Set([
  ASSISTANT_SUGGESTIONS[0],
  ASSISTANT_SUGGESTIONS[1],
])

/**
 * The single shared rule for continuing a complaint session from whatever
 * genuine information already exists — used identically whether that's a
 * guest resuming after sign-in (sessionStorage) or an already-authenticated
 * user switching straight from general-assistant chat into complaint mode
 * (Phase 6.10, Parts 2/3/5: never re-ask an already-answered field, never
 * show the fixed opening question when a real answer is already known).
 * Always merges onto `restoredFields` (never drops one); `problem_description`
 * is derived only from the single most recent genuine user message, and only
 * when it isn't already known — never inferred from anything earlier, and
 * never overwriting an already-known value.
 */
// Phase 8, Part 13 — the same assistant message must never appear twice in
// direct succession. This is never a second model call (a "regenerate" in
// the literal sense would just as likely produce the exact same deterministic
// question again, and burns another AI-provider round trip for no reason) —
// instead, a genuinely identical candidate is deterministically varied with a
// short, honest clarifying prefix. Only ever compares against the single
// most recent ASSISTANT bubble (never a user message, never further back).
function avoidConsecutiveDuplicate(candidate: string, previousMessages: MockMessage[]): string {
  const lastAssistant = [...previousMessages]
    .reverse()
    .find((message) => message.role === 'assistant')
  if (lastAssistant?.content !== candidate) return candidate
  return `لم أستلم إجابة واضحة على سؤالي السابق. ${candidate}`
}

function deriveComplaintResumeState(
  genuineMessages: MockMessage[],
  restoredFields: Record<string, string>,
): { collectedFields: Record<string, string>; resumeTriggerContent: string | null } {
  const hasProblemDescription = Boolean(restoredFields.problem_description?.trim())
  if (hasProblemDescription) {
    return {
      collectedFields: restoredFields,
      resumeTriggerContent: restoredFields.problem_description,
    }
  }

  const lastUserMessage = [...genuineMessages].reverse().find((message) => message.role === 'user')
  if (lastUserMessage) {
    return {
      collectedFields: { ...restoredFields, problem_description: lastUserMessage.content },
      resumeTriggerContent: lastUserMessage.content,
    }
  }

  return { collectedFields: restoredFields, resumeTriggerContent: null }
}

type InitialConversation = {
  id: string
  mode: WasalMode
  messages: MockMessage[]
}

type WasalChatProps = {
  isAuthenticated: boolean
  /** `?mode=complaint` resumes the builder after sign-in, or opens it directly. */
  initialMode?: WasalMode
  /** A real, already-owned DB conversation to resume directly
   * (`/wasal?conversationId=`) — mutually exclusive with `initialMode` and
   * the sessionStorage restore below; handled in its own branch of the mount
   * effect. */
  initialConversation?: InitialConversation
  /** The resumed conversation's already-generated complaint, if any — seeded
   * straight into `complaintResult` so ComplaintResultCard shows immediately
   * without re-deriving or re-creating anything. */
  initialComplaintResult?: ComplaintResult | null
  /** Previously answered complaint fields for a resumed, not-yet-generated
   * complaint conversation (from collected_information) — seeded into
   * `collectedFields` so the server never re-asks an already-answered field. */
  initialCollectedFields?: Record<string, string>
  /** Which required field the next answer should be attributed to, derived
   * server-side from `initialCollectedFields` via the same computeMissingFields
   * the live API route uses — undefined when it can't be safely derived
   * (e.g. no saved routing yet), in which case the default seed is kept. */
  initialPendingFieldKey?: string
  /** A deterministically reconstructed "ready" ComplaintAnalysis, when a
   * resumed complaint conversation's restored collected_information already
   * satisfies every required field (Phase 6.6, Part 1) — built server-side
   * by the exact same function the live turn handler uses
   * (lib/complaints/analysis.ts), never by calling the model. */
  initialAnalysis?: ComplaintAnalysis | null
  /** Whether `initialAnalysis`'s routing (or, more generally, any valid saved
   * routing found on resume) is already confirmed persisted on the DB
   * conversation — seeds `isRoutingPersisted` so the create button doesn't
   * need a live round trip just to re-confirm what the server already knows. */
  initialRoutingPersisted?: boolean
  /** Emergency release fix, Part 7/8 — true only when every required field
   * was already satisfied on resume (previously the same condition that
   * gated `initialAnalysis` itself; now separate, since the card can appear
   * on resume even when routing is valid but collection isn't finished). */
  initialIsComplaintReady?: boolean
}

export function WasalChat({
  isAuthenticated,
  initialMode,
  initialConversation,
  initialComplaintResult,
  initialCollectedFields,
  initialPendingFieldKey,
  initialAnalysis,
  initialRoutingPersisted,
  initialIsComplaintReady,
}: WasalChatProps) {
  const router = useRouter()
  const { showToast } = useToast()

  // 'assistant' is the default and only entry point — there is no mode picker.
  // 'complaint' is entered later, from the conversation itself.
  const [mode, setMode] = useState<WasalMode>('assistant')
  const [messages, setMessages] = useState<MockMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null)
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [failedMessage, setFailedMessage] = useState<string | null>(null)

  const [analysis, setAnalysis] = useState<ComplaintAnalysis | null>(null)
  /** Emergency release fix, Part 7/8 — the TRUE completion signal
   * (`readyToGenerateComplaint`), kept separate from `analysis` itself.
   * `analysis` now populates as soon as routing resolves (so the authority
   * card can appear well before every field is collected — Part 7), so it
   * can no longer be what gates the composer lock or the save button; both
   * now check this instead. */
  const [isComplaintReady, setIsComplaintReady] = useState(false)

  /** The real, API-driven complaint flow's collected answers, keyed by
   * complaint_types.required_fields' real field keys (e.g. `merchant_name`).
   * Persisted to sessionStorage so a reload mid-complaint doesn't lose
   * progress or re-ask an answered field. */
  const [collectedFields, setCollectedFields] = useState<Record<string, string>>({})

  /** True only while a guest's complaint request is gated on sign-in — reset
   * back to false as soon as the builder actually starts. Deliberately not
   * derived from `mode`, so a merely-stale complaint session in
   * sessionStorage can never be mistaken for a genuine post-sign-in resume. */
  const [awaitingSignIn, setAwaitingSignIn] = useState(false)

  /** The real, database-backed complaint record — set only once
   * `createComplaintAction` succeeds. Deliberately a separate piece of state
   * from the legacy `analysis` (`ComplaintAnalysis`) above; the two are never
   * merged or read from each other. Not persisted to sessionStorage — a
   * refresh after creating a complaint loses this result view, though the
   * real row remains safely in the database (see the Phase 6.4 report). */
  const [complaintResult, setComplaintResult] = useState<ComplaintResult | null>(null)
  const [isCreatingComplaint, setIsCreatingComplaint] = useState(false)
  const [createComplaintError, setCreateComplaintError] = useState<string | null>(null)
  const [isMarkingSubmitted, setIsMarkingSubmitted] = useState(false)

  /** Server-authoritative: true only once the current `analysis`'s routing is
   * confirmed persisted on the owned DB conversation (Phase 6.6F) — gates
   * the create button honestly, independent of whether `analysis` itself is
   * set. Never a proxy for "looks trustworthy in memory". */
  const [isRoutingPersisted, setIsRoutingPersisted] = useState(false)

  const [authorityEntity, setAuthorityEntity] = useState<GovernmentEntity | null>(null)
  const [authorityReason, setAuthorityReason] = useState<string | undefined>(undefined)
  const [isAuthorityModalOpen, setIsAuthorityModalOpen] = useState(false)
  const [announcedEntities, setAnnouncedEntities] = useState<string[]>([])

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [hasRestored, setHasRestored] = useState(false)

  const conversationIdRef = useRef(crypto.randomUUID())
  /** Real DB conversation id (authenticated users, general-assistant turns
   * only) — separate from `conversationIdRef`, which only ever drives the
   * guest-facing sessionStorage round-trip and is never sent to the DB. */
  const dbConversationIdRef = useRef<string | null>(null)
  /** Real DB conversation id for the complaint-builder flow — a separate
   * conversation row from any prior general-assistant chat, even when the UI
   * continues the same visible thread. */
  const dbComplaintConversationIdRef = useRef<string | null>(null)
  /** The complaint builder's opening question text — set once when the
   * builder starts, read once by `runComplaintTurn` on its first invocation
   * to save it as the opening assistant message at the same moment the DB
   * conversation itself is first created (never eagerly, so no DB
   * conversation row exists until the user actually sends something). */
  const openingMessageRef = useRef<string>('')
  /** Which required-field key the user's *next* answer should be recorded
   * under — the server tells us this via `nextFieldKey` each turn; seeded to
   * `problem_description` for the very first answer in a fresh session. */
  const pendingFieldKeyRef = useRef<string>('problem_description')
  /** Phase 7.4B, Part 2/3 — the plain pending-question text for
   * `pendingFieldKeyRef`'s field, without any interruption reply mixed in.
   * Updated only when the server actually supplies a fresh, undecorated
   * `nextQuestion` (never on an identity/greeting/out-of-scope/side-question
   * interruption turn, which intentionally sends `nextQuestion: null` since
   * its own composed `answer` already carries both the reply and the
   * resumed question) — so a continuation filler ("كمل") re-shows the bare
   * question itself, never a stale identity blurb still sitting in the last
   * chat bubble. */
  const pendingQuestionTextRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  const scrollAnchorRef = useRef<HTMLDivElement>(null)
  /** Mirrors `announcedEntities` for synchronous reads during a turn. */
  const announcedEntitiesRef = useRef<string[]>([])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, status, analysis])

  /** Guards the mount effect below against React StrictMode's deliberate
   * double-invocation in development — without this, the guest-resume
   * branch (and its toast/API side effects) would run twice on every mount
   * (Phase 6.9, Part 6). */
  const hasMountEffectRunRef = useRef(false)
  /** Set once, right after a resume (or an in-place complaint start that
   * already has a genuine answer — Phase 6.10) derives a message to send
   * through the real complaint flow automatically — consumed by the effect
   * below, never read directly. */
  const [pendingResumeTrigger, setPendingResumeTrigger] = useState<string | null>(null)
  const resumeTriggerConsumedRef = useRef(false)

  /**
   * Starts (or resumes into) the complaint builder on top of `existing`
   * messages. `resumeFields` carries over whatever is already genuinely known
   * (guest resuming after sign-in, or an authenticated user switching
   * straight from general-assistant chat — Phase 6.10) — a brand-new session
   * simply gets no fields. When `resumeTriggerContent` is provided, the fixed
   * opening question is skipped entirely (it would just re-ask something
   * already answered) and the real complaint flow is triggered once, on the
   * next render, to compute the actual next missing field from the server —
   * never a blind restart. `analysis`/`isRoutingPersisted` are always reset
   * regardless: any mock/legacy analysis from a prior session is discarded
   * here, and real routing is always re-established fresh through the real
   * API flow after this point, never trusted from a stale session.
   */
  const startComplaintBuilder = useCallback(
    (
      existing: MockMessage[],
      resumeFields?: Record<string, string>,
      resumeTriggerContent?: string | null,
    ) => {
      // The builder continues the same thread rather than replacing it, so the
      // user keeps everything they already told Wasal in view.
      setMode('complaint')
      setCollectedFields(resumeFields ?? {})
      pendingFieldKeyRef.current = 'problem_description'
      pendingQuestionTextRef.current = ''
      setAnalysis(null)
      setIsComplaintReady(false)
      setIsRoutingPersisted(false)
      setAwaitingSignIn(false)
      setComplaintResult(null)
      setIsCreatingComplaint(false)
      setCreateComplaintError(null)
      announcedEntitiesRef.current = []
      setAnnouncedEntities([])

      // Each invocation is a fresh complaint-builder attempt, so it always
      // gets its own new DB conversation — created lazily, on the first real
      // user message (see runComplaintTurn), never here. This holds for a
      // guest resume too: the real DB conversation is created only once the
      // now-authenticated user actually sends their first complaint-builder
      // message, never eagerly.
      dbComplaintConversationIdRef.current = null

      if (resumeTriggerContent) {
        setMessages(existing)
        // Re-arm the consumption guard for this new trigger — it's only
        // meant to collapse React StrictMode's double-invocation of a single
        // trigger, never to block a later, genuinely new one (this function
        // can run more than once per component lifetime: guest resume, then
        // later switching from general-assistant chat into complaint mode).
        resumeTriggerConsumedRef.current = false
        setPendingResumeTrigger(resumeTriggerContent)
      } else {
        const openingMessage = buildComplaintOpeningMessage()
        setMessages([...existing, openingMessage])
        openingMessageRef.current = openingMessage.content
        // Deliberately left empty rather than seeded with the opening
        // message (Phase 7.4B correction): if a turn's real generation call
        // fails, it falls back to the legacy engine and returns before ever
        // reaching the ref-update line below — seeding this upfront meant a
        // continuation filler sent after one or more such failures replayed
        // the STALE opening message forever, since a non-empty ref always
        // wins over the `messages`-array fallback in the continuation
        // handler. Leaving it empty lets that fallback (which reflects
        // whatever was actually last displayed, including a legacy-engine
        // reply) take over correctly until a genuine real turn populates it.
      }
    },
    [],
  )

  /**
   * Restores the conversation on mount and, when the user has just come back
   * from signing in, continues straight into the complaint builder.
   */
  useEffect(() => {
    if (hasMountEffectRunRef.current) return
    hasMountEffectRunRef.current = true

    if (initialConversation) {
      // Resuming a real, already-owned DB conversation
      // (`/wasal?conversationId=`) — never sessionStorage, never a fresh
      // builder session. All three refs point at the same real conversation
      // id, so runComplaintTurn's "create on first message" guard is skipped
      // and no duplicate conversation is ever created.
      conversationIdRef.current = initialConversation.id
      dbConversationIdRef.current = initialConversation.id
      if (initialConversation.mode === 'complaint') {
        dbComplaintConversationIdRef.current = initialConversation.id
      }
      setMode(initialConversation.mode)
      setMessages(initialConversation.messages)

      if (initialComplaintResult) {
        setComplaintResult(initialComplaintResult)
      } else {
        // collectedFields is seeded whenever present, regardless of whether
        // the conversation turns out fully ready — handleCreateComplaint
        // needs the real collected values, not an empty object, whichever
        // state below applies.
        if (initialCollectedFields && Object.keys(initialCollectedFields).length > 0) {
          setCollectedFields(initialCollectedFields)
        }

        // Emergency release fix, Part 7/8 — `analysis` (the authority card)
        // and `isComplaintReady` (whether collection is actually finished)
        // are independent now: the card can be present on resume even while
        // a pending field remains, so both are restored together instead of
        // treating "has analysis" and "has a pending field" as mutually
        // exclusive.
        if (initialAnalysis) {
          setAnalysis(initialAnalysis)
        }
        if (initialPendingFieldKey) {
          pendingFieldKeyRef.current = initialPendingFieldKey
        }
        setIsComplaintReady(Boolean(initialIsComplaintReady))

        if (initialRoutingPersisted) {
          setIsRoutingPersisted(true)
        }
      }

      setHasRestored(true)
      return
    }

    const stored = loadConversation()
    const wantsComplaint = initialMode === 'complaint'

    if (wantsComplaint && stored?.pendingComplaint) {
      // Genuine resume: a guest asked to create a complaint mid-conversation,
      // was gated into sign-in, and has just been redirected back — continue
      // the exact thread that led to this request (see requestComplaintCreation).
      // Never blindly calls startComplaintBuilder here (Phase 6.9, Part 3):
      // that function is for *starting* a brand-new builder session, and its
      // fixed "ما هي الجهة أو الخدمة؟" opening question would just re-ask
      // something the guest's own prior messages already answered.
      conversationIdRef.current = stored.conversationId
      const genuineMessages = sanitizeGenuineMessages(stored.messages)
      announcedEntitiesRef.current = stored.announcedEntities ?? []
      setAnnouncedEntities(announcedEntitiesRef.current)
      dbConversationIdRef.current = stored.dbConversationId ?? null
      // dbComplaintConversationId deliberately never restored — the real DB
      // complaint conversation is always created lazily, on the first
      // authenticated complaint turn below, never eagerly.
      dbComplaintConversationIdRef.current = null

      if (isAuthenticated) {
        // Single shared rule (Phase 6.10): merges onto every restored field,
        // derives problem_description only when genuinely absent, and never
        // shows the fixed opening question when a real answer already
        // exists — startComplaintBuilder runs the real /api/ai/chat flow
        // once instead, re-establishing routing/missing-fields from the
        // server and asking only the next genuinely missing field (or the
        // ready state directly). Never replays the rest of the thread as
        // additional turns.
        const restoredFields = stored.collectedFields ?? {}
        const { collectedFields: resumedFields, resumeTriggerContent } = deriveComplaintResumeState(
          genuineMessages,
          restoredFields,
        )
        startComplaintBuilder(genuineMessages, resumedFields, resumeTriggerContent)

        showToast('تم تسجيل الدخول — لنكمل إعداد بلاغك.', 'success')
      } else {
        setMessages(genuineMessages)
        setIsLoginModalOpen(true)
      }
      router.replace('/wasal', { scroll: false })
      setHasRestored(true)
      return
    }

    if (wantsComplaint) {
      // A fresh arrival at ?mode=complaint (Dashboard "بلاغ جديد"/"ابدأ بلاغاً
      // جديداً", or a shared link) — any sessionStorage here is unrelated
      // leftover from a different session and must never bleed into this
      // new complaint.
      clearConversation()
      conversationIdRef.current = crypto.randomUUID()
      if (isAuthenticated) {
        startComplaintBuilder([])
      } else {
        setIsLoginModalOpen(true)
      }
      router.replace('/wasal', { scroll: false })
      setHasRestored(true)
      return
    }

    if (stored) {
      conversationIdRef.current = stored.conversationId
      setMessages(stored.messages)
      setAnalysis(stored.analysis ?? null)
      setCollectedFields(stored.collectedFields ?? {})
      pendingFieldKeyRef.current = stored.pendingFieldKey ?? 'problem_description'
      announcedEntitiesRef.current = stored.announcedEntities ?? []
      setAnnouncedEntities(announcedEntitiesRef.current)
      dbConversationIdRef.current = stored.dbConversationId ?? null
      dbComplaintConversationIdRef.current = stored.dbComplaintConversationId ?? null
      setMode(stored.mode ?? 'assistant')
    } else {
      // Phase 7.5, Part 1/7 — a genuinely brand-new visit: no real DB
      // conversation to resume, no sessionStorage, no ?mode=complaint route.
      // Chat history starts completely empty — no automatic assistant
      // message, no DB conversation created. The centered landing screen
      // (ChatEmptyState) is what renders while `messages` is empty; the
      // assistant only ever speaks after the user's first real message.
      setMessages([])
    }

    setHasRestored(true)
    // Runs once, for whatever state the page was loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Fires the guest-resume flow's single automatic complaint turn (Phase
   * 6.9, Part 3) — split into its own effect, rather than called directly
   * from the mount effect above, so it runs on the render *after*
   * `collectedFields`/`mode`/etc. have actually committed; calling
   * `runComplaintTurn` synchronously inside the mount effect would still
   * close over the pre-restore state. `resumeTriggerConsumedRef` guards
   * against StrictMode's double-invocation the same way the mount effect's
   * own ref does — without it, this would fire the real API call (and the
   * lazy DB conversation creation) twice.
   */
  useEffect(() => {
    if (!pendingResumeTrigger) return
    if (resumeTriggerConsumedRef.current) return
    resumeTriggerConsumedRef.current = true

    const content = pendingResumeTrigger
    setPendingResumeTrigger(null)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    void runComplaintTurn(content, controller)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResumeTrigger])

  // Mirror the conversation into sessionStorage so signing in never loses it.
  useEffect(() => {
    if (!hasRestored) return
    if (messages.length === 0) return

    saveConversation({
      conversationId: conversationIdRef.current,
      messages,
      mode,
      analysis,
      collectedFields,
      pendingFieldKey: pendingFieldKeyRef.current,
      announcedEntities,
      // Only ever true during the narrow guest-gated-on-sign-in window (see
      // requestComplaintCreation) — never a proxy for "currently in complaint
      // mode" (that's `mode`, above).
      pendingComplaint: awaitingSignIn,
      dbConversationId: dbConversationIdRef.current ?? undefined,
      dbComplaintConversationId: dbComplaintConversationIdRef.current ?? undefined,
    })
  }, [hasRestored, messages, mode, analysis, collectedFields, announcedEntities, awaitingSignIn])

  /**
   * Offers the complaint flow, gating on auth only at this point.
   *
   * Phase 7.7, Part 5 — `triggerMessage`, when provided, is the user message
   * that just triggered this call (e.g. a `wantsToCreateComplaint` match in
   * `handleSend`, such as the commerce starter "أريد تقديم شكوى ضد متجر").
   * `messages` (React state) does not yet reflect that message at this point
   * in the same tick — `setMessages` was only just queued, not committed —
   * so reading `messages` alone here silently dropped the user's own
   * just-sent text and fell back to the fully generic opening question
   * ("ما هي الجهة أو الخدمة...") even when the message itself already named
   * the sector. Appending `triggerMessage` explicitly closes that gap without
   * ever duplicating the bubble (it's the exact same message object already
   * queued into `messages`).
   */
  const requestComplaintCreation = useCallback(
    (triggerMessage?: MockMessage) => {
      setIsAuthorityModalOpen(false)

      const currentMessages = triggerMessage ? [...messages, triggerMessage] : messages

      if (!isAuthenticated) {
        setAwaitingSignIn(true)
        // Persist immediately: the sign-in navigation unmounts this component.
        // `pendingComplaint` is written as a literal `true` here rather than
        // read back from `awaitingSignIn` — setState above is async, so the
        // state variable itself wouldn't have updated yet on this same tick.
        saveConversation({
          conversationId: conversationIdRef.current,
          messages: currentMessages,
          mode,
          analysis,
          collectedFields,
          pendingFieldKey: pendingFieldKeyRef.current,
          announcedEntities,
          pendingComplaint: true,
          dbConversationId: dbConversationIdRef.current ?? undefined,
          dbComplaintConversationId: dbComplaintConversationIdRef.current ?? undefined,
        })
        setIsLoginModalOpen(true)
        return
      }

      // Same shared rule as the guest-resume path (Phase 6.10): if the user
      // already described their problem earlier in this same thread (general-
      // assistant chat, or an already-in-progress complaint session), never
      // show the fixed opening question again — continue straight from the
      // real next missing field instead.
      //
      // Emergency Fix #2, Parts 1/3/4 — either sector-locking starter is the
      // exception: neither must be seeded as `problem_description`
      // (deriveComplaintResumeState would otherwise treat this generic text
      // as the real, specific description, letting the server skip straight
      // past the subtype-clarification question — or, worse, poison the
      // field so the user's real follow-up answer looks like a change to an
      // already-known value and gets silently discarded). It still becomes
      // this turn's real message — routing still resolves from it — just
      // not an accepted answer to any field yet. Previously only the telecom
      // starter (`ASSISTANT_SUGGESTIONS[0]`) got this protection; the
      // commerce starter fell through to the generic path and self-seeded,
      // which was the confirmed root cause of the reported subtype loop.
      const genuineMessages = sanitizeGenuineMessages(currentMessages)
      const isGenericStarterTrigger = Boolean(
        triggerMessage && GENERIC_SECTOR_STARTER_MESSAGES.has(triggerMessage.content),
      )
      const { collectedFields: resumedFields, resumeTriggerContent } = isGenericStarterTrigger
        ? { collectedFields, resumeTriggerContent: triggerMessage!.content }
        : deriveComplaintResumeState(genuineMessages, collectedFields)
      startComplaintBuilder(genuineMessages, resumedFields, resumeTriggerContent)
    },
    [
      isAuthenticated,
      messages,
      mode,
      analysis,
      collectedFields,
      announcedEntities,
      startComplaintBuilder,
    ],
  )

  /**
   * Surfaces the authority modal the first time a given entity is identified.
   * Re-identifying the same entity later does not interrupt the user again.
   */
  const announceEntity = useCallback((entityName: string | undefined, reason?: string) => {
    if (!entityName) return
    const entity = getGovernmentEntityByName(entityName)
    if (!entity) return
    // Read through a ref rather than inside a state updater: updaters must stay
    // pure, and React may invoke them twice in development.
    if (announcedEntitiesRef.current.includes(entity.id)) return

    announcedEntitiesRef.current = [...announcedEntitiesRef.current, entity.id]
    setAnnouncedEntities(announcedEntitiesRef.current)
    setAuthorityEntity(entity)
    setAuthorityReason(reason)
    setIsAuthorityModalOpen(true)
  }, [])

  /**
   * Best-effort persistence for one authenticated, general-assistant turn:
   * creates the DB conversation on first send, then saves the user message.
   * Never throws — a failure here must never affect the chat UI.
   */
  async function persistUserTurn(content: string): Promise<void> {
    try {
      if (!dbConversationIdRef.current) {
        dbConversationIdRef.current = await createConversationAction(content)
      }
      if (dbConversationIdRef.current) {
        await saveUserMessageAction(dbConversationIdRef.current, content)
      }
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  /**
   * Phase 7.5, Part 4 — instantly shows one of the two fixed starter answers
   * (see `FIXED_STARTER_ANSWERS`) with no AI/backend call at all. Persistence
   * still follows the exact same real pattern as a genuine turn (creates the
   * DB conversation on first send, saves both messages) — only the answer's
   * origin differs; nothing about how it's stored is special-cased.
   */
  async function runFixedAnswerTurn(content: string, answer: string) {
    const persistPromise = isAuthenticated ? persistUserTurn(content) : undefined
    setMessages((previous) => [...previous, createMessage('assistant', answer)])
    if (persistPromise) {
      void persistPromise
        .then(() => {
          if (dbConversationIdRef.current) {
            return saveAssistantMessageAction(dbConversationIdRef.current, answer)
          }
        })
        .catch(() => {})
    }
  }

  async function runAssistantTurn(
    content: string,
    controller: AbortController,
    persistUserTurnPromise?: Promise<void>,
  ) {
    setStatus('thinking')
    const history = messages.slice(-MAX_HISTORY_ITEMS).map((message) => ({
      role: message.role,
      content: message.content,
    }))

    try {
      const result = await requestAssistantAnswer({
        conversationId: conversationIdRef.current,
        message: content,
        history,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      // Phase 8, Part 13 — never let the exact same reply appear twice in a
      // row (see avoidConsecutiveDuplicate's own doc comment).
      const displayAnswer = avoidConsecutiveDuplicate(result.answer, messages)
      setMessages((previous) => [...previous, createMessage('assistant', displayAnswer)])

      // Phase 7.7, Part 6 — every reply actually shown to the user is
      // persisted, whether it came from the real AI provider or the local
      // mocked fallback (`result.isMocked`). Previously the mocked fallback's
      // text was deliberately never saved, on the reasoning that it wasn't a
      // "genuine AI answer" — but that left a silent gap in conversation
      // history: the user's own next message would still be saved, so a
      // later resume showed a question with no visible reply in between.
      // From the conversation-history point of view, this text genuinely was
      // the assistant's turn; omitting it, not the fact that it came from a
      // fallback, was the actual bug.
      if (persistUserTurnPromise) {
        void persistUserTurnPromise
          .then(() => {
            if (dbConversationIdRef.current) {
              return saveAssistantMessageAction(dbConversationIdRef.current, displayAnswer)
            }
          })
          .catch(() => {})
      }

      // Phase 7.1, Part 9: the authority modal is a complaint-flow affordance
      // only — it must never interrupt a purely informational answer (e.g.
      // "كيف أتواصل مع هيئة الاتصالات؟") just because that entity happens to
      // be mentioned or matched. Only offered when the server itself
      // classified this turn as a genuine complaint/grievance — or, same as
      // before this phase, for the degraded local-fallback path (isMocked),
      // which never carries a server-classified intent at all.
      if (result.isMocked || result.intent === 'complaint_guidance') {
        // Prefer the entity the assistant itself identified. When the
        // response carries none, fall back to the existing keyword matcher
        // rather than adding any new inference — same helper the mocked
        // engine already uses.
        const entityName = result.suggestedEntityName ?? matchEntity(content)?.entity.name
        announceEntity(entityName, result.suggestedEntityReason)
      }

      // Emergency release fix, Part 7/9 — a grievance described in general
      // chat (e.g. the telecom starter, which never itself switches into
      // `mode === 'complaint'`) still resolves real routing server-side; the
      // authority card must reflect that as soon as it's valid, exactly like
      // the complaint-builder path does, rather than never appearing until
      // the user separately triggers the structured builder.
      if (result.routing && result.routing.confidence !== 'low' && result.routing.entityId) {
        setAnalysis(buildComplaintAnalysisFromRouting(result.routing, collectedFields))
        setIsRoutingPersisted(Boolean(result.routingPersisted))
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setFailedMessage(content)
    } finally {
      if (abortRef.current === controller) {
        setStatus('idle')
        abortRef.current = null
      }
    }
  }

  // Phase 8, Part 1/4/16 — the hardcoded, fixed-order legacy complaint
  // engine (a separate 5-question script, unrelated to any real complaint
  // type's actual required_fields) has been removed entirely. It existed
  // only as a fallback for when the AI provider call failed — but
  // app/api/ai/chat/route.ts now degrades a generation failure to the
  // deterministic, already-server-computed next question (or completion
  // message) itself, for any turn where routing/missing-fields already
  // resolved (which is true for essentially every complaint turn, whether
  // via RAG or the deterministic entity-keyword fallback — see
  // lib/ai/entity-detection.ts). That leaves only a genuine network failure
  // (never reaching the server at all) as a residual case, handled by
  // showing a short retry notice below instead of jumping into a whole
  // second, disconnected question flow.
  const RETRY_NOTICE = 'تعذر معالجة طلبك حالياً. حاول مرة أخرى بعد قليل.'

  /**
   * Live complaint-flow orchestrator — calls the real /api/ai/chat pipeline
   * (routing from Phase 4B, missing-fields from Phase 4C).
   */
  async function runComplaintTurn(content: string, controller: AbortController) {
    let conversationId = isAuthenticated ? dbComplaintConversationIdRef.current : null

    // No DB conversation exists yet for this complaint session — create it
    // now, on the first real user message, rather than eagerly when the
    // builder opens. Best-effort, same as every other DB write in this flow.
    if (isAuthenticated && !conversationId) {
      try {
        conversationId = await createConversationAction('إعداد بلاغ جديد', 'complaint')
        dbComplaintConversationIdRef.current = conversationId
        if (conversationId && openingMessageRef.current) {
          await saveAssistantMessageAction(conversationId, openingMessageRef.current)
        }
      } catch {
        conversationId = null
        dbComplaintConversationIdRef.current = null
      }
    }

    // Once a complaint has already been generated for this conversation,
    // collected_information is historical data that already fed it — never
    // touched again, so a stray follow-up message can never overwrite an
    // already-collected field (Phase 6.6, Part 7).
    const complaintAlreadyGenerated = complaintResult !== null

    // Part 3 (Phase 6.10B): an explicit, deterministic correction to an
    // already-known field always takes priority over normal answer
    // attribution — the user is intentionally fixing something, not
    // answering whatever question was pending. No AI call; see
    // lib/wasal/field-corrections.ts for the narrow, Arabic-focused rules.
    const correction = complaintAlreadyGenerated
      ? null
      : detectFieldCorrection(content, collectedFields)

    // Phase 7.2, Part 5/7 — before ever assuming this message answers the
    // pending field, check whether it's actually an interruption: an
    // identity question, an obvious off-topic aside, or a relevant side
    // question. Priority: identity's exact-fixed-text requirement is
    // absolute so it's checked first; the out-of-scope blocklist is next;
    // the broad side-question net (any question shape) is the catch-all —
    // same shared, deterministic functions the server independently
    // re-checks against the real pending field (lib/ai/intent-guards.ts;
    // never a second, divergent implementation).
    const pendingKey = pendingFieldKeyRef.current
    const isGreetingInterruption =
      !complaintAlreadyGenerated && !correction && isGreetingOnly(content)
    const isIdentityInterruption =
      !complaintAlreadyGenerated &&
      !correction &&
      !isGreetingInterruption &&
      isIdentityQuestion(content)
    const isOutOfScopeInterruption =
      !complaintAlreadyGenerated &&
      !correction &&
      !isGreetingInterruption &&
      !isIdentityInterruption &&
      isObviousOutOfScope(content)
    const isSideQuestionInterruption =
      !complaintAlreadyGenerated &&
      !correction &&
      !isGreetingInterruption &&
      !isIdentityInterruption &&
      !isOutOfScopeInterruption &&
      isLikelySideQuestion(content, pendingKey)
    const isInterruption =
      isGreetingInterruption ||
      isIdentityInterruption ||
      isOutOfScopeInterruption ||
      isSideQuestionInterruption

    // Part 2 (Phase 6.10B): stale pending-field protection. The field the
    // previous turn was asking about can be stale right after a resume or an
    // in-place complaint start (Phase 6.10) — if it already has a known
    // value AND this message's content actually differs from it, never let
    // this new, unrelated message overwrite it. The `content === known value`
    // exception matters: the resume flow (Phase 6.9/6.10) deliberately
    // resubmits the exact already-known problem_description as a harmless
    // reaffirmation, precisely so it gets persisted to a freshly-created DB
    // conversation that starts with no collected_information rows at all —
    // treating that as "stale" would silently drop it. The message still
    // reaches the server as plain conversational content below either way,
    // so the server's own missing-field computation (now also merging
    // collected_information — Part 5) recovers the real next question.
    const pendingFieldStale =
      !complaintAlreadyGenerated &&
      !correction &&
      !isInterruption &&
      Boolean(collectedFields[pendingKey]?.trim()) &&
      content !== collectedFields[pendingKey]

    // Phase 7.4, Part 2: a whole-message "just continue" filler ("كمل", "تم",
    // "اوكي", …) carries no new information at all — it must never be merged
    // as the pending field's answer (that would silently corrupt the field
    // with the literal filler word and permanently block the real question).
    // Checked after every other classification above so a genuine
    // correction/interruption is never mistaken for a filler.
    const isContinuationFiller =
      !complaintAlreadyGenerated &&
      !correction &&
      !isInterruption &&
      isComplaintContinuationFiller(content)

    // Emergency Fix #2, Parts 1/3/4 — this exact turn's message is one of the
    // fixed sector-locking starter phrases, still targeting `problem_description`
    // (i.e. this is the very first, auto-submitted turn of a freshly-started
    // complaint session, not a later message that merely happens to repeat the
    // same words). Guarding the initial seed alone (see
    // `GENERIC_SECTOR_STARTER_MESSAGES` above) is not enough: without this
    // check, this function's own merge below would re-derive and persist the
    // exact same generic text as `problem_description` regardless of what the
    // seed was, poisoning the field so the next turn's real answer looks like
    // a change to an "already known" value and gets silently discarded by the
    // stale-pending-field guard above — the confirmed root cause of the
    // reported subtype-question loop.
    const isGenericStarterMessage =
      !complaintAlreadyGenerated &&
      !correction &&
      pendingKey === 'problem_description' &&
      GENERIC_SECTOR_STARTER_MESSAGES.has(content)

    // Phase 7.6, Part 1 — `prior_provider_contact` is the one boolean-shaped
    // complaint field: whatever the user actually typed ("ماتواصلت", "عندي
    // رقم مرجعي", …) is never stored verbatim. It is normalized once, here,
    // to the canonical stored value (`'true'`/`'false'`, via the single
    // shared classifier — lib/ai/intent-guards.ts's parseBooleanAnswer) before
    // it ever reaches `collectedFields`/`collected_information` — every later
    // reader (summary, formal letter, resume) only ever sees that canonical
    // form. When the answer can't be confidently classified, it is not
    // guessed: the field is left unmerged (as if this turn contributed no
    // new information for it), so the server's own missing-field computation
    // simply asks the same question again on the next turn, exactly like an
    // interruption/stale-field turn already does — never silently stored as
    // ambiguous raw text.
    function canonicalizeFieldValue(key: string, rawValue: string): string | null {
      if (inferFieldAnswerShape(key) !== 'boolean') return rawValue
      const parsed = parseBooleanAnswer(rawValue)
      return parsed === null ? null : String(parsed)
    }

    const correctionCanonical = correction
      ? canonicalizeFieldValue(correction.key, correction.value)
      : null
    const wouldMergeAnswer =
      !complaintAlreadyGenerated &&
      !correction &&
      !isInterruption &&
      !pendingFieldStale &&
      !isContinuationFiller &&
      !isGenericStarterMessage
    const answerCanonical = wouldMergeAnswer ? canonicalizeFieldValue(pendingKey, content) : null
    // True only when this turn would otherwise have merged a genuine answer
    // into a boolean-shaped field but couldn't confidently classify it —
    // distinct from every other "don't merge" reason above, so the field is
    // correctly left pending rather than silently corrupted.
    const rejectedBooleanAnswer = wouldMergeAnswer && answerCanonical === null

    const answeredKey = correction ? correction.key : pendingKey
    const updatedFields = complaintAlreadyGenerated
      ? collectedFields
      : correction
        ? correctionCanonical !== null
          ? { ...collectedFields, [correction.key]: correctionCanonical }
          : collectedFields
        : wouldMergeAnswer && !rejectedBooleanAnswer
          ? { ...collectedFields, [pendingKey]: answerCanonical ?? content }
          : collectedFields
    if (!complaintAlreadyGenerated) {
      setCollectedFields(updatedFields)
    }

    // Phase 7.4B, Part 2: no new information means no re-analysis at all — no
    // RAG, no model call, no reroute — it simply resumes the exact question
    // already pending. `pendingQuestionTextRef` holds the last genuine bare
    // question (never a stale identity/greeting reply mixed in — see its
    // declaration); it can be empty right after resuming an already-owned DB
    // conversation (this component never ran a live turn yet to populate
    // it), so the last restored assistant message is the fallback for that
    // case only. The user's message is still persisted for a faithful
    // history, exactly like every other turn.
    if (isContinuationFiller) {
      if (conversationId) {
        void saveUserMessageAction(conversationId, content).catch(() => {})
      }
      const resumeQuestion =
        pendingQuestionTextRef.current ||
        [...messages].reverse().find((message) => message.role === 'assistant')?.content ||
        ''
      if (resumeQuestion) {
        setMessages((previous) => [...previous, createMessage('assistant', resumeQuestion)])
        if (conversationId) {
          void saveAssistantMessageAction(conversationId, resumeQuestion).catch(() => {})
        }
      }
      if (abortRef.current === controller) {
        setStatus('idle')
        abortRef.current = null
      }
      return
    }

    // Phase 7.2, Part 6: an interruption is never saved as the answer to any
    // complaint field — the message itself still reaches messages/history
    // below (saveUserMessageAction), but collected_information is left
    // completely untouched, exactly like a stale-pending-field turn.
    //
    // Phase 7.6, Part 3 — awaited, not fire-and-forget: a just-answered
    // field (e.g. city) must be durably committed to `collected_information`
    // before this turn is considered done, since that table is the single
    // source of truth a refresh/resume reads from (app/wasal/page.tsx). Firing
    // this without awaiting it left a real race — a refresh landing before
    // the upsert committed would find the field still missing and ask it
    // again. Both writes are still best-effort (a failure here must never
    // block the visible turn) — only their *ordering* relative to the
    // request below changed, not their fault-tolerance.
    if (conversationId && !complaintAlreadyGenerated) {
      try {
        const userMessageId = await saveUserMessageAction(conversationId, content)
        if (correction) {
          if (correctionCanonical !== null) {
            await saveCollectedFieldAction(
              conversationId,
              correction.key,
              correctionCanonical,
              userMessageId,
            )
          }
        } else if (
          !isInterruption &&
          !pendingFieldStale &&
          !rejectedBooleanAnswer &&
          !isGenericStarterMessage
        ) {
          await saveCollectedFieldAction(
            conversationId,
            pendingKey,
            answerCanonical ?? content,
            userMessageId,
          )
        }
      } catch {
        // Best-effort — see doc comment above.
      }
    } else if (conversationId) {
      try {
        await saveUserMessageAction(conversationId, content)
      } catch {
        // Best-effort — see doc comment above.
      }
    }

    setStatus('thinking')
    const history = messages.slice(-MAX_HISTORY_ITEMS).map((message) => ({
      role: message.role,
      content: message.content,
    }))

    // Phase 7.2, Part 4/7: tell the server which of these this message is —
    // it re-checks independently against the real pending field, but this
    // signal still lets it skip a wasted model call for identity/out-of-scope.
    const requestIntent = isGreetingInterruption
      ? 'greeting'
      : isIdentityInterruption
        ? 'identity_question'
        : isOutOfScopeInterruption
          ? 'out_of_scope'
          : isSideQuestionInterruption
            ? 'complaint_side_question'
            : 'complaint_guidance'

    // Emergency release fix, Part 2 — the field key this turn genuinely
    // believes it just answered (mirrors the exact condition that decided
    // `updatedFields` above) — lets the server detect the hard
    // duplicate-question invariant: the very same field coming back as
    // still-pending right after it was successfully merged.
    const answeredFieldKeyForRequest = correction
      ? correctionCanonical !== null
        ? correction.key
        : undefined
      : wouldMergeAnswer && !rejectedBooleanAnswer
        ? pendingKey
        : undefined

    try {
      const result = await requestAssistantAnswer({
        conversationId: conversationIdRef.current,
        // Only ever the real server-created conversation row, never the
        // sessionStorage UUID above — when unavailable, this is simply
        // omitted so the server skips saved-routing read/write for this
        // turn rather than treating an unrelated id as a database row.
        dbConversationId: conversationId ?? undefined,
        message: content,
        history,
        intent: requestIntent,
        complaintContext: {
          collectedFields: updatedFields,
          answeredFieldKey: answeredFieldKeyForRequest,
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      if (result.isMocked) {
        if (complaintAlreadyGenerated) {
          // A complaint already exists for this conversation — never let the
          // fallback replace its ComplaintResultCard, re-ask legacy
          // questions, or touch collected_information again.
          const notice =
            'تم إنشاء البلاغ بالفعل لهذه المحادثة — يمكنك نسخه أو تقديمه من البطاقة أعلاه.'
          setMessages((previous) => [
            ...previous,
            createMessage('assistant', notice, { kind: 'system' }),
          ])
          // Phase 7.7, Part 6 — persisted like every other displayed reply,
          // so a resume never shows the user's message with no visible
          // response after it.
          if (conversationId) {
            void saveAssistantMessageAction(conversationId, notice).catch(() => {})
          }
          return
        }

        // Real API path failed to even reach the server (network/timeout) —
        // route.ts itself already degrades a reachable-but-generation-failed
        // turn to the deterministic next question (see the comment on
        // RETRY_NOTICE above), so this residual case is a genuine connection
        // failure with no state to fall back on.
        setMessages((previous) => [...previous, createMessage('assistant', RETRY_NOTICE)])
        if (conversationId) {
          void saveAssistantMessageAction(conversationId, RETRY_NOTICE).catch(() => {})
        }
        return
      }

      // Part 1 (Phase 6.10B): client-side duplicate-question guard —
      // defense-in-depth only (Part 5's server-side merge of
      // collected_information already makes this unreachable in practice).
      // If the server's own nextFieldKey names a field `updatedFields`
      // already has a non-empty value for, never display it and never
      // advance pendingFieldKeyRef to it — no second, client-side
      // missing-fields algorithm is built here; the next real turn simply
      // re-runs the same server-authoritative computation, by which point
      // any transient staleness has resolved.
      const isDuplicateNextField = Boolean(
        result.nextFieldKey && updatedFields[result.nextFieldKey]?.trim(),
      )

      const rawDisplayContent = isDuplicateNextField
        ? result.answer
        : (result.nextQuestion ?? result.answer)
      // Phase 8, Part 13 — never shown for an interruption reply (identity/
      // greeting/out-of-scope/side-question): asking the same question twice
      // legitimately deserves the same fixed answer twice, that is not a bug.
      const displayContent = isInterruption
        ? rawDisplayContent
        : avoidConsecutiveDuplicate(rawDisplayContent, messages)
      setMessages((previous) => [...previous, createMessage('assistant', displayContent)])

      // Phase 7.4B, Part 2/3: any genuine forward-moving turn (not an
      // interruption) updates the continuation-resume text to whatever was
      // actually just displayed — the deterministic `nextQuestion` when
      // routing/missing-fields has resolved a real complaint type, but
      // equally the model's own free-text follow-up (`result.answer`) when
      // routing hasn't resolved yet (missingFieldsResult never activates, so
      // `nextQuestion` stays null even though the model is still genuinely
      // asking something). Using only `result.nextQuestion` here left this
      // ref stuck at the opening message for the entire conversation
      // whenever routing stayed unresolved — confirmed live during Phase
      // 7.4B verification, where a later "كمل" then replayed the fixed
      // opening question instead of resuming. An interruption turn
      // (identity/greeting/out-of-scope/side-question) always leaves the ref
      // untouched — its own composed `answer` is not something to resume
      // *from*, only something to resume *past*.
      if (!isInterruption) {
        pendingQuestionTextRef.current = displayContent
      }

      if (conversationId) {
        void saveAssistantMessageAction(conversationId, displayContent).catch(() => {})
      }

      if (complaintAlreadyGenerated) return

      // The conversation's title is only ever auto-set/upgraded from the
      // problem description itself — never from later answers (city, prior
      // contact, etc.) — and only while it's still generic; see
      // updateConversationTitleAction's own generic-title check (Phase 6.7,
      // Part 1). Best-effort, same as every other persistence call here.
      // Uses the corrected value (not the whole correction sentence) when
      // this turn corrected problem_description (Phase 6.10B, Part 3). Never
      // fires for an interruption (Phase 7.2) — `answeredKey` still equals
      // the untouched pendingKey in that case, but nothing was actually
      // answered, so the title must never be derived from a side
      // question/identity/out-of-scope aside.
      //
      // Emergency Fix #2, Part 1 — also never fires for the generic sector-
      // starter message itself (`isGenericStarterMessage`): live-testing this
      // phase found that deriving the title from the starter's own generic
      // text on turn 1 ("شكوى بشأن لدي مشكلة مع شركة اتصالات") permanently
      // stuck the formal letter's own SUBJECT LINE on that generic text too
      // (formal-letter.ts's `deriveSubject` prefers a "meaningful" — i.e. not
      // one of the 3 known blank defaults — conversation title over its own
      // keyword-classified subject, and this starter-derived title doesn't
      // count as one of those 3 defaults) — the real turn-2 description
      // never got a chance to correct it, since the title is only "upgraded"
      // while still generic.
      if (
        conversationId &&
        !isInterruption &&
        !isGenericStarterMessage &&
        answeredKey === 'problem_description'
      ) {
        const descriptionForTitle = correction ? correction.value : content
        const candidateTitle = deriveComplaintTitleFromFields(
          result.routing?.entityName ?? '',
          descriptionForTitle,
          updatedFields,
        )
        void updateConversationTitleAction(conversationId, candidateTitle)
          .then((wrote) => {
            if (wrote) document.title = candidateTitle
          })
          .catch(() => {})
      }

      pendingFieldKeyRef.current = isDuplicateNextField
        ? pendingFieldKeyRef.current
        : (result.nextFieldKey ?? answeredKey)

      // Emergency release fix, Part 7/8 — the authority card is now
      // state-driven by routing alone, not by full field completion: it
      // appears as soon as routing is valid (confidence !== 'low' and a
      // real entityId) and stays synchronized on every turn afterward,
      // including an interruption/greeting/AI-failure turn (this block runs
      // for those too — only `isServerReady`/`readyToGenerateComplaint`
      // itself is gated separately below). `isComplaintReady` — not
      // `analysis` — is what the composer lock and the save button now
      // check, so showing the card early never blocks answering the
      // remaining questions.
      if (result.routing && result.routing.confidence !== 'low' && result.routing.entityId) {
        setAnalysis(buildComplaintAnalysisFromRouting(result.routing, updatedFields))
        setIsRoutingPersisted(Boolean(result.routingPersisted))
      }
      if (result.readyToGenerateComplaint) {
        setIsComplaintReady(true)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setFailedMessage(content)
    } finally {
      if (abortRef.current === controller) {
        setStatus('idle')
        abortRef.current = null
      }
    }
  }

  async function handleSend(rawContent?: string) {
    const content = (rawContent ?? inputValue).trim()
    if (content === '' || status !== 'idle') return

    setFailedMessage(null)
    const userMessage = createMessage('user', content, { attachment: attachment ?? undefined })
    setMessages((previous) => [...previous, userMessage])
    setInputValue('')
    setAttachment(null)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (mode === 'complaint') {
      await runComplaintTurn(content, controller)
      return
    }

    // Phase 7.5, Part 4: two of the four suggested starters are meta-
    // questions about واصل itself — answered instantly with a fixed,
    // deterministic reply, no AI/backend call. Checked before every other
    // branch below since neither text matches `wantsToCreateComplaint`
    // anyway, but this keeps the fixed answer authoritative regardless.
    const fixedAnswer = getFixedStarterAnswer(content)
    if (fixedAnswer) {
      await runFixedAnswerTurn(content, fixedAnswer)
      return
    }

    // Phase 7.1, Part 4: an explicit "write me a complaint" request no longer
    // gets a static inline CTA (which used to claim the complaint was
    // "أصبحت... جاهزة تقريباً" even with zero context collected) — it starts
    // the real complaint builder directly, exactly as if the user had
    // clicked "إنشاء بلاغ" themselves. requestComplaintCreation already
    // derives whether a genuine problem description exists anywhere earlier
    // in this thread (deriveComplaintResumeState): if not, it asks for the
    // problem first; if so, it continues from the real next missing field —
    // never restarting, never duplicating the opening question. Respects the
    // exact same authentication gating as the header button.
    // Emergency release fix, Part 3 — the telecom starter must "enter a
    // telecom flow and lock the sector", same as the commerce starter
    // already does via `wantsToCreateComplaint` below. Deliberately narrow
    // (the exact suggested-starter text only, from the single shared
    // source — suggestion-chips.tsx) rather than any message that merely
    // mentions telecom keywords, which would incorrectly force complaint
    // mode onto a purely informational question ("كيف أتواصل مع هيئة
    // الاتصالات؟").
    if (GENERIC_SECTOR_STARTER_MESSAGES.has(content) || wantsToCreateComplaint(content)) {
      requestComplaintCreation(userMessage)
      return
    }

    const persistUserTurnPromise = isAuthenticated ? persistUserTurn(content) : undefined
    await runAssistantTurn(content, controller, persistUserTurnPromise)
  }

  function handleRetry() {
    const content = failedMessage
    if (!content) return
    setFailedMessage(null)
    // Drop the user bubble that failed, then resend it as a fresh turn.
    setMessages((previous) => {
      const lastUserIndex = previous.findLastIndex((message) => message.role === 'user')
      return lastUserIndex === -1 ? previous : previous.slice(0, lastUserIndex)
    })
    void handleSend(content)
  }

  function handleNewConversation() {
    abortRef.current?.abort()
    abortRef.current = null
    conversationIdRef.current = crypto.randomUUID()
    dbConversationIdRef.current = null
    dbComplaintConversationIdRef.current = null
    openingMessageRef.current = ''
    pendingFieldKeyRef.current = 'problem_description'
    pendingQuestionTextRef.current = ''
    clearConversation()

    setMode('assistant')
    setMessages([])
    setInputValue('')
    setAttachment(null)
    setStatus('idle')
    setFailedMessage(null)
    setCollectedFields({})
    setAnalysis(null)
    setIsComplaintReady(false)
    setIsRoutingPersisted(false)
    setAwaitingSignIn(false)
    setComplaintResult(null)
    setIsCreatingComplaint(false)
    setCreateComplaintError(null)
    announcedEntitiesRef.current = []
    setAnnouncedEntities([])
    setAuthorityEntity(null)
    setIsAuthorityModalOpen(false)
  }

  /**
   * Creates the real, database-backed complaint for the current complaint
   * conversation — calls `createComplaintAction` directly with only the real
   * DB conversation id and the current `collectedFields`. Deliberately never
   * touches `mode`/`messages`/`analysis`/`collectedFields`/routing, and never
   * calls `requestComplaintCreation`/`startComplaintBuilder` — this must not
   * reset or restart the conversation in any way.
   */
  async function handleCreateComplaint() {
    // isRoutingPersisted/isComplaintReady are defense-in-depth UI guards
    // (Phase 6.6F; emergency release fix Part 7/8) — the button itself is
    // already disabled while either is false, but this blocks any
    // programmatic call too. createComplaintAction still independently
    // re-reads saved routing and required fields as the real security
    // authority regardless.
    if (isCreatingComplaint || complaintResult || !isRoutingPersisted || !isComplaintReady) return
    const conversationId = dbComplaintConversationIdRef.current
    if (!conversationId) {
      setCreateComplaintError('حدث خطأ غير متوقع. حاول مرة أخرى.')
      return
    }

    setIsCreatingComplaint(true)
    setCreateComplaintError(null)
    try {
      const result = await withTimeout(
        createComplaintAction(conversationId, collectedFields),
        CREATE_COMPLAINT_TIMEOUT_MS,
      )
      if (result.success) {
        setComplaintResult(result.complaint)
        showToast('تم إنشاء البلاغ بنجاح.')
      } else {
        setCreateComplaintError(result.error)
      }
    } catch (error) {
      // Collected fields, analysis, and the conversation itself are never
      // touched here — a retry (below) simply calls this same function again.
      setCreateComplaintError(
        error instanceof ActionTimeoutError
          ? 'استغرق إنشاء البلاغ وقتاً أطول من المتوقع. حاول مرة أخرى.'
          : 'حدث خطأ غير متوقع. حاول مرة أخرى.',
      )
    } finally {
      setIsCreatingComplaint(false)
    }
  }

  /** Records the user's own confirmation that they submitted the complaint
   * to the authority — sets `submitted_at` only; `status` is never changed to
   * a non-existent value. */
  async function handleMarkSubmitted() {
    if (!complaintResult || isMarkingSubmitted || complaintResult.submittedAt) return

    setIsMarkingSubmitted(true)
    try {
      const result = await markComplaintSubmittedAction(complaintResult.id)
      if (result.success) {
        setComplaintResult((previous) =>
          previous
            ? { ...previous, submittedAt: result.submittedAt, updatedAt: result.updatedAt }
            : previous,
        )
        showToast('تم تحديث حالة البلاغ.')
      } else {
        showToast(result.error, 'error')
      }
    } catch {
      showToast('حدث خطأ غير متوقع. حاول مرة أخرى.', 'error')
    } finally {
      setIsMarkingSubmitted(false)
    }
  }

  const isComplaintMode = mode === 'complaint'
  const isEmpty = messages.length === 0
  // Emergency release fix, Part 7/8 — locks on true completion
  // (`isComplaintReady`), not on the authority card's mere presence
  // (`analysis`), since the card can now be visible well before every
  // required field is collected.
  const isComposerDisabled = status !== 'idle' || (isComplaintMode && isComplaintReady)
  // Mobile authority-card-overlap fix — same condition the aside's own
  // render check already used, extracted so the grid container can also
  // know whether a card column/row needs to be reserved at all. Without
  // this, a fixed two-column desktop grid would leave an empty reserved
  // column whenever no card exists yet.
  const showCardArea = Boolean(
    (isComplaintMode && status === 'analyzing') || analysis || complaintResult,
  )

  return (
    <div
      className={
        // Mobile one-continuous-scroll fix — below `lg`, this is a plain
        // `flex-col`: no min-h-0/flex-1 height constraint, no grid. Every
        // piece (header, messages, card, composer) simply stacks in normal
        // document flow, in DOM order, and grows to its natural content
        // height — the page/body itself is the single scroll container
        // (enabled by the matching change in app/wasal/layout.tsx, which
        // stops constraining the page to a fixed viewport height below
        // `lg`). No independent scroll region, no fixed/sticky/absolute
        // positioning anywhere in this mobile path.
        //
        // At `lg` and above, this switches to the previous CSS grid,
        // reproducing today's desktop split exactly: header + messages +
        // composer stacked in a variable-width left column, the card
        // spanning the full height of a fixed-width right column — see the
        // per-element `lg:col-start-*`/`lg:row-start-*` classes below. The
        // column/row for the card is only ever reserved when a card
        // actually exists (`showCardArea`), so an absent card never leaves
        // an empty desktop column.
        //
        // `flex-1` is unconditional (not `lg:`-only) so this root actually
        // receives the full height `main`/the page shell already grow to
        // (Part 8) — paired with the messages area's own `flex-1` below,
        // this is what lets the composer land at the real bottom of the
        // viewport on a short/empty conversation instead of stopping right
        // after the greeting with a blank gap beneath it, while a long
        // conversation still simply grows past the viewport and scrolls
        // (flex-grow only ever consumes *leftover* space, never shrinks
        // content — no `min-h-0` here on the mobile path).
        showCardArea
          ? 'flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_1fr_auto]'
          : 'flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-1 lg:grid-rows-[auto_1fr_auto]'
      }
    >
      {/* Nothing to act on before the first message — keep the blank slate clean. */}
      {isEmpty ? null : (
        <div className="border-border bg-background/85 flex items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-lg sm:px-6 lg:col-start-1 lg:row-start-1">
          <div className="flex items-center gap-2">
            {isComplaintMode ? (
              <span className="bg-primary/8 text-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium">
                <FileSignature className="h-3.5 w-3.5" aria-hidden="true" />
                جارٍ إعداد البلاغ
              </span>
            ) : (
              <span className="text-muted-foreground text-sm font-medium">واصل</span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {isComplaintMode ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => requestComplaintCreation()}
                className="hidden sm:inline-flex"
              >
                <FileSignature className="h-3.5 w-3.5" aria-hidden="true" />
                إنشاء بلاغ
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleNewConversation}
              aria-label="بدء محادثة جديدة"
              title="بدء محادثة جديدة"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">محادثة جديدة</span>
            </Button>
          </div>
        </div>
      )}

      {/* `flex-1` here (paired with the root's own `flex-1` above) is what
          absorbs the leftover space on a short/empty mobile conversation,
          pushing the composer down to the real bottom of the viewport
          instead of stranding it right under the greeting — a no-op on
          desktop, where this is a grid item instead and flex-grow doesn't
          apply. */}
      <div className="flex-1 px-4 py-6 sm:px-6 lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {isEmpty && status === 'idle' ? (
            <ChatEmptyState onSelectSuggestion={(suggestion) => void handleSend(suggestion)} />
          ) : null}

          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              onCreateComplaint={requestComplaintCreation}
            />
          ))}

          <AnimatePresence>
            {status !== 'idle' ? (
              <TypingIndicator
                key="typing"
                label={status === 'analyzing' ? 'واصل يحلل الشكوى...' : 'واصل يكتب...'}
              />
            ) : null}
          </AnimatePresence>

          {failedMessage ? (
            <div className="border-danger/25 bg-danger/5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3">
              <p className="text-danger text-sm">
                {isComplaintMode
                  ? 'تعذر تحليل الشكوى. يرجى المحاولة مرة أخرى.'
                  : 'تعذر إرسال رسالتك حالياً. حاول مرة أخرى.'}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={handleRetry}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {isComplaintMode ? 'إعادة التحليل' : 'إعادة المحاولة'}
              </Button>
            </div>
          ) : null}

          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <AnimatePresence>
        {/* Emergency release fix, Part 7 — no longer gated on `isComplaintMode`:
            a grievance resolved through general chat (e.g. the telecom
            starter) can populate `analysis` without ever switching modes,
            and the card must show regardless. */}
        {showCardArea ? (
          // Mobile one-continuous-scroll fix — no independent scroll region
          // below `lg` (`overflow-y-auto`/`min-h-0` are `lg:`-only now): the
          // card grows to its natural height and participates in the same
          // page-level document flow as the messages above it and the
          // composer below it. `w-full max-w-full` is the explicit mobile
          // width requirement (the flex-col's default stretch would already
          // size it the same way). At `lg` and above, `lg:col-start-2
          // lg:row-start-1 lg:row-span-3` reproduces today's desktop sidebar
          // exactly: a fixed-width column spanning the full height alongside
          // the header/messages/composer column, scrolling independently via
          // `lg:overflow-y-auto` exactly as before. No fixed/absolute/sticky
          // positioning anywhere at any breakpoint.
          <aside className="border-border w-full max-w-full shrink-0 border-t p-4 sm:p-6 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-l">
            <div className="flex flex-col gap-4">
              {status === 'analyzing' ? (
                <RecommendationSkeleton />
              ) : complaintResult ? (
                <ComplaintResultCard
                  complaint={complaintResult}
                  onMarkSubmitted={handleMarkSubmitted}
                  isMarkingSubmitted={isMarkingSubmitted}
                />
              ) : analysis ? (
                <>
                  <ProgressTimeline currentStage={isComplaintReady ? 'ready' : 'summary'} />
                  <RecommendationCard
                    analysis={analysis}
                    letter={analysis.summary}
                    onSave={handleCreateComplaint}
                    isSaving={isCreatingComplaint}
                    saveDisabledNotice={
                      !isComplaintReady
                        ? 'لا تزال بعض المعلومات مطلوبة لإكمال البلاغ...'
                        : !isRoutingPersisted
                          ? 'جارٍ تثبيت بيانات الجهة المختصة...'
                          : undefined
                    }
                  />
                  {createComplaintError ? (
                    <div className="border-danger/25 bg-danger/5 flex flex-col gap-2 rounded-2xl border px-4 py-3">
                      <p className="text-danger text-sm">{createComplaintError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCreateComplaint}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        إعادة المحاولة
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
        ) : null}
      </AnimatePresence>

      {/* Mobile authority-card-overlap fix, cont'd — this must come after the
          card in DOM order: below `lg`, grid items with no explicit
          placement auto-fill rows in DOM order, so the composer needs to be
          the last child to land in the last row (the required mobile order
          is header, messages, card, composer). At `lg` and above, the
          explicit `lg:row-start-3`/`lg:col-start-1` below overrides this
          DOM-order placement, returning it to its current desktop position
          at the bottom of the chat column regardless. */}
      <div className="lg:col-start-1 lg:row-start-3">
        <ChatComposer
          value={inputValue}
          onChange={setInputValue}
          onSend={() => void handleSend()}
          attachment={attachment}
          onAttachmentChange={setAttachment}
          disabled={isComposerDisabled}
          placeholder={
            isComplaintMode && analysis
              ? 'اكتمل البلاغ — احفظه أو انسخ الملخص من البطاقة.'
              : isComplaintMode
                ? 'اكتب إجابتك...'
                : CHAT_GREETING
          }
        />
      </div>

      <AuthorityModal
        isOpen={isAuthorityModalOpen}
        entity={authorityEntity}
        reason={authorityReason}
        onCreateComplaint={requestComplaintCreation}
        onContinueChat={() => setIsAuthorityModalOpen(false)}
      />

      <LoginRequiredModal isOpen={isLoginModalOpen} onClose={() => setIsLoginModalOpen(false)} />
    </div>
  )
}
