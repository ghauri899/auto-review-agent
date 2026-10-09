'use strict';

const fs = require('node:fs');
const { INLINE_MARKER, DISMISS_RE, ISSUE_ID_RE, PATHS } = require('./constants');
const {
  dismissalKey,
  extractPayload,
  isCheckpointComment,
  parseNumberedDismissal,
  parseNumberedDismissals,
} = require('./shared');

function titleFromInline(body) {
  const match = (body || '').match(/\*\*(?:CRITICAL|HIGH):\s*(.+?)\*\*/);
  return match ? match[1].trim() : '';
}

function idFromInline(body) {
  const match = ISSUE_ID_RE.exec(body || '');
  return match ? parseInt(match[1], 10) : null;
}

function isBotLogin(login) {
  return !login || login.endsWith('[bot]');
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
  });
}

async function collectContext({ github, context, outputPath = PATHS.reviewContext }) {
  const emptyContext = {
    event_action: context.payload.action || '',
    sticky_comment_id: null,
    previous: null,
    dismissals: [],
    keep_inline: [],
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

    console.log(
      `Previous review: ${previous ? `yes (head ${previous.head_sha || 'unknown'}, run #${previous.run_count || '?'}, ${(previous.issues || []).length} issues)` : 'none'}; ` +
        `dismissals: ${emptyContext.dismissals.length}; kept inline threads: ${keepInline.length}`
    );
  } catch (err) {
    console.log(`Failed to collect previous review context: ${err.message}`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(emptyContext, null, 2));
  return emptyContext;
}

module.exports = {
  collectContext,
  extractPayload,
  titleFromInline,
  idFromInline,
  isBotLogin,
  isCheckpointComment,
};
