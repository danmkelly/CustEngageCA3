# Teacher's Pet — Solution State

**CA3 Final Project, H9CEAI Customer Engagement & AI, NCI PGDip/MSc AI for Business, August 2026**

A personal knowledge concierge for Irish primary teachers. An agentic system that indexes a teacher's private resource library against curriculum frameworks and fills gaps intelligently. The architecture generalises to any info-burdened professional.

---

## Architecture

```
GitHub Pages (static frontend) → Cloudflare Worker (API + agent orchestration) → Microsoft Graph API → OneDrive for Business
```

- **Frontend:** Single-page HTML/CSS/JS, served from GitHub Pages at `https://danmkelly.github.io/CustEngageCA3/frontend/index.html`
- **Worker:** Cloudflare Worker at `teachers-pet.dan-m-kelly.workers.dev` — 6 endpoints, 5-agent pipeline, DeepSeek API, JSZip
- **Catalogue:** 2,893 rows in `data/catalogue.json`, served from GitHub Pages, loaded by Worker at cold-start
- **Auth:** App-only Microsoft Graph (modernise.ie business tenant). No user sign-in. Files accessed directly by Worker.
- **Bundle:** ZIP with resource files + README + AI disclosure, streamed to browser

## Two Interaction Modes

1. **Curriculum Guided Selection** — Progressive dropdowns (Subject → Strand → Stage → Outcome). Searches catalogue by outcome code + grade band with normalisation. Honest gap detection (only when genuinely zero resources).

2. **Interactive Bot Selection** — LLM-powered chat concierge. Two-stage semantic search: keyword retrieval (top 50) → DeepSeek relevance ranking (top 10). Context-aware across conversation turns. CASA-compliant (bot identity disclosed in turn 1).

## Bundle System

- **Persistent sidebar:** Right column, shared across both tabs. Selected items persist across tab switches.
- **App-only download:** Worker fetches files from OneDrive for Business via Microsoft Graph, zips with JSZip, streams download.
- **GitHub pre-loaded fallback:** 22 files committed to `data/resources/` — no-auth fallback.
- **Per-tab state:** Results, gaps, AI-generated content, and refinement chips are independent per tab.

## Catalogue

- 2,893 rows, 1,438 outcome-tagged (50%), 1,484 grade/format-tagged (51%)
- In-scope: Literacy (97% tagged) + Maths (96% tagged)
- Excluded by design: Gaeilge, SESE, SPHE, PE, Arts, Religion (Decision 2)
- Tagged via: pdfplumber text extraction → DeepSeek classification + Gemini Flash vision for image-heavy files
- Outcomes normalised to `TF# C#` or `PC# S#` format

## Lesson Plans (Experimental)

- Independent tile below bundle sidebar
- "Generate & Download Lesson Plan" — one-click generation + markdown download
- Regenerate available after completion
- Branded as experimental with failure disclosure
- Decoupled from bundle — bundle reliability is never compromised

## Agent Pipeline

**Development team (builds once):** Dev-Architect, Dev-Maker, Dev-Communicator, Dev-Manager, Keelin (security review)

**Operations team (runs on query):** Ops-Researcher, Ops-Designer, Ops-Maker, Ops-Communicator, Ops-Manager, Keelin (content QA)

11 agent definition files in `agents/`. Keelin is shared across both teams — security review in Dev, content validation in Ops.

## Reference Taxonomies

- `taxonomy/language.json` — Primary Language Curriculum (TF codes × 3 strands × 4 stages)
- `taxonomy/maths.json` — Primary Mathematics Curriculum (5 strands, 12 progression continua)
- `taxonomy/ufli.json` — UFLI Foundations (128 lessons with curriculum cross-refs)
- `taxonomy/1999_skeleton.json` — 1999 curriculum skeleton (strands only, no outcome matching)

## Key Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/query` | POST | Guided + freetext catalogue search |
| `/api/chat` | POST | LLM-powered chat with semantic search |
| `/api/bundle` | POST | ZIP bundle creation (OneDrive + GitHub files) |
| `/api/catalogue` | GET | Full catalogue as JSON |
| `/api/taxonomy/:name` | GET | Reference taxonomy data |
| `/api/generate-lesson` | POST | Standalone lesson plan generation |

## Governance & Disclosure

- `GOVERNANCE.md` — Disclosure policy, escalation routes (3 named triggers with response times), monthly review cadence, data minimisation, EU AI Act positioning
- `AI_DISCLOSURE.md` — All AI used (DeepSeek, Gemini Flash, OpenCode/Claude), confidence tiers, limitations, teacher's role
- Frontend footer: Links to both + Trust Statement
- Every bundle README includes AI disclosure
- AI-generated content visually distinct in UI

## QA State

- **Keelin deep test:** 10/10 PASS — all endpoints verified against deployed Worker
- **Findings register:** 22 entries, all resolved or accepted
- **QA page:** `qa.html` — 3-pillar framework assessment (40 frameworks), functional test table, security audit, CA3 criteria map
- **Pipeline page:** `pipeline_thoughts.html` — full design journey (24 phases), 7 tabbed decision panels

## Key Design Decisions

1. **Parse all PDFs** — Full deep parse, not sample (~$16, ~90 min)
2. **English + Maths only** — Two taxonomy styles (coded outcomes + progression continua) fully demonstrable
3. **No Gaeilge** — LLMs unreliable in Irish; tagged from folder only, excluded from demo
4. **UFLI programme reference** — 128-lesson scope-and-sequence as JSON; cross-refs to curriculum outcomes
5. **Search-first, generate-as-fallback** — Gap resolution via curriculumonline.ie search before AI generation
6. **App-only auth** — Zero friction for demo; production would use delegated OAuth
7. **Lesson plans experimental** — Decoupled from bundle, honestly branded

## File Count

~6,500 lines across: HTML (2,800), JavaScript/Worker (1,400), Markdown (800), JSON (750), Python (350)

## Milestones

- `v1.0-milestone` — First stable: 10/10 Keelin, guided+freetext, persistent bundle, app-only auth
- `v2.0-milestone` — Interactive Bot Selection + chat, 12/12 Keelin
- `v2.2-stable` — Lesson plans decoupled, semantic chat search, 10/10 Keelin

## Limitations (Documented)

- App-only auth exposes catalogue through Worker (acceptable for graded demo)
- No persistent session state (in-memory only)
- Browse/explore tab removed (engineering complexity without rubric value)
- Lesson plan generation depends on DeepSeek API latency (2-15s, outside our control)
- Personal OneDrive not supported (requires SPO license); business tenant required for file downloads
