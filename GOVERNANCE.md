# Governance Framework — Teacher's Pet v1.0

**Project:** Teacher's Pet — Agentic Resource Curation for Irish Primary Teachers  
**Context:** CA3 Final Project, H9CEAI Customer Engagement & AI, NCI PGDip/MSc AI for Business, August 2026  
**Framework:** Stilgoe, Owen & Macnaghten (2013) Responsible Innovation; Shneiderman (2022) Human-Centered AI

---

## Disclosure Policy

Teacher's Pet operates under a layered transparency model. What users are told about AI involvement:

| Layer | Mechanism | What the Teacher Sees |
|---|---|---|
| **Bundle README** | `AI_DISCLOSURE.md` appended verbatim to every downloadable zip bundle | Full disclosure of which AI models were used, how they were used, what their limitations are, and a reminder that the teacher remains the pedagogical decision-maker |
| **Web UI** | Visible badge (`[AI-Generated]`) on every AI-produced lesson plan card in the frontend | Immediate, visible distinction between catalogue resources and AI-generated content — no buried disclosure |
| **API responses** | `POST /api/query` returns `confidence` fields on every catalogue match and every `generated[]` entry | Structured, machine-readable confidence scores (0.0–1.0) on every item, enabling the UI to render appropriate trust indicators |
| **Excel catalogue** | `ai_generated` column (boolean) in the Catalogue worksheet | Teacher browsing the catalogue directly in Excel sees whether each resource was AI-tagged or author-provided |

This model satisfies Shneiderman's (2022) requirement that AI systems provide "explainable user interfaces and reliable confidence scores" as a foundation for trust. It also reflects the Week 3 module discussion of Coeckelbergh (2020): AI disclosure is not a one-time consent checkbox but an ongoing, multi-surface communication obligation.

**Limitation acknowledged:** This is a v1 disclosure model for a single-teacher deployment. A multi-user deployment would require per-user consent tracking, right-to-explanation mechanisms under GDPR Art 22, and explainability interfaces beyond static markdown badges. These are scoped out of the CA3 submission.

---

## Escalation Routes

Three named triggers with specific routes and response times. All routes log to the Excel audit sheet for traceability.

### Trigger 1: Generated Content Quality Concern

**What happens:** A teacher flags a generated lesson plan as poor quality (factual error, age-inappropriate, misaligned to curriculum outcome, structural flaw).

**Route:**
1. Teacher reports concern to Ops-Manager (via the frontend flag button — v1: manual, future: in-UI feedback widget).
2. Ops-Manager writes a `content_quality_flag` row to the Audit sheet with: run ID, plan title, specific concern description, timestamp, teacher assessment (keep / reject / needs-revision).
3. Flag is reviewed at the next governance cadence.
4. If a **pattern** is detected (3+ content quality flags within a single calendar month), the Ops-Maker system prompt is reviewed and adjusted, and the revised prompt is tested against the flagged queries before redeployment.

**Response time:** Reviewed at next monthly governance cadence. Emergency override: teacher can disable generation by removing `DEEPSEEK_API_KEY` from wrangler — the pipeline falls back to catalogue-only mode automatically.

### Trigger 2: Catalogue Tagging Error

**What happens:** A teacher identifies a resource as mis-tagged (wrong subject, wrong class level, wrong curriculum outcome code, misleading tags).

**Route:**
1. Teacher reports the error to Ops-Manager with: filename, current tag, proposed correction, reason.
2. Ops-Manager sets `review_flag = TRUE` and `review_reason` on the relevant catalogue row in the Excel workbook (via MS Graph API).
3. At the next governance cadence, the flagged row is reviewed by a human (the teacher or a designated colleague).
4. The corrected tag becomes the **canonical tag** going forward. The original tag is preserved in an audit log for traceability but is no longer used by the Researcher for matching.

**Response time:** Reviewed at next monthly governance cadence. Catalogue queries in the interim may return the resource with the existing (potentially incorrect) tags — the `review_flag` column is visible in the catalogue UI to warn the teacher that a row is under review.

### Trigger 3: API Failure or Service Degradation

**What happens:** The Cloudflare Worker returns 5xx errors, the MS Graph API token refresh cycle fails (401 after retry), the DeepSeek API returns persistent errors, or response latency exceeds 30 seconds.

**Route:**
1. Ops-Manager logs the failure to the Audit sheet with: timestamp, endpoint, HTTP status code, error message, affected run ID (if any).
2. The Dev-Manager agent is spun back up (re-invoked) to investigate the failure, diagnose the root cause, and produce a patch.
3. Patch is applied to `worker.js` and the Worker is redeployed via `wrangler deploy`.
4. If the failure is upstream (MS Graph API outage, DeepSeek API downtime), the system enters degraded mode: catalogue browse works from cached data, generation is disabled, and the frontend displays a status banner.

**Response time:** Ops-Manager logs within the same request cycle. Dev-Manager investigation initiated within 24 hours of detection. This escalation route acknowledges that in a v1 single-maintainer project, the "response time" is bounded by the developer's availability — this is a known limitation documented here honestly rather than hidden behind an unrealistic SLA.

---

## Review Cadence

**Frequency:** Monthly (minimum).

**Reviewer:** The teacher-operator (currently the sole user and maintainer). If the system expands to multiple teachers in a future version, a designated colleague or department head would serve as reviewer.

**Evidence reviewed at each cadence:**

1. **Audit sheet** — All rows since the last review, specifically:
   - Disagreement flags (content quality concerns, tagging errors)
   - Generation frequency (how many Maker invocations per month, per strand)
   - Confidence score trends (are average confidence scores rising as the catalogue matures, or plateauing below 0.6?)
   - Bundle delivery count and failure count

2. **Catalogue confidence distribution** — A snapshot from the Excel catalogue:
   - How many resources are still at 0.5 (folder-inferred only)?
   - How many have reached 0.7+ (text-parsed)?
   - How many have reached 0.9+ (deep-parsed with Gemini Flash vision analysis)?
   - This distribution drives a decision: do we continue populating the catalogue, or is the current coverage sufficient?

3. **Keelin QA failure logs** — Any lesson plans rejected by the QA agent during the month:
   - Hallucination rejections (plan referenced a non-existent catalogue file)
   - UFLI boundary violations (plan introduced sounds beyond the class's lesson range)
   - Paired-prompt bias test failures (EAL/dyslexia differentiation was not genuine)

4. **External dependency health** — Quick status check on:
   - Cloudflare Worker analytics (request count, error rate, latency p95)
   - MS Graph API token health (any 401 cycles?)
   - DeepSeek API availability and cost (any billing surprises?)
   - Gemini Flash API availability

**Output of each review:** A governance entry in the Review History table (below), plus any action items (prompt adjustment, catalogue re-tagging, dependency update, scope decision).

---

## Data Minimisation

Teacher's Pet v1 processes no pupil-level personal data or special-category data (as defined by GDPR Art 9). This is a deliberate design constraint, not an oversight.

**What the catalogue contains:**
- Resource metadata (filename, file path, file type, file size)
- Extracted text content (plain text from PDFs, PowerPoints, Word documents)
- Visual content metadata (Gemini Flash vision descriptions of images/slides)
- AI-assigned tags (subject, subdomain, class level, curriculum outcome codes, confidence scores)

**What teacher-authored queries may incidentally contain:**
Queries entered into the frontend search bar may include references to protected characteristics (e.g. "EAL-friendly activities", "dyslexia supports", "SEN resources for autism"). The system handles these as follows:

- Query text is used for catalogue search matching **in-memory only** during the request lifecycle.
- The audit session record stores the query text as part of the session log in the Excel Audit sheet. This is the only persistent record of the query.
- Keelin's paired-prompt bias test runs on the query text **in-memory** — the query is temporarily passed to the DeepSeek API twice (once with EAL/dyslexia/SEN tags, once without). Results are logged as pass/fail; the query text itself is not retained beyond the audit entry.
- No query text is stored in any database, analytics platform, or training corpus. The Worker has no persistent storage beyond the audit sheet.

**What this means for a future multi-user or pupil-data version:**
This section acts as a **trigger, not just a refusal**. If Teacher's Pet is extended to process pupil-level data, the following gates must be passed before any code touches that data:

1. **Signed Data Processing Agreement (DPA)** between the school and the data controller (the teacher/service operator).
2. **Data Protection Officer (DPO) review** — the school's DPO must review and approve the processing purpose, scope, and retention policy.
3. **Guardian consent** for every pupil under 16 (GDPR Art 8) — informed, specific, withdrawable consent from a parent or legal guardian.
4. **Full Data Protection Impact Assessment (DPIA)** (GDPR Art 35) — covering the nature, scope, context, and purposes of the processing; assessment of necessity and proportionality; risks to rights and freedoms; and measures to address those risks.

These gates are explicitly stated here, not skirted. The project brief is clear that v1 is teacher-facing only, and the governance framework treats any expansion into pupil data as a non-trivial regulatory event.

---

## EU AI Act Positioning (Regulation 2024/1689)

Teacher's Pet v1 is a **teacher-facing resource curation and generation tool**. It does not:

- Determine access to education or training opportunities (Annex III, point 3)
- Evaluate learning outcomes or make decisions about individual pupils (Annex III, point 3)
- Profile pupils, assess their performance, or route them into educational tracks
- Make automated decisions with legal or similarly significant effects (Art 22 GDPR / Art 6 AI Act)
- Operate as a biometric categorisation, emotion recognition, or social scoring system (Annex III, points 1, 2)

The system therefore sits at **limited risk** under the AI Act's four-tier classification. The only applicable obligation is **Article 50 — Transparency obligations for certain AI systems**:

- **Art 50(1):** Providers must ensure that AI systems intended to interact directly with natural persons are designed and developed in such a way that the persons concerned are informed that they are interacting with an AI system.  
  → Satisfied by: the visible `[AI-Generated]` badge in the web UI on every AI-produced lesson plan.

- **Art 50(4):** Deployers of an AI system that generates or manipulates text content shall disclose that the content has been artificially generated or manipulated.  
  → Satisfied by: the `AI_DISCLOSURE.md` appended to every bundle README, the `ai_generated` column in the Excel catalogue, and the `confidence` field on every API response.

Teacher's Pet does **not** fall within Annex III high-risk categories and does **not** trigger the obligations of Title III, Chapters 2–5 (risk management, data governance, technical documentation, record-keeping, transparency to deployers, human oversight, accuracy/robustness/cybersecurity).

**Honest caveat:** This positioning is the developer's good-faith assessment based on the AI Act text as adopted. It has not been reviewed by a qualified legal professional. In a production deployment, an Article 50 compliance review by the school's DPO would be appropriate. The simplicity of the v1 system — teacher-facing, no pupil data, no automated decisions — is a deliberate design choice that keeps compliance tractable at the CA3 scale.

---

## Review History

| Date | Reviewer | Findings | Actions Taken |
|---|---|---|---|
| TBD — Initial deployment review | TBD (Teacher-operator or CA3 assessor) | Initial governance review against Stilgoe et al. (2013) anticipation, reflexivity, inclusion, and responsiveness dimensions. Baseline audit of catalogue confidence distribution, generation frequency, and disclosure mechanisms. | Document governance triggers, escalation routes, and review cadence. Confirm AI Act Art 50 compliance. Confirm data minimisation position. |

---

> *"Governance never revisited is a statement, not a practice."*  
> — H9CEAI Customer Engagement & AI, Week 12 module material
