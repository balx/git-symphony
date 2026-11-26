// Reads a repository's history from the GitHub GraphQL API, in the same shape as git.js readRepo().
// Pure fetch: runs in browsers and Node.

const API = 'https://api.github.com/graphql';
const PAGE = 100;
const CONCURRENCY = 6; // GraphQL caps server time per minute; more just trips the secondary rate limit

/** "owner/repo", "github.com/owner/repo", "https://github.com/owner/repo.git", ... -> { owner, repo } */
export function parseRepo(input) {
  const m = String(input).trim().match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
  if (!m) throw new Error(`not a GitHub repository: "${input}" (expected owner/repo)`);
  return { owner: m[1], repo: m[2] };
}

// Area for the note choice. The API does not list a commit's files, so it comes from the subject:
// "builtin/add: fix" -> builtin, "feat(router): x" -> router, "deps: bump" -> deps, else ''.
export function areaFromSubject(subject) {
  const m = subject.match(/^([\w./-]+)(?:\(([^()\s]+)\))?!?:\s/);
  return m ? (m[2] || m[1]).split('/')[0] : '';
}

/** GraphQL history nodes -> commits as compose() takes them, oldest first, merges dropped. */
export function toCommits(nodes) {
  // Group people by GitHub login when the commit is linked to one, shown under their most used name.
  const key = (n) => (n.author?.user?.login ? `@${n.author.user.login}` : (n.author?.name || 'unknown').toLowerCase());
  const names = new Map();
  for (const n of nodes) {
    const k = key(n), name = n.author?.name || n.author?.user?.login || 'unknown';
    if (!names.has(k)) names.set(k, new Map());
    names.get(k).set(name, (names.get(k).get(name) || 0) + 1);
  }
  const display = new Map([...names].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  return nodes
    .filter((n) => n.parents.totalCount <= 1)
    .map((n) => ({
      hash: n.oid,
      time: Date.parse(n.committedDate) / 1000,
      author: display.get(key(n)),
      subject: n.messageHeadline,
      size: n.additions + n.deletions,
      dir: areaFromSubject(n.messageHeadline),
    }))
    .sort((a, b) => a.time - b.time); // stable, like git.js
}

const COMMIT_FIELDS = 'oid committedDate messageHeadline additions deletions parents { totalCount } author { name user { login } }';
const TAG_FIELDS = 'pageInfo { endCursor hasNextPage } nodes { name target { __typename ... on Tag { tagger { date } } ... on Commit { committedDate } } }';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(token, fetchImpl = globalThis.fetch) {
  return async function gql(query, variables, tries = 6) {
    for (let attempt = 1; ; attempt++) {
      let res, body;
      try {
        res = await fetchImpl(API, {
          method: 'POST',
          headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        body = await res.json().catch(() => null);
      } catch (e) {
        if (attempt >= tries) throw new Error(`network error talking to GitHub: ${e.message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401) throw new Error('GitHub rejected the token (401). Check that it is valid and not expired.');
      const limited = res.status === 403 || res.status === 429;
      if ((limited || res.status >= 500) && attempt < tries) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
        await sleep(Math.min(wait, 60000));
        continue;
      }
      if (!res.ok) throw new Error(body?.message || `GitHub API error: HTTP ${res.status}`);
      if (body.errors?.length) {
        const e = body.errors[0];
        if (e.type === 'RATE_LIMITED') throw new Error('GitHub API rate limit reached; try again in an hour.');
        if (e.type === 'NOT_FOUND') throw new Error('Repository not found (or the token cannot see it).');
        if (attempt < tries && /timeout|something went wrong/i.test(e.message)) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`GitHub API: ${e.message}`);
      }
      return body.data;
    }
  };
}

/**
 * Fetches the default branch's history and tags.
 * onProgress({ done, total }) reports commits fetched so far.
 * cached: an earlier result; returned as-is when the branch has not moved since.
 * Returns { name, head, commits, tags } (head = the commit the history was read at).
 */
export async function fetchRepo(input, token, { onProgress = () => {}, cached, fetch: fetchImpl } = {}) {
  if (!token) throw new Error('a GitHub token is needed (the GraphQL API does not allow anonymous requests)');
  const { owner, repo } = parseRepo(input);
  const gql = client(token, fetchImpl);

  const first = await gql(
    `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {
      name defaultBranchRef { target { ... on Commit { oid history(first: ${PAGE}) { totalCount nodes { ${COMMIT_FIELDS} } } } } }
      refs(refPrefix: "refs/tags/", first: 100) { ${TAG_FIELDS} } } }`,
    { owner, repo },
  );
  const r = first.repository;
  if (!r.defaultBranchRef) throw new Error('repository has no commits');
  const head = r.defaultBranchRef.target.oid, total = r.defaultBranchRef.target.history.totalCount;
  if (cached?.head === head) return cached;
  const pages = [r.defaultBranchRef.target.history.nodes];
  let done = pages[0].length;
  onProgress({ done, total });

  // History cursors are "<head oid> <offset>", so pages can be fetched in parallel. Pinning the
  // head oid keeps offsets stable even if someone pushes meanwhile.
  const historyQuery = `query($owner: String!, $repo: String!, $head: GitObjectID!, $after: String!) {
    repository(owner: $owner, name: $repo) { object(oid: $head) { ... on Commit { history(first: ${PAGE}, after: $after) { nodes { ${COMMIT_FIELDS} } } } } } }`;
  const offsets = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = ++next;
      const data = await gql(historyQuery, { owner, repo, head, after: `${head} ${offsets[i - 1] - 1}` });
      pages[i] = data.repository.object.history.nodes;
      done += pages[i].length;
      onProgress({ done, total });
    }
  };
  const tagsDone = (async () => {
    const tags = [];
    let page = r.refs;
    for (;;) {
      for (const t of page.nodes) {
        const date = t.target.__typename === 'Tag' ? t.target.tagger?.date : t.target.committedDate;
        if (date) tags.push({ name: t.name, time: Date.parse(date) / 1000 });
      }
      if (!page.pageInfo.hasNextPage) return tags;
      const d = await gql(
        `query($owner: String!, $repo: String!, $after: String!) { repository(owner: $owner, name: $repo) { refs(refPrefix: "refs/tags/", first: 100, after: $after) { ${TAG_FIELDS} } } }`,
        { owner, repo, after: page.pageInfo.endCursor },
      );
      page = d.repository.refs;
    }
  })();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));
  const nodes = pages.flat();
  if (nodes.length !== total) throw new Error(`GitHub returned ${nodes.length} of ${total} commits; please retry`);
  return { name: r.name, head, commits: toCommits(nodes), tags: await tagsDone };
}
