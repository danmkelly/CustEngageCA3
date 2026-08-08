# AI Disclosure — Teacher's Pet v1.0

**This document is appended to every bundle README.** It tells the teacher exactly what AI was used, how it was used, and what its limits are. It is written following the disclosure conventions discussed in the module (Week 3: Coeckelbergh 2020; Week 2: del Rosal 2024, HUMANLIKE Ch 6) — disclosure should be specific, traceable, and honest about limitations, not a blanket disclaimer.

---

## What AI Was Used

| AI System | Purpose | Interface |
|---|---|---|
| **DeepSeek** (deepseek-chat, chat completions API) | Agent reasoning (Manager, Researcher, Designer, Communicator) and lesson plan generation (Maker) | REST API via Cloudflare Worker |
| **Gemini Flash** (vision API) | Image-based resource tagging — analysing screenshots, slides, and visual content to improve catalogue metadata | REST API via `catalogue_populator.py` |
| **OpenCode** (Claude, via opencode CLI) | Development assistance — agent definitions, architecture design, Worker code generation, frontend building, taxonomy authoring, and governance document production | Local CLI tool |

**Developer's note on OpenCode usage:** OpenCode is the development orchestrator — it is not running in the deployed Worker. The Dev team agents (Architect, Maker, Communicator, Manager) were defined as system prompts and invoked through OpenCode during the build phase. The Dev-Manager's build log records which agent produced which artifact. All agent definition files (`.md` files in `agents/dev/`) are included in the submission so the assessor can review the prompting approach.

---

## How AI Was Used in Development

The **Dev team** — four AI agents with distinct roles — built the Teacher's Pet system:

| Agent | Role | What It Built |
|---|---|---|
| **Dev-Architect** | System design and architecture decisions | Architecture spec, component boundaries, handoff contracts between agents, technology selection, wrangler.toml configuration |
| **Dev-Maker** | Code generation | `worker.js` (Cloudflare Worker — all 1,390 lines of pipeline orchestration, MS Graph integration, DeepSeek API integration, zip bundle assembly), `frontend/index.html` (web UI), `scripts/catalogue_populator.py` (Excel catalogue builder) |
| **Dev-Communicator** | Documentation and disclosure | `README.md`, `GOVERNANCE.md`, `AI_DISCLOSURE.md`, `CATALOGUE.md`, agent definition files |
| **Dev-Manager** | Orchestration, quality gate, and build log | Assigns tasks to Dev agents, tracks build progress, maintains the build log, decides when a component is "done" |

**Dev-Keelin** — the deployment QA agent — and **Ops-Keelin** — the content QA agent — operate as distinct roles:

- Dev-Keelin: secret detection in source files, CORS configuration audit, MS Graph scope audit, `wrangler.toml` validation — blocks deployment on failure
- Ops-Keelin: lesson plan validation, hallucination detection, UFLI boundary enforcement, paired-prompt bias testing — blocks content from reaching the teacher on failure

All agent definition files are at `agents/dev/` and `agents/ops/`. The codebase was produced through iterative prompting: the developer described the requirement, the Dev team produced the implementation, Dev-Keelin reviewed it, and the cycle repeated until Dev-Keelin signed off.

This reflects the module's discussion of del Rosal (2024, HUMANLIKE Ch 6): AI as a collaborative tool in creative and knowledge work, where the human sets the brief, defines the constraints, and makes the final acceptance decision.

---

## How AI Was Used in Operation

The **Ops team** — six AI agents — runs on the Cloudflare Worker and executes the resource pipeline on every teacher query:

```
Teacher query → Manager → Researcher → Designer → [Maker] → Communicator → Bundle
                                                         ↑
                                                     Ops-Keelin (QA)
```

| Agent | Role | What It Does |
|---|---|---|
| **Ops-Manager** | Session orchestration | Classifies the UX mode (guided / freetext / browse), enforces pipeline order, logs every session to the audit sheet |
| **Ops-Researcher** | Catalogue search | Searches the Excel catalogue by outcome code, grade band, and keyword/freetext; produces a gap report for uncovered outcomes; falls back to curriculumonline.ie for external references |
| **Ops-Designer** | Resource sequencing | Assigns matched resources to lesson phases (warm-up / main activity / plenary); produces a structured Maker specification for identified gaps |
| **Ops-Maker** | Lesson plan generation | Invokes DeepSeek API to generate markdown lesson plans — **only when a catalogue gap is confirmed and no public resources fill it**; rate-limited to prevent duplicate generation |
| **Ops-Communicator** | Summary and bundling | Produces teacher-facing markdown summaries; assembles zip bundles with catalogue resources, generated plans, and the AI disclosure README |
| **Ops-Keelin** (QA) | Quality gate | Validates every generated lesson plan before it reaches the teacher: hallucination detection, UFLI boundary check, paired-prompt bias test for EAL/dyslexia differentiation |

**Key design principles in operation:**
- The Maker is **never** invoked without a confirmed catalogue gap (Researcher and Designer run first).
- The Maker is **never** invoked without a teacher's explicit or implicit request (guided mode with gaps, or `generate: true` flag).
- Ops-Keelin validates **every** generated plan. Rejected plans do not reach the teacher. Maximum 2 Maker attempts per plan before the gap is declared unfilled (Lee & See 2004 trust calibration).

---

## Confidence and Limitations

### Confidence Scoring

Every catalogue resource carries a confidence score:

| Score | Meaning | How It Was Assigned |
|---|---|---|
| **0.5** | Folder-inferred | Tag assigned by the folder name and file path alone. No content analysis. |
| **0.7+** | Text-parsed | PDF text extraction (`pdfplumber`) or PPTX text extraction was used to verify the tag. |
| **0.9+** | Deep-parsed | Gemini Flash vision analysis of page/slide content, plus text extraction. Multiple signals agree on the tag. |

The confidence score is visible in the web UI, in the Excel catalogue (`confidence` column), and in the API response for every matched resource. A resource at 0.5 is not wrong — it's unverified. The teacher is trusted to apply their own judgement.

### Known Limitations (Honest and Specific)

1. **No Irish-language generation.** LLMs (including DeepSeek) are unreliable in Irish. The system will not generate Gaeilge lesson plans or content. The Maker's scope boundary excludes Irish-language generation explicitly. Catalogue resources for Gaeilge are matched and returned, but no AI-generated Irish content will ever leave the pipeline.

2. **No worksheets, images, or printable activities.** The Maker produces markdown prose only — lesson plan descriptions, activity outlines, differentiation notes, assessment suggestions. The system does not generate PDFs, worksheets, slide decks, images, or any printable content. Teachers must create their own materials from the prose descriptions.

3. **Text-based lesson plans only.** Generated plans are structured markdown: learning objective, warm-up, main activity, plenary, differentiation, assessment check. There is no visual design, no layout, no formatting beyond markdown headings and lists.

4. **Single-teacher catalogue.** The system searches one teacher's private OneDrive collection. It has no access to shared school drives, department resources, or commercial platform catalogues (Twinkl, TPT). The value proposition is a privatised, personal catalogue — not a universal resource library.

5. **No authentication in v1.** The frontend and Worker are open. Anyone who knows the Worker URL can query the catalogue. This is acceptable for a CA3 demo but would be inappropriate for production. A production deployment would require Azure AD authentication, row-level access control, and per-user session management.

6. **CurriculumOnline.ie scraping is fragile.** The fallback search parses HTML from a government website. HTML changes will break it. In production, a pre-fetched curriculum dataset would replace live scraping.

7. **App-only MS Graph authentication.** The Worker authenticates to MS Graph using client credentials (app-only), not delegated user permissions. This means the Worker can access the entire OneDrive, not just a scoped folder. This is a demo convenience, not a production security posture.

### Bias Testing (Ops-Keelin's Paired-Prompt Test)

When a teacher query includes EAL, dyslexia, SEN, autism, or similar needs-related tags, Ops-Keelin runs a paired-prompt bias test:

1. The Maker generation prompt is sent to DeepSeek **with** the needs tag.
2. An identical prompt **without** the needs tag is also sent.
3. Ops-Keelin compares the two outputs for structural differentiation — not just vocabulary substitution, but genuine differences in scaffolding, task complexity, support materials, and language level.

If the two outputs are functionally identical (the system didn't actually differentiate), the plan is rejected. This reflects the module's engagement with algorithmic bias and fairness: a system that claims to support diverse learners but produces identical outputs for all of them is not supporting diverse learners.

---

## The Teacher's Role

The teacher remains the pedagogical decision-maker. Teacher's Pet recommends and suggests; the teacher reviews, approves, rejects, and adapts.

Every bundle README includes the following statement, which the teacher is expected to read before using any generated or matched content:

> **"This bundle was assembled with AI assistance. All resources are from your personal catalogue unless marked [AI-Generated]. Please review all content before classroom use."**

This is not a disclaimer to evade responsibility — it is an honest description of the human-AI relationship in this system. Coeckelbergh (2020) argues that AI ethics is not about assigning blame but about designing relationships where humans retain meaningful agency. The teacher's role as the final pedagogical authority is a design principle, not an afterthought.

---

*Disclosure prepared in accordance with the module's responsible AI framework (H9CEAI Week 2, Week 3, Week 12). Last updated: August 2026.*
