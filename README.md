# Teacher's Pet

> **An Agentic Organisation for Irish primary teachers** — AI-assisted resource discovery, sequencing, and lesson plan generation from a teacher's personal OneDrive collection.

---

## What It Does

Teacher's Pet is a single-teacher resource concierge. Describe what you need — a curriculum outcome, a topic, a class level — and the system searches your personal teaching resource catalogue (2,893 rows), sequences matched resources into a lesson structure, identifies gaps in coverage, and can generate a markdown lesson plan using the DeepSeek API. Every result carries a confidence score, every generated plan is explicitly marked as AI-generated, and selected resources are downloadable as a zip bundle with a built-in AI disclosure.

Two interaction modes: **Curriculum Guided Selection** (progressive dropdowns: Subject → Strand → Stage → Outcome) and **Interactive Bot Selection** (LLM-powered chat concierge with two-stage semantic search).

---

## Architecture Overview

```
GitHub Pages (static frontend) → Cloudflare Worker (API + agent orchestration) → OneDrive for Business (bundle files)
                                                                               → DeepSeek API (lesson plans)
                                                                               → curriculumonline.ie (gap discovery)
```

The Worker runs an agent pipeline on every query: **Ops-Manager** (orchestration) → **Ops-Researcher** (catalogue search) → **Ops-Designer** (resource sequencing + gap spec) → **Ops-Communicator** (markdown summary + zip bundle). **Ops-Maker** generates lesson plans as a standalone teacher-initiated feature via a dedicated frontend tile. 11 agent definition files across two teams (Dev builds once, Ops runs on query).

---

## Supporting Documentation (submission)

| Page | Purpose |
|---|---|
| `qa.html` | QA Dashboard — 40 framework assessments, 30 findings, bot behaviour audit, LLM weakness reflection |
| `pipeline_thoughts.html` | Design Journey — 18 phases, architecture, decisions, agent specs, catalogue pipeline |
| `collab.html` | Agent Collaboration — Dev and Ops team case studies, non-linear flows, partnership progression |
| `agents.html` | Agent Roster — single-table side-by-side Dev/Ops comparison with GitHub links |
| `state.md` | Solution state snapshot — current architecture, known limitations, recent changes |
| `GOVERNANCE.md` | Governance framework (Stilgoe et al. 2013) — disclosure, escalation, review cadence |
| `AI_DISCLOSURE.md` | AI disclosure (appended to every bundle) |

---

## Project Structure

```
GitRepo/
├── agents/
│   ├── dev/                      # Dev team (builds once)
│   │   ├── architect.md          #   System design & architecture
│   │   ├── maker.md              #   Code generation
│   │   ├── communicator.md       #   Documentation & disclosure
│   │   ├── manager.md            #   Build sequencing & scope management
│   │   └── keelin.md             #   Academic, functional & security QA
│   ├── ops/                      # Ops team (runs on every query)
│   │   ├── manager.md            #   Session orchestration & audit logging
│   │   ├── researcher.md         #   Catalogue search & gap detection
│   │   ├── designer.md           #   Resource sequencing & Maker specs
│   │   ├── maker.md              #   Lesson plan generation (DeepSeek)
│   │   ├── communicator.md       #   Summary & zip bundling
│   │   └── keelin.md             #   Content validation QA
├── data/
│   └── catalogue.json            # 2,893-row resource catalogue (served from GitHub Pages)
├── frontend/
│   └── index.html                # Main Teacher's Pet UX
├── scripts/
│   └── catalogue_populator.py    # PDF scan → catalogue population pipeline
├── taxonomy/
│   ├── 1999_skeleton.json        # Irish Primary Curriculum (1999) structure
│   ├── language.json             # Primary Language Curriculum (2019) outcomes
│   ├── maths.json                # Primary Maths Curriculum (2023) outcomes
│   └── ufli.json                 # UFLI Foundations scope & sequence
├── worker/
│   ├── worker.js                 # Cloudflare Worker (~1,900 lines)
│   ├── wrangler.toml             # Worker configuration
│   ├── taxonomy-data.js          # Embedded taxonomy data
│   └── package.json              # Dependencies (jszip)
├── index.html                    # Root redirect to frontend/index.html
├── qa.html                       # QA Dashboard
├── pipeline_thoughts.html        # Design Journey
├── collab.html                   # Agent Collaboration
├── agents.html                   # Agent Roster
├── state.md                      # Solution state snapshot
├── README.md                     # This file
├── GOVERNANCE.md                 # Governance framework
├── AI_DISCLOSURE.md              # AI disclosure statement
├── CATALOGUE.md                  # Catalogue taxonomy documentation
└── .gitignore
```

---

## CA3 Context

Built for **CA3 Final Project**, **H9CEAI Customer Engagement & Artificial Intelligence**, **National College of Ireland PGDip/MSc in AI for Business**, August 2026.

**This is a graded academic project, not a production service.** The code demonstrates the agentic organisation concept, responsible AI governance, AI disclosure practice, and engineering execution at the scale of a single postgrad project. It is not intended for classroom deployment without significant hardening.

---

## Known Scope Limitations

This is an honest list — what the system does not do, and the status of each:

- **Ops-Keelin validation gate unimplemented.** Generated lesson plans reach the teacher without automated QA verification. The architecture supports a gate between Maker and Communicator; implementation is a post-CA3 item.
- **Manager governance functions partial.** The audit log is written (fire-and-forget) but never analysed. No automated governance reporting, trust calibration protocol, or disagreement tracking.
- **UFLI lesson-range constraint absent.** The 128-lesson scope-and-sequence taxonomy exists but is never referenced by any agent. Generated plans may introduce untaught sounds.
- **curriculumonline.ie fallback hardcoded.** Always scrapes the Reading strand page regardless of the outcome queried. No dynamic search URL construction.
- **Single teacher only.** The catalogue is one teacher's private collection. No multi-user support.
- **No authentication.** The Worker and frontend are open. App-only Graph auth on a business tenant — acceptable for a graded demo; delegated OAuth is the documented production path.
- **No Gaeilge content generation.** LLMs are unreliable in Irish. Catalogue resources matched and returned but no AI-generated Irish-language content.
- **Text-based lesson plans only.** Generated content is markdown prose. No worksheets, slide decks, images, or printable materials.
- **No persistent Worker storage.** The Worker stores nothing between requests except an in-memory cache. Audit logs go to an Excel sheet on OneDrive.
- **Keyword matching is pre-semantic.** Freetext search uses substring matching, not embedding-based semantic search. The chat mode's two-stage LLM ranking partially mitigates this.

---

*Teacher's Pet — CA3 Final Project, August 2026.*
