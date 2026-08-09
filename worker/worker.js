// ============================================================================
// TEACHER'S PET — Cloudflare Worker API Layer
// CA3 Final Project: Agentic Organisation for Teacher Resource Curation
// ============================================================================
// Architecture: The Worker serves 3 endpoints and orchestrates a 5-agent
// pipeline. Each agent is implemented as a set of pure-ish async functions
// with clear handoff boundaries. The pipeline enforces:
//   Researcher runs before Designer. Designer produces gap spec before Maker.
//   Maker is never invoked without a confirmed catalogue gap.
//   Every session is logged to the Excel audit sheet.
//
// Agents (in pipeline order):
//   Ops-Manager    -> classifies UX mode, orchestrates handoffs, logs sessions
//   Ops-Researcher  -> searches catalogue + curriculumonline.ie fallback
//   Ops-Designer    -> sequences resources, produces Maker spec for gaps
//   Ops-Maker       -> generates lesson plans via DeepSeek API (last resort)
//   Ops-Communicator -> produces summary markdown, assembles zip bundles
// ============================================================================

import JSZip from "jszip";
import { LANGUAGE_TAXONOMY, MATHS_TAXONOMY, UFLI_TAXONOMY } from "./taxonomy-data.js";

// --------------------------------------------------------------------------
// CONFIGURATION
// --------------------------------------------------------------------------

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
function msAuthUrl(tenant) {
  return "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/token";
}
const CURRICULUM_ONLINE_BASE = "https://www.curriculumonline.ie";
const CURRICULUM_READING_URL = CURRICULUM_ONLINE_BASE +
  "/Primary/Curriculum-Areas/Primary-Language/Reading/";
const DEEPSEEK_MODEL = "deepseek-chat";
const TOKEN_BUFFER_MS = 60000;
const RATE_LIMIT_MS = 60000;
const MAX_SEARCH_RESULTS = 20;

// --------------------------------------------------------------------------
// CORS HELPERS
// --------------------------------------------------------------------------
// Limitation: allow-origin * is permissive — suitable for demo/CA3 grading.
// Production deployments should restrict to known UI origin(s).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body, status) {
  if (!status) status = 200;
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign(
      { "Content-Type": "application/json" },
      CORS_HEADERS
    ),
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// --------------------------------------------------------------------------
// UTILITY HELPERS
// --------------------------------------------------------------------------

function generateRunId() {
  return crypto.randomUUID();
}

async function hashKey(input) {
  var encoder = new TextEncoder();
  var data = encoder.encode(input);
  var digest = await crypto.subtle.digest("SHA-256", data);
  var bytes = Array.from(new Uint8Array(digest));
  return bytes.map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

// --------------------------------------------------------------------------
// MS GRAPH AUTHENTICATION (Client Credentials Flow)
// --------------------------------------------------------------------------

var cachedToken = null;

/**
 * Obtain an OAuth2 token using client_credentials grant.
 * Caches the token in-memory until 60s before expiry.
 * @param {Object} env — Worker environment (secrets via wrangler secret put)
 * @param {boolean} force — Force token refresh even if cached token is valid
 */
async function getGraphToken(env, force) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.access_token;
  }

  var tenantId = env.MS_TENANT_ID;
  var clientId = env.MS_CLIENT_ID;
  var clientSecret = env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Missing MS Graph secrets. " +
      "Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET via wrangler secret put."
    );
  }

  var resp = await fetch(msAuthUrl(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });

  if (!resp.ok) {
    var body = await resp.text();
    throw new Error("MS Graph auth failed (" + resp.status + "): " + body);
  }

  var data = await resp.json();
  cachedToken = {
    access_token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.access_token;
}

// --------------------------------------------------------------------------
// MS GRAPH — Generic Authenticated Call
// --------------------------------------------------------------------------

/**
 * Authenticated GET/POST/PUT to Microsoft Graph.
 * Auto-retries once on 401 with forced token refresh.
 */
async function graphRequest(env, url, options) {
  if (!options) options = {};

  async function doFetch() {
    var token = await getGraphToken(env);
    var headers = Object.assign(
      {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      options.headers || {}
    );
    return fetch(url, Object.assign({}, options, { headers: headers }));
  }

  var resp = await doFetch();
  if (resp.status === 401) {
    await getGraphToken(env, true);
    resp = await doFetch();
  }
  return resp;
}

// --------------------------------------------------------------------------
// CATALOGUE — fetched from GitHub Pages (static JSON, no auth needed)
// Personal OneDrive doesn't support app-only Graph API, so we serve
// the catalogue as a static JSON file from GitHub Pages instead.
// --------------------------------------------------------------------------

/** In-memory cache of catalogue rows, loaded once per cold-start */
var catalogueCache = null;

/**
 * Fetch all catalogue rows from GitHub Pages JSON.
 * Returns an array of row objects.
 */
async function fetchCatalogue(env) {
  if (catalogueCache) return catalogueCache;
  
  var url = "https://danmkelly.github.io/CustEngageCA3/data/catalogue.json";
  var resp = await fetch(url);
  
  if (!resp.ok) {
    console.error("Catalogue fetch failed: " + resp.status);
    return [];
  }
  
  var data = await resp.json();
  catalogueCache = data.rows || [];
  console.log("[Catalogue] Loaded " + catalogueCache.length + " rows from GitHub Pages");
  return catalogueCache;
}

/**
 * Parse a 2D array from Excel usedRange into an array of row objects.
 * First row is the header (column names).
 */
function parseExcelRows(values) {
  if (!values || values.length < 2) return [];
  var headers = values[0].map(function (h) {
    return String(h || "").toLowerCase().trim();
  });
  return values.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) {
      obj[h] = row[i] !== undefined && row[i] !== null ? String(row[i]) : "";
    });
    return obj;
  });
}

// --------------------------------------------------------------------------
// MS GRAPH — Audit Logging
// --------------------------------------------------------------------------

/**
 * Post a session-log row to the Audit table in the Excel workbook.
 * The Audit sheet must contain a formatted Excel table named "Audit".
 * Non-fatal: session continues even if audit write fails.
 */
async function logToAuditSheet(env, auditRow) {
  try {
    var filePath = encodeURIComponent("Teaching Resources/Catalogue.xlsx");
    var url = MS_GRAPH_BASE + "/users/" + env.ONEDRIVE_USER + "/drive/root:" + filePath +
      ":/workbook/tables/Audit/rows";
    var resp = await graphRequest(env, url, {
      method: "POST",
      body: JSON.stringify({ values: [auditRow] }),
    });
    if (!resp.ok) {
      console.error(
        "[Audit] Write failed " + resp.status + ": " + await resp.text()
      );
    }
  } catch (err) {
    console.error("[Audit] Exception: " + err.message);
  }
}

// --------------------------------------------------------------------------
// MS GRAPH — File Download
// --------------------------------------------------------------------------

/**
 * Download a file from OneDrive as an ArrayBuffer.
 * @param {Object} env
 * @param {string} onedrivePath — relative path from Teaching Resources root
 */
async function downloadFromOneDrive(env, onedrivePath) {
  var encodedPath = encodeURIComponent(onedrivePath);
  var resp = await graphRequest(
    env,
    MS_GRAPH_BASE + "/users/" + env.ONEDRIVE_USER + "/drive/root:/Teaching Resources/" +
      encodedPath + ":/content"
  );
  if (!resp.ok) {
    throw new Error(
      "Failed to download \"" + onedrivePath + "\": " + resp.status
    );
  }
  return resp.arrayBuffer();
}

/**
 * Download a file from OneDrive using a delegated (user) access token.
 * Used when the frontend provides an MSAL token via Authorization header.
 * @param {string} delegatedToken — OAuth2 token from MSAL.js (delegated, Files.Read scope)
 * @param {string} onedrivePath — relative path from Teaching Resources root
 */
async function downloadFromOneDriveWithToken(delegatedToken, onedrivePath) {
  var encodedPath = encodeURIComponent(onedrivePath);
  var url = MS_GRAPH_BASE + "/me/drive/root:/Teaching Resources/" + encodedPath + ":/content";
  var resp = await fetch(url, {
    headers: { Authorization: "Bearer " + delegatedToken },
  });
  if (!resp.ok) {
    var errText = await resp.text();
    throw new Error(
      "Graph API " + resp.status + ": " + errText.substring(0, 200)
    );
  }
  return resp.arrayBuffer();
}

// --------------------------------------------------------------------------
// DEEPSEEK API INTEGRATION
// --------------------------------------------------------------------------

/**
 * Call the DeepSeek chat completions API.
 * @returns {string} Assistant message content as plain text/markdown.
 */
async function callDeepSeek(env, systemPrompt, userPrompt, temperature) {
  if (!temperature) temperature = 0.7;
  var apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY not set. Use: wrangler secret put DEEPSEEK_API_KEY"
    );
  }

  var resp = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: temperature,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    var errBody = await resp.text();
    throw new Error(
      "DeepSeek API error (" + resp.status + "): " + errBody
    );
  }

  var data = await resp.json();
  return data.choices && data.choices[0]
    ? data.choices[0].message.content
    : "";
}

// --------------------------------------------------------------------------
// RATE LIMITER (Simple Debounce)
// --------------------------------------------------------------------------
// Prevents repeated LLM calls with identical inputs within 60 seconds.
// In-memory Map keyed by SHA-256 hash of the input spec.

var rateLimitMap = new Map();

function isRateLimited(key) {
  var last = rateLimitMap.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return true;
  }
  rateLimitMap.set(key, Date.now());
  return false;
}

// --------------------------------------------------------------------------
// CURRICULUMONLINE.IE SCRAPING (Placeholder)
// --------------------------------------------------------------------------
// Lightweight HTML scraper for the Reading strand page. Demonstrates the
// fallback concept from the Researcher agent definition. Fragile against
// HTML changes — in production, use a pre-fetched curriculum dataset.

/**
 * Fetch curriculumonline.ie Reading strand page and extract outcome prose.
 * @returns {{code: string, prose: string}[]}
 */
async function fetchCurriculumOnlineOutcomes() {
  try {
    var resp = await fetch(CURRICULUM_READING_URL, {
      headers: { "User-Agent": "TeachersPet/1.0 (CA3 Academic Project)" },
    });
    if (!resp.ok) return [];

    var html = await resp.text();
    var outcomes = [];

    // Extract outcome content blocks — the site uses class names with
    // "outcome" patterns. Regex matches blocks containing outcome codes.
    var blockRegex = new RegExp(
      '<div[^>]*class="[^"]*outcome[^"]*"[^>]*>([\\s\\S]*?)</div>',
      'gi'
    );
    var codeRegex = new RegExp('\\b(?:TF|OL|W|R)\\d+[\\w.-]*\\b', 'g');
    var blockMatch;

    while ((blockMatch = blockRegex.exec(html)) !== null) {
      var blockText = blockMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (blockText.length < 20) continue;

      var codes = blockText.match(codeRegex);
      if (codes && codes.length > 0) {
        outcomes.push({ code: codes[0], prose: blockText });
      }
    }

    // Fallback: broad text extraction if no structured blocks found
    if (outcomes.length === 0) {
      var textContent = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      var codeMatches = textContent.match(codeRegex);
      if (codeMatches && codeMatches.length > 0) {
        outcomes.push({
          code: codeMatches[0],
          prose: "Extracted from curriculumonline.ie Reading strand page. " +
            codeMatches.length + " outcome code(s) detected in page text.",
        });
      }
    }

    return outcomes;
  } catch (err) {
    console.error("[CurriculumOnline] Fetch failed: " + err.message);
    return [];
  }
}
// ============================================================================
// AGENT: OPS-MANAGER
// ============================================================================
// Role: Session orchestration, UX mode classification, checkpoint enforcement.
// The Manager is the entry point for every query. It determines whether the
// session is guided or freetext and delegates to downstream agents.
//
// HANDOFF: Manager -> Researcher
//   Manager passes { mode, params } to Researcher for catalogue search.

/**
 * Classify the UX mode from query parameters.
 * - "guided": outcome_code or programme params are present
 * - "freetext": no structural curriculum params
 * - "browse": explicit browse mode
 * @param {Object} params
 * @returns {"guided"|"freetext"|"browse"}
 */
function classifyMode(params) {
  if (params.mode === "browse") return "browse";
  if (params.mode === "freetext") return "freetext";
  if (params.mode === "guided") return "guided";
  if (params.outcome_code || params.programme || params.grade_band) {
    return "guided";
  }
  return "freetext";
}

// ============================================================================
// AGENT: OPS-RESEARCHER
// ============================================================================
// Role: Catalogue search + gap analysis. For guided mode, filters by
// outcome_code and grade_band. For freetext mode, performs keyword/text
// matching across filename, subject, subdomain, extracted_text_sample, and
// tags. Produces a gap report for uncovered outcomes and attempts
// curriculumonline.ie fallback for gaps.
//
// HANDOFF: Researcher -> Designer
//   Researcher passes { matches, gaps, discovered } to Designer.

/**
 * Score a catalogue row against freetext query terms.
 * Searches filename, subject, subdomain, text sample, and tags.
 * @returns {number} 0—100 match score
 */
function scoreFreeText(row, queryTerms) {
  if (!queryTerms || queryTerms.length === 0) return 50;

  var searchFields = [
    row.filename || "",
    row.subject || "",
    row.subdomain || "",
    (row.extracted_text_sample || "").substring(0, 2000),
    (row.tags || "").replace(/,/g, " "),
  ];
  var haystack = searchFields.join(" ").toLowerCase();
  var totalScore = 0;
  var maxScore = queryTerms.length * 10;

  queryTerms.forEach(function (term) {
    var termLower = term.toLowerCase();
    var count = 0;
    var idx = 0;
    while ((idx = haystack.indexOf(termLower, idx)) !== -1) {
      count++;
      idx++;
    }
    totalScore += Math.min(count * 5, 10);
  });

  // Bonus for subject match
  queryTerms.forEach(function (term) {
    var subjectLower = (row.subject || "").toLowerCase();
    if (subjectLower.includes(term.toLowerCase())) {
      totalScore += 5;
    }
  });

  return Math.min(Math.round((totalScore / maxScore) * 100), 99);
}

/**
 * Researcher agent: search catalogue and curriculumonline.ie fallback.
 * @param {Object} env
 * @param {Object} params — from Manager (mode, query, outcome_code, etc.)
 * @returns {{ matches: Array, gaps: Array, discovered: Array }}
 */
async function opsResearcher(env, params) {
  var mode = params.mode || "freetext";
  var catalogue = await fetchCatalogue(env);

  var matches = [];
  var gaps = [];
  var discovered = [];

  // ── GUIDED / BROWSE MODE ──────────────────────────────────────────────
  if (mode === "guided" || mode === "browse") {
    var outcomeCode = (params.outcome_code || "").toLowerCase().trim();
    var gradeBand = (params.grade_band || "").toLowerCase().trim();

    if (outcomeCode || gradeBand) {
      // Normalize gradeBand: accept both stage codes (C1) and human-readable (Infants)
      var gradeBandNorm = "";
      if (gradeBand) {
        var gb = gradeBand.toLowerCase();
        if (gb === "c1" || gb.includes("infant")) gradeBandNorm = "c1";
        else if (gb === "c2" || gb.includes("1st") || gb.includes("first")) gradeBandNorm = "c2";
        else if (gb === "c3" || gb.includes("3rd") || gb.includes("third")) gradeBandNorm = "c3";
        else if (gb === "c4" || gb.includes("5th") || gb.includes("fifth")) gradeBandNorm = "c4";
        else gradeBandNorm = gb;
      }
      matches = catalogue.filter(function (row) {
        var rowOutcome = (row.outcome_code || "").toLowerCase();
        var rowGrade = (row.grade_band || "").toLowerCase();
        // Normalize row grade to stage code
        var rowGradeNorm = "";
        if (rowGrade.includes("infant")) rowGradeNorm = "c1";
        else if (rowGrade.includes("1st") || rowGrade.includes("first")) rowGradeNorm = "c2";
        else if (rowGrade.includes("3rd") || rowGrade.includes("third")) rowGradeNorm = "c3";
        else if (rowGrade.includes("5th") || rowGrade.includes("fifth")) rowGradeNorm = "c4";
        else rowGradeNorm = rowGrade;
        var outcomeMatch = !outcomeCode || rowOutcome.includes(outcomeCode);
        var gradeMatch = !gradeBandNorm || rowGradeNorm.includes(gradeBandNorm);
        return outcomeMatch && gradeMatch;
      });

      // Gap report for guided mode
      if (outcomeCode && matches.length === 0) {
        gaps.push({
          outcome_code: outcomeCode,
          description:
            "No catalogue resources matched outcome " +
            outcomeCode +
            " for grade band " +
            (gradeBand || "any") +
            ".",
          discovered: false,
        });
      } else if (outcomeCode && matches.length < 3) {
        gaps.push({
          outcome_code: outcomeCode,
          description:
            "Limited catalogue coverage: only " +
            matches.length +
            " resource(s) found for outcome " +
            outcomeCode +
            ".",
          discovered: false,
        });
      }

      // Fallback: outcome filtering found nothing — try text matching
      if (outcomeCode && matches.length === 0 && params.query) {
        var fbTerms = params.query.toLowerCase().replace(/[,.-]/g, " ").split(/\s+/).filter(function(t) { return t.length > 1; });
        var fbMatches = catalogue.filter(function(row) {
          var combined = ((row.subject || "") + " " + (row.subdomain || "") + " " + (row.extracted_text_sample || "")).toLowerCase();
          return fbTerms.some(function(t) { return combined.includes(t); });
        });
        if (fbMatches.length > 0) {
          matches = fbMatches.slice(0, MAX_SEARCH_RESULTS);
          gaps = []; // We found resources — clear the gap
        }
      }

      // curriculumonline.ie fallback for gaps
      if (gaps.length > 0) {
        var coOutcomes = await fetchCurriculumOnlineOutcomes();
        if (coOutcomes.length > 0) {
          discovered = coOutcomes.map(function (o) {
            return {
              code: o.code,
              prose: o.prose,
              source: "curriculumonline.ie",
            };
          });
          gaps.forEach(function (g) {
            g.discovered = discovered.length > 0;
          });
        }
      }
    }

    if (matches.length === 0 && !outcomeCode && !gradeBand) {
      matches = catalogue.slice(0, MAX_SEARCH_RESULTS);
    }
  }

  // ── FREETEXT MODE ─────────────────────────────────────────────────────
  if (mode === "freetext") {
    var queryStr = (params.query || "").trim();
    var queryTerms = queryStr
      .split(/\s+/)
      .filter(function (t) { return t.length > 1; });

    if (queryTerms.length === 0) {
      matches = catalogue.slice(0, MAX_SEARCH_RESULTS);
    } else {
      var scored = catalogue.map(function (row) {
        return { row: row, score: scoreFreeText(row, queryTerms) };
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      var best = scored
        .slice(0, MAX_SEARCH_RESULTS)
        .filter(function (s) { return s.score > 0; });

      if (best.length === 0) {
        gaps.push({
          outcome_code: "",
          description:
            'No catalogue resources matched query: "' +
            queryStr +
            '". Try different keywords or switch to guided mode with a specific outcome code.',
          discovered: false,
        });
      }

      matches = best.map(function (s) { return s.row; });
    }
  }

  // Truncate text_sample to keep responses manageable
  matches = matches.map(function (m) {
    var sample = (m.extracted_text_sample || "").substring(0, 500);
    return Object.assign({}, m, { extracted_text_sample: sample });
  });

  return { matches: matches, gaps: gaps, discovered: discovered };
}

// ============================================================================
// AGENT: OPS-DESIGNER
// ============================================================================
// Role: Structure a resource sequence from Researcher matches and produce a
// Maker specification for identified gaps. Maps matches into a three-part
// lesson structure (warm-up / main-activity / plenary) and creates a
// structured gap spec for Ops-Maker when catalogue resources are insufficient.
//
// HANDOFF: Designer -> Maker (conditional)
//   Designer passes makerSpec to Maker only if gaps exist AND generation
//   criteria are met (guided mode, no discovered resources, or teacher flag).

/**
 * Designer agent: produce resource sequence + Maker gap specification.
 * @returns {{ sequence: Array, makerSpec: Object|null }}
 */
function opsDesigner(matches, gaps, params) {
  var sequence = [];
  var gradeBand = params.grade_band || "";
  var outcomeCode = params.outcome_code || "";
  var query = params.query || "";

  // Resource sequencing — assign warm-up / main / plenary roles
  if (matches.length > 0) {
    if (matches.length === 1) {
      sequence.push({
        role: "main-activity",
        resource: {
          id: matches[0].id,
          filename: matches[0].filename,
          path: matches[0].onedrive_path,
          tags: matches[0].tags,
          rationale:
            "Only matching resource — recommended as the main activity for " +
            (outcomeCode || query),
        },
      });
    } else if (matches.length === 2) {
      sequence.push({
        role: "warm-up",
        resource: {
          id: matches[0].id,
          filename: matches[0].filename,
          path: matches[0].onedrive_path,
          tags: matches[0].tags,
          rationale: "Suitable warm-up/introductory activity",
        },
      });
      sequence.push({
        role: "main-activity",
        resource: {
          id: matches[1].id,
          filename: matches[1].filename,
          path: matches[1].onedrive_path,
          tags: matches[1].tags,
          rationale: "Core instructional activity aligned to outcome",
        },
      });
    } else {
      sequence.push({
        role: "warm-up",
        resource: {
          id: matches[0].id,
          filename: matches[0].filename,
          path: matches[0].onedrive_path,
          tags: matches[0].tags,
          rationale:
            "Introductory/warm-up to activate prior knowledge",
        },
      });
      sequence.push({
        role: "main-activity",
        resource: {
          id: matches[1].id,
          filename: matches[1].filename,
          path: matches[1].onedrive_path,
          tags: matches[1].tags,
          rationale:
            "Main instructional activity for outcome delivery",
        },
      });
      sequence.push({
        role: "plenary",
        resource: {
          id: matches[matches.length - 1].id,
          filename: matches[matches.length - 1].filename,
          path: matches[matches.length - 1].onedrive_path,
          tags: matches[matches.length - 1].tags,
          rationale:
            "Plenary/assessment check to consolidate learning",
        },
      });
    }
  }

  // Maker specification for identified catalogue gaps
  var makerSpec = null;
  if (gaps.length > 0) {
    var gap = gaps[0];
    makerSpec = {
      outcome_code: gap.outcome_code || outcomeCode,
      grade_band: gradeBand,
      description: gap.description,
      suggested_activity_type: outcomeCode
        ? mapOutcomeToActivity(outcomeCode)
        : "guided practice",
      programme: params.programme || "UFLI",
      query: query,
    };
  }

  return { sequence: sequence, makerSpec: makerSpec };
}

/**
 * Map an outcome code prefix to a suggested activity type.
 * Based on Irish PLC outcome verb conventions.
 */
function mapOutcomeToActivity(code) {
  var verbMap = {
    "TF4": "phonemic awareness drill",
    "TF5": "word sort and blending activity",
    "TF7": "dictation and writing practice",
    "TF9": "comprehension discussion",
    "OL1": "oral language game",
    "OL2": "structured discussion",
    "OL3": "paired talk activity",
    "R1":  "individual reading task",
    "R2":  "comprehension worksheet",
    "R3":  "reading response activity",
    "W1":  "writing task",
    "W2":  "editing and revision activity",
    "W3":  "genre writing activity",
  };
  var prefix = code.substring(0, 3).toUpperCase();
  return verbMap[prefix] || "guided practice activity";
}

// ============================================================================
// AGENT: OPS-MAKER
// ============================================================================
// Role: Generate lesson plans via DeepSeek API. Invoked ONLY when:
//   1. A gap exists in the catalogue (confirmed by Designer)
//   2. No discovered resources exist via curriculumonline.ie fallback
//   3. Mode is guided OR teacher explicitly requests generation (generate flag)
//
// Every generated plan carries: [AI-Generated | Not Classroom-Tested]
//
// HANDOFF: Maker -> Communicator
//   Maker passes { title, markdown, confidence } to Communicator for
//   inclusion in the summary and zip bundle.

const MAKER_SYSTEM_PROMPT =
  "You are Ops-Maker, the content generation agent for Teacher's Pet — " +
  "an AI teaching resource concierge for Irish primary teachers." +
  "\n\n" +
  "Your role: generate markdown lesson plans ONLY when the catalogue has " +
  "a confirmed gap. You are a last resort, not a first response." +
  "\n\n" +
  "Context:" + "\n" +
  "- Irish Primary Curriculum (PLC 2019 for Language, PMC 2023 for Mathematics)" + "\n" +
  "- UFLI Foundations scope and sequence (128 lessons) for phonics" + "\n" +
  "- Primary classroom realities: 30-40 minute lessons, mixed ability, " +
  "limited TA support" + "\n\n" +
  "Rules:" + "\n" +
  "1. Produce a structured markdown lesson plan with: Learning Objective, " +
  "Warm-Up (named catalogue resource if possible), Main Activity (prose " +
  "description with materials list), Plenary (named catalogue resource), " +
  "Differentiation (simpler/harder pathways), and Assessment Check." + "\n" +
  "2. Every plan MUST start with the badge: " +
  "[AI-Generated | Not Classroom-Tested]" + "\n" +
  "3. Use Irish curriculum terminology — not UK or US terms." + "\n" +
  "4. Never introduce phonemes beyond the specified UFLI lesson range." + "\n" +
  "5. Target 30-40 minutes total lesson duration." + "\n" +
  "6. Output valid markdown only — no JSON wrapper.";

/**
 * Maker agent: generate a lesson plan using DeepSeek API.
 * Rate-limited to prevent duplicate calls within 60s for the same spec.
 * @param {Object} env
 * @param {Object} makerSpec — from Designer
 * @returns {{ title: string, markdown: string, confidence: number }|null}
 */
async function opsMaker(env, makerSpec) {
  if (!makerSpec) return null;

  // Rate limit check (SHA-256 hash of the spec)
  var specKey = await hashKey(JSON.stringify(makerSpec));
  if (isRateLimited(specKey)) {
    console.log("[Maker] Rate limited — skipping duplicate generation");
    return {
      title: "Lesson Plan (" +
        (makerSpec.outcome_code || makerSpec.query) + ")",
      markdown:
        "_Generation skipped (duplicate request within 60s window)._",
      confidence: 0,
    };
  }

  var userPrompt = [
    "Generate a lesson plan for an Irish primary classroom.",
    "Learning Outcome: " + (makerSpec.outcome_code || "Not specified"),
    "Grade Band: " + (makerSpec.grade_band || "Not specified"),
    "Programme: " + (makerSpec.programme || "General"),
    "Suggested Activity Type: " + makerSpec.suggested_activity_type,
    "Gap Description: " +
      (makerSpec.description || "No catalogue resource available"),
    "",
    "Additional Context: " + (makerSpec.query || "N/A"),
    "",
    "Please produce a complete markdown lesson plan following the " +
      "structured format from your system prompt.",
  ].join("\n");

  try {
    var content = await callDeepSeek(env, MAKER_SYSTEM_PROMPT, userPrompt);

    return {
      title:
        "Lesson Plan — " +
        (makerSpec.outcome_code || "Generated Plan"),
      markdown: content,
      confidence: 0.7,
    };
  } catch (err) {
    console.error("[Maker] Generation failed: " + err.message);
    return {
      title:
        "Lesson Plan (" +
        (makerSpec.outcome_code || "Fallback") + ")",
      markdown:
        "[AI-Generated | Not Classroom-Tested]\n\n" +
        "**Generation failed**: " + err.message + "\n\n" +
        "**Gap**: " + (makerSpec.description || "Unknown"),
      confidence: 0,
    };
  }
}
// ============================================================================
// AGENT: OPS-COMMUNICATOR
// ============================================================================
// Role: Produce teacher-facing summary markdown. Converts pipeline outputs
// (matches, sequence, generated, gaps, discovered) into a clean markdown
// document suitable for the web UI and downloadable README.
//
// HANDOFF: (Maker or Designer) -> Communicator
//   Communicator is the final stage — it receives the full pipeline output
//   and formats it for teacher consumption.

/**
 * Build the teacher-facing summary markdown.
 * @returns {string} formatted markdown
 */
function buildSummaryMd(
  params,
  matches,
  sequence,
  generatedContent,
  gaps,
  discovered,
  runId
) {
  var lines = [];

  lines.push("# Teacher's Pet — Resource Package");
  lines.push("");
  lines.push("**Run ID:** " + runId);
  lines.push("**Query:** " + (params.query || "Catalogue browse"));
  lines.push("**Mode:** " + (params.mode || "freetext"));
  if (params.outcome_code) lines.push("**Outcome:** " + params.outcome_code);
  if (params.grade_band) lines.push("**Grade Band:** " + params.grade_band);
  if (params.programme) lines.push("**Programme:** " + params.programme);
  lines.push("");

  // ── Catalogue Matches ──────────────────────────────────────────────
  lines.push(
    "## Catalogue Resources (" + matches.length + " found)"
  );
  lines.push("");
  if (matches.length > 0) {
    lines.push(
      "| # | Filename | Subject | Subdomain | Confidence | Rationale |"
    );
    lines.push(
      "|---|----------|---------|-----------|------------|-----------|"
    );
    matches.slice(0, 10).forEach(function (m, i) {
      var seqEntry = sequence.find(function (s) {
        return s.resource && s.resource.id === m.id;
      });
      var rationale = seqEntry
        ? seqEntry.role + ": " + seqEntry.resource.rationale
        : "General catalogue match";
      lines.push(
        "| " + (i + 1) +
        " | " + (m.filename || "—") +
        " | " + (m.subject || "—") +
        " | " + (m.subdomain || "—") +
        " | " + (m.confidence || "0.5") +
        " | " + rationale + " |"
      );
    });
    if (matches.length > 10) {
      lines.push(
        "| ... | " + (matches.length - 10) +
        " more resources | | | | |"
      );
    }
  } else {
    lines.push("*No catalogue resources matched the query.*");
  }
  lines.push("");

  // ── Resource Sequence ──────────────────────────────────────────────
  if (sequence.length > 0) {
    lines.push("## Recommended Lesson Structure");
    lines.push("");
    sequence.forEach(function (entry) {
      lines.push(
        "### " + capitalize(entry.role) + ": " + entry.resource.filename
      );
      lines.push("- **Rationale:** " + entry.resource.rationale);
      lines.push("- **Tags:** " + (entry.resource.tags || "None"));
      lines.push("- **OneDrive path:** " + entry.resource.path);
      lines.push("");
    });
  }

  // ── Curriculum Gaps ────────────────────────────────────────────────
  if (gaps.length > 0) {
    lines.push("## Curriculum Gaps");
    lines.push("");
    gaps.forEach(function (g) {
      lines.push(
        "- **" + (g.outcome_code || "Query") + ":** " + g.description
      );
      if (g.discovered) {
        lines.push(
          "  - External resources found via curriculumonline.ie — " +
          "see *Discovered Content* below."
        );
      }
    });
    lines.push("");
  }

  // ── Discovered Content ─────────────────────────────────────────────
  if (discovered && discovered.length > 0) {
    lines.push("## Discovered Content (curriculumonline.ie)");
    lines.push("");
    discovered.forEach(function (d) {
      lines.push(
        "- **" + d.code + ":** " + d.prose.substring(0, 200)
      );
    });
    lines.push("");
  }

  // ── Generated Content ──────────────────────────────────────────────
  if (generatedContent && generatedContent.length > 0) {
    lines.push("## AI-Generated Content");
    lines.push("");
    generatedContent.forEach(function (g) {
      lines.push("### " + g.title);
      lines.push(
        "- **Confidence:** " + (g.confidence * 100).toFixed(0) + "%"
      );
      lines.push(
        "- **Status:** [AI-Generated | Not Classroom-Tested]"
      );
      lines.push("");
    });
  }

  // ── AI Disclosure Footer ───────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## AI Disclosure");
  lines.push("");
  lines.push(
    "This resource package was assembled by Teacher's Pet, an AI " +
    "teaching resource concierge system (CA3 Final Project, NCI PGDip " +
    "AI for Business)."
  );
  lines.push("");
  lines.push(
    "- **Catalogue resources** were matched from a teacher's private " +
    "OneDrive collection. They have not been AI-generated."
  );
  if (generatedContent && generatedContent.length > 0) {
    lines.push(
      "- **Generated lesson plans** were produced by DeepSeek " +
      "(deepseek-chat). These plans have NOT been classroom-tested. " +
      "Review all content before use."
    );
  }
  if (discovered && discovered.length > 0) {
    lines.push(
      "- **Discovered content** was extracted from curriculumonline.ie. " +
      "Verify against the official curriculum documents."
    );
  }
  lines.push(
    "- **Confidence scores** reflect catalogue metadata quality " +
    "(0 = auto-assigned, 1 = human-reviewed)."
  );
  lines.push("");

  return lines.join("\n");
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// ENDPOINT: POST /api/query
// ============================================================================
// Main orchestration endpoint. Executes the full agent pipeline:
//   Manager -> Researcher -> Designer -> (conditional) Maker -> Communicator
//
// Request:  { query, mode?, outcome_code?, grade_band?, programme?, generate? }
// Response: { summary_md, resources, generated, gaps, run_id }

async function handleQuery(request, env) {
  var body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  // Handle refinement requests: merge base_query with refinement_text
  if (body.type === "refine") {
    if (body.base_query) {
      body.query = body.base_query.query || "";
      body.outcome_code = body.base_query.outcome_code || body.outcome_code;
      body.subject = body.base_query.subject || body.subject;
      body.strand = body.base_query.strand || body.strand;
      if (body.base_query.stage) body.grade_band = body.base_query.stage;
      if (body.base_query.type) body.mode = body.base_query.type;
    }
    if (body.refinement_text) {
      body.query = (body.query || "") + " " + body.refinement_text;
    }
  }

  // Handle similarity search: use description as freetext query
  if (body.type === "similar") {
    body.query = body.description || body.resource_id || "";
    body.mode = "freetext";
    delete body.outcome_code;
    delete body.grade_band;
  }

  if (!body.query && !body.outcome_code && body.mode !== "browse") {
    return jsonResponse(
      { error: "Missing required field: query or outcome_code" },
      400
    );
  }

  var runId = generateRunId();
  var mode = classifyMode(body);
  var params = Object.assign({}, body, { mode: mode });

  // ── 1. OPS-MANAGER: classify and log session start ─────────────────
  console.log(
    "[Manager] Session " + runId +
    " | mode=" + mode +
    " | query=" + (body.query || "").substring(0, 80)
  );

  // ── 2. OPS-RESEARCHER: search catalogue + curriculumonline.ie ──────
  // HANDOFF: Manager -> Researcher
  var researchResult;
  try {
    researchResult = await opsResearcher(env, params);
  } catch (err) {
    console.error("[Researcher] Error: " + err.message);
    return jsonResponse(
      { error: "Catalogue search failed", detail: err.message },
      500
    );
  }

  var matches = researchResult.matches;
  var gaps = researchResult.gaps;
  var discovered = researchResult.discovered;

  // ── 3. OPS-DESIGNER: sequence resources + produce Maker spec ───────
  // HANDOFF: Researcher -> Designer
  var designResult = opsDesigner(matches, gaps, params);
  var sequence = designResult.sequence;
  var makerSpec = designResult.makerSpec;

  // ── 4. OPS-MAKER: generate lesson plans (CONDITIONAL) ──────────────
  // HANDOFF: Designer -> Maker (only if gap + no discovered + teacher flag)
  // Gate: Maker is never invoked before Researcher has run and Designer
  //       has confirmed a gap (enforced by the pipeline, per Manager.md).
  var generatedContent = [];
  var shouldGenerate =
    makerSpec &&
    (body.generate === true ||
      (mode === "guided" &&
        discovered.length === 0 &&
        gaps.length > 0));

  if (shouldGenerate) {
    console.log("[Manager] Invoking Maker for run " + runId);
    var plan = await opsMaker(env, makerSpec);
    if (plan) {
      generatedContent.push(plan);
    }
  }

  // ── 5. OPS-COMMUNICATOR: build summary ────────────────────────────
  // HANDOFF: Designer/Maker -> Communicator
  var summaryMd = buildSummaryMd(
    params,
    matches,
    sequence,
    generatedContent,
    gaps,
    discovered,
    runId
  );

  // ── 6. Build resources list for JSON response ─────────────────────
  var resources = matches.slice(0, 200).map(function (m) {
    var seqEntry = sequence.find(function (s) {
      return s.resource && s.resource.id === m.id;
    });
    return Object.assign({}, m, {
      path: m.onedrive_path || m.path,
      rationale: seqEntry
        ? seqEntry.resource.rationale
        : "Matched via catalogue search",
    });
  });

  // ── 7. Audit log (fire-and-forget, non-blocking) ──────────────────
  logToAuditSheet(env, [
    runId,
    new Date().toISOString(),
    (body.query || "").substring(0, 300),
    mode,
    "Manager,Researcher,Designer" +
      (generatedContent.length > 0 ? ",Maker" : "") +
      ",Communicator",
    String(matches.length),
    matches
      .slice(0, 5)
      .map(function (m) { return m.filename; })
      .join("; "),
    gaps.length > 0 ? String(gaps.length) : "0",
    generatedContent.length > 0 ? "yes" : "no",
  ]);

  return jsonResponse({
    summary_md: summaryMd,
    resources: resources,
    generated: generatedContent,
    gaps: gaps,
    run_id: runId,
  });
}

// ============================================================================
// ENDPOINT: POST /api/bundle
// ============================================================================
// Assembles a ZIP bundle containing:
//   - Selected catalogue resource files (downloaded from OneDrive via Graph)
//   - Generated lesson plans as .md files inside a "generated/" folder
//   - README.md with the full summary + AI disclosure footer
// Logs session to the Excel audit sheet (bundle delivered = yes).
//
// Request:  { resource_ids, generated_content?, summary_md, run_id }
// Response: application/zip with Content-Disposition header

async function handleBundle(request, env) {
  var body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!body.resource_ids || !Array.isArray(body.resource_ids)) {
    return jsonResponse(
      { error: "Missing required field: resource_ids (array)" },
      400
    );
  }

  // Accept include_ai_generated as alias for generated_content
  if (!body.generated_content && body.include_ai_generated && Array.isArray(body.include_ai_generated)) {
    body.generated_content = body.include_ai_generated.map(function (item) {
      return {
        title: item.title || item.id || "AI-Generated Plan",
        markdown: item.content || item.markdown || "",
      };
    });
  }

  var runId = body.run_id || generateRunId();

  // Extract delegated token from Authorization header (MSAL.js, for file downloads)
  var delegatedToken = null;
  var authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    delegatedToken = authHeader.substring(7);
    console.log("[Bundle] Delegated token provided — using for file downloads");
  }

  var catalogue;

  try {
    catalogue = await fetchCatalogue(env);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to fetch catalogue for bundle", detail: err.message },
      500
    );
  }

  // Build lookup: resource_id -> catalogue row
  var idMap = {};
  catalogue.forEach(function (row) {
    idMap[row.id] = row;
  });

  // Create ZIP using JSZip
  var zip = new JSZip();

  // ── Add resource files from OneDrive ────────────────────────────
  var fileFetchErrors = [];
  for (var i = 0; i < body.resource_ids.length; i++) {
    var resId = body.resource_ids[i];
    var row = idMap[resId];
    if (!row || !row.onedrive_path) {
      fileFetchErrors.push(
        "Resource " + resId + " not found in catalogue"
      );
      continue;
    }

    try {
      var fileData;
      if (delegatedToken) {
        fileData = await downloadFromOneDriveWithToken(delegatedToken, row.onedrive_path);
      } else {
        fileData = await downloadFromOneDrive(env, row.onedrive_path);
      }
      var cleanFilename = row.filename || ("resource-" + resId + ".pdf");
      if (!fileData || fileData.byteLength === 0) {
        fileFetchErrors.push("Empty file: " + row.onedrive_path);
        continue;
      }
      zip.file(cleanFilename, new Uint8Array(fileData));
    } catch (err) {
      fileFetchErrors.push(
        "Failed to download " + row.filename + " (" + row.onedrive_path + "): " + err.message
      );
    }
  }

  // ── Add generated lesson plans ──────────────────────────────────
  if (
    body.generated_content &&
    body.generated_content.length > 0
  ) {
    var generatedFolder = zip.folder("generated");
    body.generated_content.forEach(function (gen, idx) {
      var safeName =
        (gen.title || "lesson-plan-" + (idx + 1))
          .replace(/[^a-zA-Z0-9 _-]/g, "")
          .substring(0, 60)
          .trim() || "lesson-plan-" + (idx + 1);
      generatedFolder.file(safeName + ".md", gen.markdown || "");
    });
  }

  // ── README.md with AI disclosure ────────────────────────────────
  var bundleReadme =
    (body.summary_md || "# Teacher's Pet — Resource Bundle\n\n**Bundle assembled:** " + new Date().toISOString()) +
    "\n\n---\n" +
    "**Bundle assembled:** " + new Date().toISOString() + "\n" +
    "**Run ID:** " + runId + "\n" +
    "**Resources in bundle:** " + body.resource_ids.length + " file(s)\n" +
    (body.generated_content
      ? "**Generated plans included:** " +
        body.generated_content.length + "\n"
      : "") +
    (fileFetchErrors.length > 0
      ? "\n**Download warnings:**\n" +
        fileFetchErrors
          .map(function (e) { return "- " + e; })
          .join("\n")
      : "");

  zip.file("README.md", bundleReadme);

  // ── Generate ZIP blob ──────────────────────────────────────────
  var zipBlob = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // ── Audit log (fire-and-forget) ─────────────────────────────────
  logToAuditSheet(env, [
    runId,
    new Date().toISOString(),
    "BUNDLE",
    "bundle",
    "Communicator",
    String(body.resource_ids.length),
    body.resource_ids.join("; "),
    body.generated_content
      ? String(body.generated_content.length)
      : "0",
    "yes",
  ]);

  var filename =
    "teachers-pet-bundle-" + runId.substring(0, 8) + ".zip";
  return new Response(zipBlob, {
    status: 200,
    headers: Object.assign(
      {
        "Content-Type": "application/zip",
        "Content-Disposition":
          'attachment; filename="' + filename + '"',
      },
      CORS_HEADERS
    ),
  });
}

// ============================================================================
// ENDPOINT: POST /api/generate-lesson
// ============================================================================
// Generates a lesson plan via Ops-Maker on demand from the frontend gap card.
// Opposite of the /api/query pipeline: this is a direct Maker invocation.
//
// Request:  { outcome_code, outcome_label, stage }
// Response: { content, title, confidence }

async function handleGenerateLesson(request, env) {
  var body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  var outcomeCode = body.outcome_code || "";
  var outcomeLabel = body.outcome_label || "";
  var stage = body.stage || "";

  if (!outcomeCode && !outcomeLabel) {
    return jsonResponse(
      { error: "Missing outcome_code or outcome_label" },
      400
    );
  }

  var makerSpec = {
    outcome_code: outcomeCode,
    grade_band: stage,
    description:
      "No catalogue resource available for " +
      outcomeCode +
      (outcomeLabel ? " (" + outcomeLabel + ")" : ""),
    suggested_activity_type: mapOutcomeToActivity(outcomeCode),
    programme: "General",
    query: outcomeLabel,
  };

  try {
    var plan = await opsMaker(env, makerSpec);
    if (!plan) {
      return jsonResponse(
        { error: "Generation returned no content" },
        500
      );
    }
    return jsonResponse({
      content: plan.markdown,
      title: plan.title,
      confidence: plan.confidence,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Generation failed", detail: err.message },
      500
    );
  }
}

// ============================================================================
// ENDPOINT: GET /api/catalogue
// ============================================================================
// Returns the full Excel catalogue as JSON (array of objects with column-name
// keys). Truncates extracted_text_sample to 200 chars to keep response size
// manageable for the UI.

// ============================================================================
// TAXONOMY SERVING — serves the static taxonomy JSON files
// ============================================================================

/** In-memory cache of taxonomy files loaded at cold-start */
var taxonomyCache = null;

async function loadTaxonomyCache(env) {
  if (taxonomyCache) return taxonomyCache;
  taxonomyCache = {
    language: LANGUAGE_TAXONOMY,
    maths: MATHS_TAXONOMY,
    ufli: UFLI_TAXONOMY,
  };
  return taxonomyCache;
}

async function handleTaxonomy(request, env, name) {
  try {
    var cache = await loadTaxonomyCache(env);
    var data = cache[name];
    if (!data) {
      return jsonResponse({ error: "Taxonomy not found: " + name }, 404);
    }
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: "Failed to load taxonomy", detail: err.message }, 500);
  }
}

async function handleCatalogue(request, env) {
  try {
    var catalogue = await fetchCatalogue(env);

    var slim = catalogue.map(function (row) {
      var cleaned = {};
      Object.keys(row).forEach(function (key) {
        if (key === "extracted_text_sample") {
          cleaned[key] = (row[key] || "").substring(0, 200);
        } else {
          cleaned[key] = row[key];
        }
      });
      return cleaned;
    });

    return jsonResponse({
      total: slim.length,
      rows: slim,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to read catalogue", detail: err.message },
      500
    );
  }
}

// ============================================================================
// ROUTER — Main Worker Entry Point
// ============================================================================

export default {
  /**
   * Cloudflare Worker fetch handler.
   * Routes requests to the appropriate endpoint handler.
   * Wraps all handlers in try/catch for consistent JSON error responses.
   */
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    var url = new URL(request.url);
    var pathname = url.pathname;

    try {
      if (pathname === "/api/query" && request.method === "POST") {
        return await handleQuery(request, env);
      }

      if (pathname === "/api/bundle" && request.method === "POST") {
        return await handleBundle(request, env);
      }

      if (pathname === "/api/generate-lesson" && request.method === "POST") {
        return await handleGenerateLesson(request, env);
      }

      if (
        pathname === "/api/catalogue" &&
        request.method === "GET"
      ) {
        return await handleCatalogue(request, env);
      }

      if (
        pathname.startsWith("/api/taxonomy/") &&
        request.method === "GET"
      ) {
        var tname = pathname.split("/api/taxonomy/")[1];
        return await handleTaxonomy(request, env, tname);
      }

      // 404 for unmatched routes
      return jsonResponse(
        {
          error: "Not found",
          endpoints: [
            "POST /api/query",
            "POST /api/bundle",
            "POST /api/generate-lesson",
            "GET /api/catalogue", "GET /api/taxonomy/:name",
          ],
        },
        404
      );
    } catch (err) {
      console.error(
        "[Worker] Unhandled error: " +
        err.message +
        "\n" +
        (err.stack || "")
      );
      return jsonResponse(
        { error: "Internal server error", detail: err.message },
        500
      );
    }
  },
};
