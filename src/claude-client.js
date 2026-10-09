'use strict';

const {
  CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  CLAUDE_FETCH_TIMEOUT_MS,
  CLAUDE_RETRY_ATTEMPTS,
} = require('./constants');

const REVIEW_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // No risk_level: it is max(severity) over the open ledger, which the code
  // derives. Asking for it let the model contradict the findings listed below it.
  required: ['summary', 'score', 'score_breakdown', 'score_rationale', 'issues'],
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'context'],
      properties: {
        verdict: { type: 'string' },
        context: { type: 'string' },
      },
    },
    score: { type: 'number' },
    score_breakdown: {
      type: 'object',
      additionalProperties: false,
      required: ['security', 'correctness', 'performance', 'maintainability', 'best_practices'],
      properties: {
        security: { type: 'number' },
        correctness: { type: 'number' },
        performance: { type: 'number' },
        maintainability: { type: 'number' },
        best_practices: { type: 'number' },
      },
    },
    score_rationale: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'severity',
          'category',
          'file',
          'line_reference',
          'title',
          'status',
          'failure_mode',
          'description',
          'fix',
        ],
        properties: {
          id: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          category: {
            type: 'string',
            enum: ['SECURITY', 'BUG', 'PERFORMANCE', 'DATA_INTEGRITY', 'BREAKING_CHANGE', 'BEST_PRACTICE'],
          },
          file: { type: 'string' },
          line_reference: { type: ['string', 'null'] },
          title: { type: 'string' },
          status: { type: 'string', enum: ['new', 'still_open', 'resolved'] },
          failure_mode: { type: ['string', 'null'] },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

function sleep(ms, waitImpl) {
  return waitImpl(ms);
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestReview({
  apiKey,
  systemPrompt,
  userPrompt,
  fetchImpl = fetch,
  waitImpl = defaultWait,
  attempts = CLAUDE_RETRY_ATTEMPTS,
  timeoutMs = CLAUDE_FETCH_TIMEOUT_MS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: CLAUDE_MAX_TOKENS,
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: REVIEW_JSON_SCHEMA },
          },
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        const errText = await response.text();
        lastError = new Error(`Anthropic API error ${response.status}: ${errText}`);
        if (attempt < attempts) {
          await sleep(1000 * 2 ** (attempt - 1), waitImpl);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errText}`);
      }

      return response.json();
    } catch (err) {
      const retryable = err.name === 'TimeoutError' || err.name === 'AbortError' || /API error (429|5\d\d)/.test(err.message);
      lastError = err;
      if (retryable && attempt < attempts) {
        await sleep(1000 * 2 ** (attempt - 1), waitImpl);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function parseReviewText(text) {
  const cleaned = String(text)
    .replace(/^```json\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Claude response was not valid JSON');
  }
}

function extractReviewJson(data) {
  if (data.stop_reason === 'refusal') {
    return { kind: 'refusal' };
  }

  const textBlock = data.content?.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error(
      `No text content in Claude response. stop_reason: ${data.stop_reason}, content: ${JSON.stringify(data.content)}`
    );
  }

  try {
    return { kind: 'ok', review: parseReviewText(textBlock.text) };
  } catch (err) {
    if (data.stop_reason === 'max_tokens') {
      return { kind: 'max_tokens' };
    }
    console.error('Failed to parse Claude response as JSON. Raw text:', textBlock.text);
    throw err;
  }
}

module.exports = {
  REVIEW_JSON_SCHEMA,
  requestReview,
  extractReviewJson,
  parseReviewText,
};
