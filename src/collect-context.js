'use strict';

const fs = require('node:fs');
const {
  INLINE_MARKER,
  REPLY_MARKER,
  DISMISS_RE,
  ISSUE_ID_RE,
  PATHS,
  MAX_LEARNED_DISMISSALS,
  TRUSTED_ASSOCIATIONS,
} = require('./constants');
const {
  cleanDismissReason,
  dismissLabel,
  normalizeTitle,
  dismissalKey,
  extractPayload,
  isCheckpointComment,
  parseNumberedDismissal,
  parseNumberedDismissals,
} = require('./shared');

function titleFromInline(body) {
  const match = (body || '').match(/\*\*(?:CRITICAL|HIGH|MEDIUM):\s*(?:\d+\.\s+)?(.+?)\*\*/);
  return match ? match[1].trim() : '';
}

function idFromInline(body) {
  const match = ISSUE_ID_RE.exec(body || '');
  return match ? parseInt(match[1], 10) : null;
}

function isBotLogin(login) {
  return !login || login.endsWith('[bot]');
}

// Whether a commenter's dismissal may teach Inspector G about OTHER pull
// requests. Anyone can dismiss a finding on the PR in front of them — that
// stays visible in the audit table — but only org members and collaborators
// get to set what the bot stops flagging repo-wide.
function isTrustedAssociation(association) {
  return TRUSTED_ASSOCIATIONS.includes(String(association || '').toUpperCase());
}

async function listReviewThreads(github, context) {
  const threads = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const data = await github.graphql(
      `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                isResolved
                comments(first: 50) {
                  nodes {
                    databaseId
                    body
                    path
                    author { login }
                    authorAssociation
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        number: context.issue.number,
        cursor,
      }
    );
    const connection = data.repository?.pullRequest?.reviewThreads;
    threads.push(...(connection?.nodes || []));
    hasNext = Boolean(connection?.pageInfo?.hasNextPage);
    cursor = connection?.pageInfo?.endCursor || null;
  }
  return threads;
}

function persistDismissal(map, item) {
  if (item?.id == null && !item?.file && !item?.title) return;
  map.set(dismissalKey(item), {
    id: item.id ?? null,
    file: item.file || '',
    title: item.title || '',
    reason: item.reason || 'persisted',
    reply: item.reply || '',
    by: item.by || '',
    trusted: Boolean(item.trusted),
  });
}

// Dismissals from other pull requests in this repo, read from their Inspector G
// checkpoint comments. Recent comments only (newest first, a few pages): the
// point is the team's current judgement, and one listing call per page keeps
// this cheap however many PRs the repo has.
async function collectLearnedDismissals({ github, context, pages = 3, limit = MAX_LEARNED_DISMISSALS }) {
  const currentIssueUrl = `/issues/${context.issue.number}`;
  const learned = [];
  const seen = new Set();
  for (let page = 1; page <= pages && learned.length < limit; page += 1) {
    const { data: comments } = await github.rest.issues.listCommentsForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      page,
    });
    for (const comment of comments || []) {
      if (!isCheckpointComment(comment)) continue;
      if (String(comment.issue_url || '').endsWith(currentIssueUrl)) continue;
      const payload = extractPayload(comment.body);
      const dismissedByKey = new Map((payload?.dismissed || []).map((item) => [dismissalKey(item), item]));
      for (const dismissal of payload?.dismissals || []) {
        if (!dismissal?.trusted) continue;
        const record = dismissedByKey.get(dismissalKey(dismissal)) || {};
        const title = dismissal.title || record.title || '';
        const key = normalizeTitle(title);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const reason = cleanDismissReason(dismissal.reply) || record.reason || '';
        learned.push({
          title,
          file: dismissal.file || record.file || '',
          label: record.label || dismissLabel(reason),
          reason,
        });
        if (learned.length >= limit) break;
      }
      if (learned.length >= limit) break;
    }
    if (!comments || comments.length < 100) break;
  }
  return learned;
}

async function collectContext({ github, context, outputPath = PATHS.reviewContext }) {
  const emptyContext = {
    event_action: context.payload.action || '',
    sticky_comment_id: null,
    previous: null,
    dismissals: [],
    keep_inline: [],
    learned_dismissals: [],
  };

  try {
    const issueComments = await github.paginate(github.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      per_page: 100,
    });

    const sticky = [...issueComments].reverse().find(isCheckpointComment);
    const previous = sticky ? extractPayload(sticky.body) : null;
    emptyContext.sticky_comment_id = sticky ? sticky.id : null;
    emptyContext.previous = previous;

    const dismissalsByKey = new Map();
    for (const dismissal of previous?.dismissals || []) persistDismissal(dismissalsByKey, dismissal);

    const issuesById = new Map((previous?.issues || []).filter((issue) => issue?.id != null).map((issue) => [Number(issue.id), issue]));
    const resolvedById = new Map((previous?.resolved || []).filter((item) => item?.id != null).map((item) => [Number(item.id), item]));

    for (const comment of issueComments) {
      if (isBotLogin(comment.user?.login)) continue;
      for (const numbered of parseNumberedDismissals(comment.body || '')) {
        const known = issuesById.get(numbered.id) || resolvedById.get(numbered.id) || {};
        persistDismissal(dismissalsByKey, {
          id: numbered.id,
          file: known.file || '',
          title: known.title || '',
          reason: 'numbered_comment',
          reply: numbered.reply,
          by: comment.user?.login || '',
          trusted: isTrustedAssociation(comment.author_association),
        });
      }
    }

    let threads = [];
    try {
      threads = await listReviewThreads(github, context);
    } catch (err) {
      console.log(`Could not list review threads (dismissals may be incomplete): ${err.message}`);
    }

    const keepInline = [];
    for (const thread of threads) {
      const comments = thread.comments?.nodes || [];
      const botComment = comments.find((comment) => (comment.body || '').includes(INLINE_MARKER));
      if (!botComment) continue;

      const humanReplies = comments.filter((comment) => {
        if (comment.databaseId === botComment.databaseId) return false;
        if ((comment.body || '').includes(INLINE_MARKER)) return false;
        if ((comment.body || '').includes(REPLY_MARKER)) return false;
        return !isBotLogin(comment.author?.login);
      });
      if (humanReplies.length === 0) continue;

      const title = titleFromInline(botComment.body);
      const file = botComment.path || '';
      const issueId = idFromInline(botComment.body);
      const dismissReply = humanReplies.find((comment) => {
        const body = comment.body || '';
        return DISMISS_RE.test(body) || Boolean(parseNumberedDismissal(body));
      });
      const dismissed = Boolean(dismissReply);
      if (dismissed) {
        persistDismissal(dismissalsByKey, {
          id: issueId,
          file,
          title,
          reason: 'human_reply',
          reply: String(dismissReply.body || '').slice(0, 500),
          by: dismissReply.author?.login || '',
          trusted: isTrustedAssociation(dismissReply.authorAssociation),
        });
      }

      keepInline.push({
        id: botComment.databaseId,
        issueId,
        file,
        title,
        dismissed,
      });
    }

    emptyContext.dismissals = [...dismissalsByKey.values()];
    emptyContext.keep_inline = keepInline;

    try {
      emptyContext.learned_dismissals = await collectLearnedDismissals({ github, context });
    } catch (err) {
      console.log(`Could not read dismissals from other pull requests: ${err.message}`);
    }

    console.log(
      `Previous review: ${previous ? `yes (head ${previous.head_sha || 'unknown'}, run #${previous.run_count || '?'}, ${(previous.issues || []).length} issues)` : 'none'}; ` +
        `dismissals: ${emptyContext.dismissals.length}; learned from other PRs: ${emptyContext.learned_dismissals.length}; kept inline threads: ${keepInline.length}`
    );
  } catch (err) {
    console.log(`Failed to collect previous review context: ${err.message}`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(emptyContext, null, 2));
  return emptyContext;
}

module.exports = {
  collectContext,
  collectLearnedDismissals,
  isTrustedAssociation,
  extractPayload,
  titleFromInline,
  idFromInline,
  isBotLogin,
  isCheckpointComment,
};
