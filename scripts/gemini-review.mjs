#!/usr/bin/env node
// Tier 1 PR review using Gemini 2.0 Flash (free tier).
//
// Called by .github/workflows/reusable-gemini-advisory.yml in any consumer
// repo. Reads the PR diff, sends to Gemini with a structured response schema,
// posts (or updates) a sticky PR comment, toggles the `needs-deep-review`
// label based on Gemini's judgment.
//
// Privacy: strips diff hunks for paths matching `simulations/**` before
// sending to Gemini's free tier (Google trains on free-tier API data; the
// simulations/ directory contains real Swedish school data — see memory
// entries [[simulation_purpose]] and [[novaschem_roundtrip_export]]).
//
// Env (set by reusable-gemini-advisory.yml):
//   GEMINI_API_KEY  - from org-level GitHub Secret
//   GITHUB_TOKEN    - automatic from Actions
//   PR_NUMBER       - github.event.pull_request.number
//   REPO            - github.repository (e.g. "Simple-Schedules/Simple-Shedules")

const STICKY_MARKER = "<!-- gemini-advisory -->";
const MAX_DIFF_CHARS = 30_000;
const RETRY_DELAYS_MS = [1000, 4000, 16_000]; // 3 attempts before giving up.

// Model can be overridden via GEMINI_MODEL env. Default to gemini-2.5-flash:
// - gemini-2.0-flash: free-tier "limit: 0" for EU accounts (confirmed)
// - gemini-1.5-flash: 404'd as of 2026-05 (Google deprecated the alias)
// - gemini-2.5-flash: newest stable Flash with broadest free-tier coverage
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const RISKY_PATH_PATTERNS = [
  /^src\/solver\//,
  /^src\/stores\/useWizardStore\./,
  /^src\/components\/wizard\//,
  /^src\/app\/wizard\//,
  /^src\/components\/schedule\//,
  /^src\/app\/schedule\//,
  /^src\/stores\/db\//,
  /^src\/lib\/cloud\//,
  /^src\/lib\/license\//,
  /^supabase\/functions\//,
];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const GEMINI_API_KEY = env("GEMINI_API_KEY");
const GITHUB_TOKEN = env("GITHUB_TOKEN");
const PR_NUMBER = env("PR_NUMBER");
const REPO = env("REPO");
const [OWNER, REPO_NAME] = REPO.split("/");

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: init.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function fetchPrDiff() {
  const res = await gh(`/repos/${OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`, {
    headers: { Accept: "application/vnd.github.v3.diff" },
    accept: "application/vnd.github.v3.diff",
  });
  return res.text();
}

async function fetchPrMeta() {
  const res = await gh(`/repos/${OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}`);
  return res.json();
}

function stripSimulationsHunks(diff) {
  // Diff is a sequence of file blocks separated by "diff --git ...". For each
  // block whose path matches simulations/**, drop the entire block.
  const blocks = diff.split(/(?=^diff --git )/m);
  const kept = blocks.filter((b) => {
    const m = b.match(/^diff --git a\/(\S+) b\/(\S+)/m);
    if (!m) return true; // header chunk, keep
    return !/^simulations\//.test(m[1]);
  });
  return kept.join("");
}

function detectChangedRiskyPaths(diff) {
  const paths = new Set();
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  let m;
  while ((m = re.exec(diff)) !== null) {
    const path = m[2];
    if (RISKY_PATH_PATTERNS.some((rx) => rx.test(path))) paths.add(path);
  }
  return [...paths];
}

function truncateDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, truncated: false };
  return {
    diff: diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — original was " + diff.length + " chars]\n",
    truncated: true,
  };
}

async function callGemini(diff, prMeta, riskyPaths) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const systemInstruction = `You are a Tier 1 PR reviewer for a Next.js webapp called Simple Schedules. Your job is a fast first-pass review, not deep architectural critique. Be honest and terse.

Flag a PR as needs_deep_review=true if ANY of:
- It touches solver, wizard state, persistence (IDB/OPFS/cloud), auth, or payments
- Diff is >400 changed lines
- It adds a new file in src/components/ or src/lib/ (might duplicate existing)
- You see a likely bug, missed null check, race condition, or stale-closure
- It changes public API shape (function signatures, exports)

If the PR is clearly trivial (typo, dep bump, copy change), set needs_deep_review=false.

Be honest in the summary. No flattery, no padding. 3-5 bullet points max.`;

  const userPrompt = `PR #${PR_NUMBER}: "${prMeta.title}"

PR body:
${prMeta.body || "(empty)"}

Risky paths touched (precomputed): ${riskyPaths.length > 0 ? riskyPaths.join(", ") : "(none)"}

Diff:
\`\`\`diff
${diff}
\`\`\``;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "3-5 bullets describing what this PR does and any concerns." },
          needs_deep_review: { type: "boolean", description: "True if Tier 2 deep review is recommended." },
          reasoning: { type: "string", description: "Why needs_deep_review is true or false." },
        },
        required: ["summary", "needs_deep_review", "reasoning"],
      },
    },
  };

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini returned no text: " + JSON.stringify(data));
      return JSON.parse(text);
    }
    if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      console.error(`Gemini 429 (rate-limited), retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    throw new Error(`Gemini API failed: ${res.status} ${await res.text()}`);
  }
  throw new Error("Gemini retries exhausted");
}

function renderComment({ summary, needs_deep_review, reasoning, riskyPaths, truncated }) {
  const verdict = needs_deep_review
    ? "🔍 **Flagging for Tier 2 deep review.** Recommend `/pr-review` locally before merge."
    : "✅ Looks routine — no Tier 2 needed unless you disagree.";

  const riskySection = riskyPaths.length > 0
    ? `\n\n**Risky paths touched:** ${riskyPaths.map((p) => `\`${p}\``).join(", ")}`
    : "";

  const truncSection = truncated
    ? `\n\n_⚠️ Diff was truncated for review (too large)._`
    : "";

  return [
    STICKY_MARKER,
    "## Gemini Flash advisory review",
    "",
    summary,
    "",
    verdict,
    riskySection,
    truncSection,
    "",
    "<details><summary>Why this verdict?</summary>",
    "",
    reasoning,
    "",
    "</details>",
    "",
    "_Tier 1 of the [tiered AI review pipeline](https://github.com/Simple-Schedules/.github#dev-pipeline). For deeper review run `/pr-review` locally (free under Pro Max), or `/ultrareview` for the heavyweight pass._",
  ].join("\n");
}

async function postOrUpdateStickyComment(body) {
  const comments = await gh(`/repos/${OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments?per_page=100`).then((r) => r.json());
  const existing = comments.find((c) => c.body?.startsWith(STICKY_MARKER));
  if (existing) {
    await gh(`/repos/${OWNER}/${REPO_NAME}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    console.error(`Updated existing comment #${existing.id}`);
  } else {
    await gh(`/repos/${OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    console.error("Posted new comment");
  }
}

async function toggleLabel(needs_deep_review) {
  const label = "needs-deep-review";
  if (needs_deep_review) {
    await gh(`/repos/${OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [label] }),
    });
    console.error(`Added label: ${label}`);
  } else {
    // Remove if present; ignore 404.
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO_NAME}/issues/${PR_NUMBER}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (res.ok) console.error(`Removed label: ${label}`);
    else if (res.status !== 404) console.error(`Label remove failed: ${res.status}`);
  }
}

async function postFailureComment(reason) {
  const body = [
    STICKY_MARKER,
    "## Gemini Flash advisory review",
    "",
    `⚠️ Could not generate review: ${reason}`,
    "",
    "Rerun manually: \`gh workflow run gemini-advisory.yml\`",
    "",
    "Or proceed with manual review (`/pr-review` locally).",
  ].join("\n");
  await postOrUpdateStickyComment(body);
}

async function main() {
  console.error(`Reviewing ${REPO} PR #${PR_NUMBER}...`);
  let prMeta, diff;
  try {
    [prMeta, diff] = await Promise.all([fetchPrMeta(), fetchPrDiff()]);
  } catch (err) {
    console.error("Failed to fetch PR data:", err.message);
    process.exit(1);
  }

  const sanitized = stripSimulationsHunks(diff);
  const riskyPaths = detectChangedRiskyPaths(diff);
  const { diff: truncatedDiff, truncated } = truncateDiff(sanitized);

  console.error(`Diff: ${diff.length} chars (${sanitized.length} after strip, ${truncatedDiff.length} after truncate)`);
  console.error(`Risky paths: ${riskyPaths.length ? riskyPaths.join(", ") : "(none)"}`);

  let result;
  try {
    result = await callGemini(truncatedDiff, prMeta, riskyPaths);
  } catch (err) {
    console.error("Gemini call failed:", err.message);
    await postFailureComment(err.message);
    process.exit(0); // exit 0: advisory failure shouldn't fail the workflow.
  }

  // If we precomputed risky paths and Gemini says routine, still flag.
  const finalNeedsDeepReview = result.needs_deep_review || riskyPaths.length > 0;
  if (finalNeedsDeepReview !== result.needs_deep_review) {
    console.error(`Overriding Gemini judgment: risky paths force needs_deep_review=true`);
  }

  const body = renderComment({
    summary: result.summary,
    needs_deep_review: finalNeedsDeepReview,
    reasoning: result.reasoning + (finalNeedsDeepReview !== result.needs_deep_review ? "\n\n_(Override: risky paths touched force Tier 2 review.)_" : ""),
    riskyPaths,
    truncated,
  });

  await postOrUpdateStickyComment(body);
  await toggleLabel(finalNeedsDeepReview);
  console.error("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
