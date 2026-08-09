# واصل wasel
خلها توصل صح ...
> بلاغك... بداية الحل
لزيارة الموقع : Open https://wisal-peach.vercel.app.

An Arabic-first (RTL) platform that helps users understand their complaint, identify the right
Saudi government authority, and draft a professional complaint before submitting it.

Built with Next.js 15 (App Router), React 19, Tailwind CSS v4, Supabase Auth, and Motion.

## Getting started

```bash
npm install
npm run dev
```


Copy `.env.example` to `.env.local` and fill in the Supabase and AI provider values.

## Access model

| | Guest | Signed in |
| --- | --- | --- |
| Browse the site, read about authorities | ✅ | ✅ |
| Ask Wasal general questions (`/wasal`) | ✅ | ✅ |
| Start the Complaint Builder | ❌ | ✅ |
| Save complaints, view the dashboard | ❌ | ✅ |

Authentication is required **only** to create or save a complaint. Everything else, including the
AI assistant, is open to guests.

## Routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | public | Landing page |
| `/about` | public | About Wasal |
| `/entities` | public | Supported government authorities |
| `/wasal` | public | AI assistant + Complaint Builder |
| `/auth/sign-in`, `/auth/sign-up` | public | Authentication |
| `/dashboard` | protected | Overview, drafts, quick actions |
| `/dashboard/complaints` | protected | Previous complaints (search / filter / sort) |
| `/dashboard/conversations` | protected | Conversation history |
| `/dashboard/drafts` | protected | Saved drafts |
| `/dashboard/profile` | protected | Account details |
| `/dashboard/settings` | protected | Language, appearance, privacy, security |
| `/dashboard/knowledge` | protected, unlinked | Reserved for future admin use — not in any nav |

`/dashboard/*` is guarded in `middleware.ts`, which redirects guests to sign-in with a `next`
parameter so they return to the page they wanted.

## Project structure

```
app/
  (marketing)/     Landing, about, entities — public shell with header + footer
  (dashboard)/     Authenticated area — sidebar, bottom nav, user menu
  wasal/           Chat experience — full-height shell, no footer
  auth/            Sign-in, sign-up, OAuth callback
  api/ai/chat/     Chat endpoint (guests allowed, IP-rate-limited)
components/
  brand/ ui/ marketing/ wasal/ dashboard/ government/ knowledge/
lib/
  wasal/           Mock AI engine, entity matching, chat client
  mock/            Mock complaints, conversations, entities, stats
  auth/ supabase/ ai/ rag/ utils/
```

## AI behaviour

`Ask Wasal` calls `/api/ai/chat` (Cloudflare + RAG retrieval). If that endpoint is unconfigured,
errors, or times out, the client silently falls back to the deterministic mock engine in
`lib/wasal/mock-engine.ts`, so the product is always demoable.

The `Complaint Builder` is fully mock-driven: a fixed question script collects the details, then
`buildComplaintAnalysis` produces the government recommendation, confidence score, required
documents, and submission steps.

## Current MVP scope

- **No database persistence.** Complaints and conversations come from `lib/mock/`; saving and
  deleting are acknowledged in the UI only.
- **Light mode only.** Dark mode is shown in Settings as "coming soon".
- **Placeholder statistics** on the landing page, labelled as illustrative.
- **Placeholder government marks** (`components/government/government-logo.tsx`) until real logo
  assets are supplied — swap that component's body and every call site updates.

## Design system

The palette is fixed by the brand spec and defined in `app/globals.css`:

| Token | Value | Use |
| --- | --- | --- |
| background | `#FFF2E6` | off-white page (60%) |
| primary | `#052102` | dark green (25%) |
| secondary | `#586357` | light green (10%) |
| accent / danger | `#3D0000` | burgundy (5%) |

## Scripts

```bash
npm run dev           # dev server (Turbopack)
npm run build         # production build
npm run lint          # ESLint
npm run format        # Prettier
npm run ingest:knowledge   # populate the RAG knowledge base
```
