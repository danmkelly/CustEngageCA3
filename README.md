# Teacher's Pet

> **An Agentic Organisation for Irish primary teachers** — AI-assisted resource discovery, sequencing, and lesson plan generation from a teacher's personal OneDrive collection.

---

## What It Does

Teacher's Pet is a single-teacher resource concierge. You describe what you need — a curriculum outcome, a topic, a class level — and the system searches your personal teaching resource catalogue, sequences matched resources into a lesson structure, identifies gaps in coverage, and (only when necessary) generates a markdown lesson plan to fill those gaps using the DeepSeek API. Every result carries a confidence score, every generated plan is explicitly marked as AI-generated, and everything is downloadable as a zip bundle with a built-in AI disclosure.

---

## Architecture Overview

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     MS Graph API     ┌──────────┐
│  GitHub Pages   │ ──────────────→ │ Cloudflare       │ ──────────────────→ │ OneDrive │
│  (frontend/)    │ ←────────────── │ Worker           │ ←────────────────── │ (Excel   │
│  index.html     │     JSON/zip    │ (worker.js)      │    catalogue +      │ catalogue│
└─────────────────┘                 │                  │    file downloads)  │ + files) │
                                    │ 5-agent pipeline │                     └──────────┘
                                     │ + Ops-Keelin QA   │
                                    │                  │     DeepSeek API
                                    │ Ops-Maker ──────→│ (lesson plan gen,
                                    │                  │  only on gap + flag)
                                    └──────────────────┘
```

The Worker runs a 5-agent pipeline on every query: **Manager** (orchestration) → **Researcher** (catalogue search + curriculumonline.ie fallback) → **Designer** (resource sequencing + gap spec) → **Maker** (DeepSeek lesson plan generation, conditional) → **Communicator** (markdown summary + zip bundle). **Ops-Keelin** (QA agent) validates every generated plan before the teacher sees it. All sessions are logged to the Excel audit sheet.

---

## Quick Start

### Prerequisites

- Cloudflare Workers account (`wrangler` CLI installed and authenticated)
- Microsoft Azure AD app registration with `Files.Read.All` and `Sites.Read.All` permissions (app-only)
- DeepSeek API key (for lesson plan generation; system works without it in catalogue-only mode)
- Gemini Flash API key (for catalogue population with vision-based tagging)
- Python 3.9+ with `pdfplumber`, `openpyxl`, `Pillow`

### Steps

1. **Set up Azure AD app registration**
   - Register an app in the Azure portal
   - Add Microsoft Graph API permissions: `Files.Read.All`, `Sites.Read.All`
   - Grant admin consent
   - Generate a client secret
   - Note: tenant ID, client ID, and client secret

2. **Configure wrangler secrets**
   ```bash
   cd worker
   wrangler secret put DEEPSEEK_API_KEY
   wrangler secret put MS_TENANT_ID
   wrangler secret put MS_CLIENT_ID
   wrangler secret put MS_CLIENT_SECRET
   wrangler secret put GEMINI_API_KEY
   ```

3. **Populate the Excel catalogue**
   ```bash
   python scripts/catalogue_populator.py
   ```
   This scans the `Teaching Resources/` OneDrive folder, extracts text from PDFs and PPTXs, runs Gemini Flash vision analysis on visual content, assigns curriculum tags, and writes `Catalogue.xlsx` with confidence scores. Output goes to `scripts/catalogue_output.xlsx` — upload this to `Teaching Resources/Catalogue.xlsx` on OneDrive.

4. **Deploy the Worker**
   ```bash
   cd worker
   npm install
   wrangler deploy
   ```

5. **Update the frontend**
   - Open `frontend/index.html`
   - Replace the `WORKER_URL` constant with your deployed Worker's URL
   - Deploy `frontend/` to GitHub Pages (or open locally)

6. **Open `frontend/index.html`** and start searching your catalogue.

---

## Project Structure

```
GitRepo/
├── agents/
│   ├── dev/                      # Dev team agent definitions
│   │   ├── architect.md          #   System design & architecture
│   │   ├── maker.md              #   Code generation
│   │   ├── communicator.md       #   Documentation & disclosure
│   │   ├── manager.md            #   Orchestration & quality gate
│   │   └── keelin.md             #   Dev-Keelin (deployment security QA)
│   ├── ops/                      # Ops team agent definitions
│   │   ├── manager.md            #   Session orchestration
│   │   ├── researcher.md         #   Catalogue search + fallback
│   │   ├── designer.md           #   Resource sequencing
│   │   ├── maker.md              #   Lesson plan generation
│   │   ├── communicator.md       #   Summary & bundling
│   │   └── keelin.md             #   Ops-Keelin (content validation QA)
├── frontend/
│   └── index.html                # Web UI (search, browse, bundle download)
├── scripts/
│   └── catalogue_populator.py    # Scan OneDrive, build Excel catalogue
├── taxonomy/
│   ├── 1999_skeleton.json        # Irish Primary Curriculum (1999) structure
│   ├── language.json             # Primary Language Curriculum (2019) outcomes
│   ├── maths.json                # Primary Maths Curriculum (2023) outcomes
│   └── ufli.json                 # UFLI Foundations scope & sequence
├── worker/
│   ├── worker.js                 # Cloudflare Worker (1,390 lines)
│   ├── wrangler.toml             # Worker configuration
│   └── package.json              # Dependencies (jszip)
├── index.html                    # Root-level stub (frontend moved to frontend/)
├── pipeline_thoughts.html        # Full design journey & development narrative
├── CATALOGUE.md                  # Teaching resource catalogue documentation
├── GOVERNANCE.md                 # Governance framework (Stilgoe et al. 2013)
├── AI_DISCLOSURE.md              # AI disclosure (appended to every bundle)
├── README.md                     # This file
└── .gitignore
```

---

## CA3 Context

Built for **CA3 Final Project**, **H9CEAI Customer Engagement & Artificial Intelligence**, **National College of Ireland PGDip/MSc in AI for Business**, August 2026.

**This is a graded academic project, not a production service.** The code demonstrates the agentic organisation concept, responsible AI governance, AI disclosure practice, and engineering execution at the scale of a single postgrad project. It is not intended for classroom deployment without significant hardening (see Limitations below).

---

## Limitations

This is an honest list — the things this system does not do, and was not designed to do:

- **Single teacher only.** The catalogue is one teacher's private OneDrive. There is no multi-user support, no shared catalogue, no department-level resource pool.
- **No authentication.** The Worker and frontend are open. Anyone who knows the URL can query the catalogue. This is acceptable for a graded demo. A production deployment would require Azure AD auth at minimum.
- **No Gaeilge content generation.** LLMs are unreliable in Irish. The system matches and returns existing Irish-language catalogue resources but will not generate Irish-language lesson plans.
- **Text-based lesson plans only.** Generated content is markdown prose (structured lesson plans). The system does not generate worksheets, slide decks, images, activity sheets, or printable materials.
- **App-only MS Graph authentication.** The Worker uses client credentials (app-only), not delegated user permissions. It can access the entire OneDrive, not a scoped folder. This is a demo convenience.
- **Content exposed through Worker.** Catalogue metadata and extracted text are returned in API responses. In a production setting, access control at the row level and encryption at rest for extracted text would be required.
- **CurriculumOnline.ie scraping is fragile.** The fallback curriculum search parses HTML from a government website. HTML structure changes will break it. A pre-fetched curriculum dataset would replace this in production.
- **No offline support.** The system requires active internet connectivity for Worker, MS Graph, and DeepSeek API access.
- **No persistent Worker storage.** The Worker stores nothing between requests except an in-memory MS Graph token cache. Audit logs go to the Excel sheet. If the Worker cold-starts, the token cache is empty and a new token is fetched.

---

## Design Journey

For the full development narrative — the thinking behind the agentic organisation concept, the architecture decisions, the prompt engineering approach, the responsible AI trade-offs, and the iterative build process — see **[pipeline_thoughts.html](pipeline_thoughts.html)**.

---

## Module References

This project engages with the following module frameworks and authors:

- **Human-Centred AI** — Shneiderman (2022): explainable interfaces, reliable confidence scores, human control
- **Responsible Innovation** — Stilgoe, Owen & Macnaghten (2013): anticipation, reflexivity, inclusion, responsiveness
- **AI Ethics & Disclosure** — Coeckelbergh (2020): AI as a relational ethical problem, not a compliance checklist
- **AI in Creative Work** — del Rosal (2024), HUMANLIKE Ch 6: AI as a collaborative tool with human judgment at the centre
- **Trust in Automation** — Lee & See (2004): trust calibration through appropriate reliance, not blind trust or blanket rejection

These are operationalised in the governance framework (`GOVERNANCE.md`), the disclosure model (`AI_DISCLOSURE.md`), the QA agents' design (`agents/dev/keelin.md`, `agents/ops/keelin.md`), and the pipeline architecture (`worker/worker.js`).

---

*Teacher's Pet — CA3 Final Project, August 2026.*
