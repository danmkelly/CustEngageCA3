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
- **Auth:** App-only Microsoft Graph on a business tenant (modernise.ie). Worker fetches OneDrive files directly — no user sign-in. Production path would use delegated OAuth via MSAL.js.
- **Bundle:** ZIP with resource files + README + AI disclosure, streamed to browser

## Two Interaction Modes

1. **Curriculum Guided Selection** — Progressive dropdowns (Subject → Strand → Stage → Outcome). Searches catalogue by outcome code + grade band with normalisation. Honest gap detection with available-level suggestions.

2. **Interactive Bot Selection** — LLM-powered chat concierge. Two-stage semantic search: keyword retrieval (top 50, 9-field scoring) → DeepSeek relevance ranking (top 10). Context-aware across conversation turns. CASA-compliant (bot identity disclosed in turn 1).

## Search & Filtering

- **9-field freetext scoring:** filename, subject, subdomain, format, activity_type, season, grade_band, extracted_text_sample, tags
- **Mandatory grade-band filtering:** Class-level terms (Junior Infants, 1st Class, 5th-6th, etc.) extracted from freetext queries and applied as hard filters
- **Controlled vocabulary:** All class-level inputs normalised to standard band labels (Infants, 1st-2nd, 3rd-4th, 5th-6th) via `normalizeGradeBand()` and `extractGradeBandFromQuery()`
- **Gap reporting:** When no resources match topic + level, returns explicit message listing alternative levels where resources exist
- **Refinement chips:** Client-side filtering by format, grade band (Junior Infants, Senior Infants, 1st-2nd, 3rd-4th, 5th-6th), and season

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

**Development team (builds once):** Dev-Architect, Dev-Maker, Dev-Communicator, Dev-Manager, Dev-Keelin (academic, functional & security QA)

**Operations team (runs on query):** Ops-Researcher, Ops-Designer, Ops-Maker, Ops-Communicator, Ops-Manager, Ops-Keelin (content QA)

11 agent definition files in `agents/`. Keelin is split across both teams — three-facet quality review in Dev (security always blocks; academic/functional block on high severity), content validation in Ops.

## Reference Taxonomies

- `taxonomy/language.json` — Primary Language Curriculum (TF codes × 3 strands × 4 stages)
- `taxonomy/maths.json` — Primary Mathematics Curriculum (5 strands, 12 progression continua)
- `taxonomy/ufli.json` — UFLI Foundations (128 lessons with curriculum cross-refs)
- `taxonomy/1999_skeleton.json` — 1999 curriculum skeleton (strands only, no outcome matching)

## Key Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/query` | POST | Guided + freetext catalogue search with grade-band filtering |
| `/api/chat` | POST | LLM-powered chat with two-stage semantic search + grade-band filtering |
| `/api/bundle` | POST | ZIP bundle creation (OneDrive + GitHub files) with AI disclosure README |
| `/api/catalogue` | GET | Full catalogue as JSON |
| `/api/taxonomy/:name` | GET | Reference taxonomy data |
| `/api/generate-lesson` | POST | Standalone lesson plan generation |

## Documentation Pages

| Page | Purpose |
|---|---|
| `index.html` (root) | Redirect to frontend UX |
| `frontend/index.html` | Main Teacher's Pet application |
| `qa.html` | QA Dashboard — 40 framework assessments, 30 findings register, bot behaviour audit, reflection |
| `pipeline_thoughts.html` | Design Journey — 18 phases, 7 tabs, architecture, decisions, agent specs |
| `collab.html` | Agent Collaboration — Dev and Ops team case studies, non-linear flows, partnership progression |
| `agents.html` | Agent Roster — single-table side-by-side Dev/Ops comparison, role alignment, GitHub links |
| `README.md` | Project overview and setup instructions |
| `GOVERNANCE.md` | Disclosure policy, escalation routes, review cadence |
| `AI_DISCLOSURE.md` | All AI used, confidence tiers, limitations, teacher's role |
| `CATALOGUE.md` | Taxonomy documentation |
| `state.md` | This file — solution state snapshot |

## Recent Changes (August 2026)

### Bot Behaviour Audit (Phase 17)
- **6 bugs fixed:** search field coverage (4→9 fields), chat ranking error handling, router 404 endpoint exposure, confidence score conflation, designer plenary skip, vague error messages
- **4 scope limitations documented:** Ops-Keelin validation gate unimplemented, Manager governance functions missing, UFLI lesson-range constraint absent, curriculumonline.ie fallback hardcoded
- **7-test teacher-centric battery** executed against deployed Worker — all passing

### Class-Level Search Enhancement (Phase 24)
- Mandatory grade-band filter added to freetext and chat search modes
- Controlled vocabulary for class levels via `normalizeGradeBand()` and `extractGradeBandFromQuery()`
- Refinement chips updated with Junior/Senior Infants
- Gap messages now list alternative levels where resources exist

## QA State

- **Findings register:** 30 entries (K01-K30), all resolved or documented
- **Bot behaviour audit:** 7 teacher-centric test scenarios, all passing
- **QA page:** `qa.html` — 3-pillar framework assessment (40 frameworks), functional test table, security audit, CA3 criteria map, bot behaviour audit with LLM weakness reflection
- **Pipeline page:** `pipeline_thoughts.html` — full design journey (18 phases), 7 tabbed decision panels
- **Collaboration page:** `collab.html` — Dev and Ops team case studies, 10 non-linear challenge flows, partnership progression ladder
- **Agent roster:** `agents.html` — single-table side-by-side Dev/Ops comparison, 11 agents with identities, boundaries, and GitHub links

## Key Design Decisions

1. **Parse all PDFs** — Full deep parse, not sample (~$16, ~90 min)
2. **English + Maths only** — Two taxonomy styles (coded outcomes + progression continua) fully demonstrable
3. **No Gaeilge** — LLMs unreliable in Irish; tagged from folder only, excluded from demo
4. **UFLI programme reference** — 128-lesson scope-and-sequence as JSON; cross-refs to curriculum outcomes
5. **Search-first, generate-on-demand** — Gap detection drives catalogue improvement (curriculumonline.ie search first). Lesson plan generation is a standalone, always-available feature (decoupled tile), not conditional on a gap existing.
6. **App-only auth** — Business tenant (modernise.ie) enables zero-friction download; production path is delegated OAuth via MSAL.js
7. **Lesson plans experimental** — Decoupled from bundle, honestly branded
8. **Split Keelin** — Dev-Keelin (security gate) and Ops-Keelin (content QA) are separate agents with non-overlapping scopes
9. **Warm library-card identity** — Fraunces + Public Sans + cream palette across all pages

## File Count

~15,000 lines across: HTML (11,000: frontend, qa, pipeline, collab, agents), JavaScript/Worker (1,900), Markdown (800), JSON (750), Python (350)

## Milestones

- `v1.0-milestone` — First stable: 10/10 Keelin, guided+freetext, persistent bundle, app-only auth
- `v2.0-milestone` — Interactive Bot Selection + chat, 12/12 Keelin
- `v2.2-stable` — Lesson plans decoupled, semantic chat search, 10/10 Keelin
- `v2.3-stable` — Class-level mandatory filtering, 9-field freetext search, controlled grade-band vocabulary
- `v3.0-stable` — Bot behaviour audit complete: 6 bugs fixed, 4 scope limitations documented, all docs updated

## Known Scope Limitations (Documented)

- **Ops-Keelin validation gate unimplemented** — Generated lesson plans reach teacher with zero verification (no hallucination detection, no UFLI boundary checks, no paired-prompt bias testing)
- **Manager governance functions missing** — Audit log is written but never analysed; no trust calibration protocol, no disagreement tracking, no governance reporting
- **UFLI lesson-range constraint absent** — 128-lesson taxonomy exists but is never referenced by any agent; generated plans may introduce untaught sounds
- **curriculumonline.ie fallback hardcoded** — Always scrapes the Reading strand page regardless of outcome queried; no dynamic search URL construction
- **App-only auth exposes catalogue through Worker** — Acceptable for graded demo; delegated OAuth is the documented production path
- **No persistent session state** — In-memory only; page refresh loses selections and search history
- **Researcher gap analysis is binary** — Spec calls for full outcome coverage comparison (fully/partially/zero); code only detects "nothing found"
- **Designer Maker spec is thin** — Spec calls for verbatim outcome prose, materials list, differentiation notes, assessment check; code produces only 6 generic fields
- **Lesson plan generation depends on DeepSeek API latency** — 2-15s, outside our control
- **Keyword matching is pre-semantic** — Cannot distinguish genuine thematic relevance from coincidental substring matches (partially mitigated by chat mode's two-stage ranking)
