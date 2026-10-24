'use strict';

const { VERIFY_MODEL, VERIFY_EFFORT, VERIFY_MAX_TOKENS } = require('./constants');
const { buildContextSections } = require('./prompts');
const { requestReview, extractReviewJson } = require('./claude-client');

const VERIFY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'introduced_by_pr', 'reason'],
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['confirmed', 'rejected'] },
          introduced_by_pr: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const VERIFY_SYSTEM_PROMPT = `You are a skeptical senior engineer double-checking another reviewer's findings on a pull request before they are shown to the team. A false alarm costs the team's trust; your job is to catch them.

For each candidate finding, try to disprove it using the diff and the read-only context. The bar depends on severity.

CRITICAL and HIGH block the merge, so hold them to proof:
- "rejected" if the code does not behave as claimed, the failure needs conditions the code already prevents, the claim is speculative, it is a style preference, or it repeats a concern the team has already dismissed
- "confirmed" only if you can see the concrete failure in the code as written

MEDIUM and LOW are non-blocking advice. Their value is in pointing out risks, gaps, and side effects before they turn into bugs, so they do not need a demonstrated failure:
- "rejected" if it is factually wrong about the code (the case is already handled, the field or caller does not exist, the code does something else), it is a pure preference with no consequence (formatting, naming, ordering), or it repeats a concern the team has already dismissed
- "confirmed" if what it describes is true of the code and an author would reasonably want to know it, even when the impact depends on how the code is used

Separately, set "introduced_by_pr":
- true if the problem is caused by lines this PR added, changed, or deleted — including an unchanged caller that this PR's change newly breaks
- false if the problem would exist on the base branch without this PR: it lives in code the PR did not change and the PR does not make it newly reachable

Every diff line is prefixed with its new-file line number; removed lines have a blank number.

Return one verdict per candidate, using its "index". Keep each "reason" to one sentence. Return a single JSON object only.`;

function buildVerifyPrompt({ candidates, assembled, repoContext, learned }) {
  const items = candidates.map((issue, index) => ({
    index,
    severity: issue.severity,
    category: issue.category,
    file: issue.file,
    line_reference: issue.line_reference ?? null,
    title: issue.title,
    failure_mode: issue.failure_mode ?? null,
    description: issue.description,
  }));
  let prompt = `Candidate findings to verify:\n${JSON.stringify(items, null, 2)}\n\n`;
  prompt += buildContextSections({ repoContext, learned });
  prompt += `Diff (complete pull request, new-file line numbers in the left gutter):\n\`\`\`diff\n${assembled.text}\n\`\`\``;
  return prompt;
}

// Second opinion on brand-new findings only. Findings carried over from an
// earlier run were already shown to the team, so dropping them here would make
// a finding vanish without being fixed or dismissed.
//
// Fails open: if the verifier errors or skips a candidate, that candidate is
// kept. A broken second pass must never silently hide a real bug.
async function verifyFindings({ candidates, assembled, repoContext, learned = [], apiKey, fetchImpl, redact = (text) => text }) {
  if (!candidates.length) return { kept: [], rejected: [], verified: false };

  let verdicts;
  try {
    const data = await requestReview({
      apiKey,
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      userPrompt: redact(buildVerifyPrompt({ candidates, assembled, repoContext, learned })),
      model: VERIFY_MODEL,
      maxTokens: VERIFY_MAX_TOKENS,
      effort: VERIFY_EFFORT,
      schema: VERIFY_JSON_SCHEMA,
      fetchImpl,
    });
    const extracted = extractReviewJson(data);
    if (extracted.kind !== 'ok' || !Array.isArray(extracted.review?.verdicts)) {
      console.log(`Verification pass returned no verdicts (${extracted.kind}); keeping all ${candidates.length} new finding(s).`);
      return { kept: candidates, rejected: [], verified: false };
    }
    verdicts = extracted.review.verdicts;
  } catch (err) {
    console.log(`Verification pass failed (${err.message}); keeping all ${candidates.length} new finding(s).`);
    return { kept: candidates, rejected: [], verified: false };
  }

  const byIndex = new Map();
  for (const verdict of verdicts) {
    if (Number.isInteger(verdict?.index) && !byIndex.has(verdict.index)) byIndex.set(verdict.index, verdict);
  }

  const kept = [];
  const rejected = [];
  candidates.forEach((issue, index) => {
    const verdict = byIndex.get(index);
    if (!verdict) {
      kept.push(issue);
      return;
    }
    if (verdict.verdict === 'rejected') {
      rejected.push({ issue, reason: 'not_reproducible', note: verdict.reason });
    } else if (verdict.introduced_by_pr === false) {
      rejected.push({ issue, reason: 'pre_existing', note: verdict.reason });
    } else {
      kept.push(issue);
    }
  });
  return { kept, rejected, verified: true };
}

module.exports = {
  VERIFY_JSON_SCHEMA,
  VERIFY_SYSTEM_PROMPT,
  buildVerifyPrompt,
  verifyFindings,
};
