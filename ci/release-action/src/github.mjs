// @ts-check
/**
 * Thin GitHub REST client for the release action. One function per call,
 * with the fetch implementation injected so tests never touch the network.
 * Only the 404 answers a caller can act on map to null; every other non-2xx
 * answer throws.
 */

const API_VERSION = "2022-11-28";
const API_VERSION_HEADER = "X-GitHub-Api-Version";
const GITHUB_MEDIA_TYPE = "application/vnd.github+json";
const JSON_MEDIA_TYPE = "application/json";
const LINK_HEADER = "link";
const NEXT_REL = "next";
const TAG_REFS_ENDPOINT = "git/matching-refs/tags/v";
const REFS_PATH = "/git/refs";
const PER_PAGE = 100;
const MAX_TAG_PAGES = 10;
const MAX_COMPARE_PAGES = 10;
const MAX_RELEASE_PAGES = 10;

const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const ANNOTATED_TAG = "tag";

/**
 * @typedef {{ ref: string, sha: string, type: string }} TagRef
 * @typedef {{ number: number, url: string }} Pull
 * @typedef {{ path: string, mode: string, type: string, sha: string }} TreeEntry
 * @typedef {{ status: number, headers: { get(name: string): string | null }, data: any }} Answer
 */

/**
 * @param {{ fetch: typeof fetch, apiUrl: string, token: string, repo: string }} options
 */
export function createClient({ fetch, apiUrl, token, repo }) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  /** Encodes each segment but keeps the slashes of a branch name or file path. */
  const encodePath = (/** @type {string} */ value) =>
    value.split("/").map(encodeURIComponent).join("/");
  const repoPath = `/repos/${encodePath(repo)}`;

  /**
   * @param {string} method
   * @param {string} target a path under the repository, or an absolute URL from a Link header
   * @param {unknown} [body]
   * @returns {Promise<Answer>}
   */
  async function send(method, target, body) {
    const isAbsolute = /^https?:\/\//.test(target);
    const url = isAbsolute ? target : `${baseUrl}${repoPath}${target}`;
    if (isAbsolute && new URL(url).origin !== new URL(baseUrl).origin) {
      throw new Error(`refusing to follow a link to another host: ${new URL(url).origin}`);
    }
    const path = url.slice(baseUrl.length);
    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: GITHUB_MEDIA_TYPE,
      [API_VERSION_HEADER]: API_VERSION,
    };
    /** @type {RequestInit} */
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = JSON_MEDIA_TYPE;
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    /** @type {any} */
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    throwIfFailed(method, path, response, data, text);
    return { status: response.status, headers: response.headers, data };
  }

  function throwIfFailed(
    /** @type {string} */ method,
    /** @type {string} */ path,
    /** @type {Response} */ response,
    /** @type {any} */ data,
    /** @type {string} */ text,
  ) {
    if (response.status >= 200 && response.status < 300) return;
    const message = data?.message ?? (text || response.statusText);
    const error = new Error(`GitHub API ${method} ${path} failed: ${response.status} ${message}`);
    Object.assign(error, { status: response.status });
    throw error;
  }

  /** Runs a call and turns a 404 into null. */
  async function orNull(/** @type {() => Promise<any>} */ call) {
    try {
      return await call();
    } catch (error) {
      if (/** @type {any} */ (error)?.status === NOT_FOUND) return null;
      throw error;
    }
  }

  /** GitHub answers a PATCH on a ref that does not exist with 404 or with 422 and this message. */
  function isMissingRef(/** @type {any} */ error) {
    return (
      error?.status === NOT_FOUND ||
      (error?.status === UNPROCESSABLE && /does not exist/i.test(error.message))
    );
  }

  /** @param {string | null} header */
  function nextLink(header) {
    if (!header) return null;
    for (const [, url, params] of header.matchAll(/<([^>]*)>([^,]*)/g)) {
      const rel = /;\s*rel="?([^";]+)"?/.exec(params)?.[1] ?? "";
      if (rel.split(/\s+/).includes(NEXT_REL)) return url;
    }
    return null;
  }

  /**
   * Collects every page of a list endpoint. Reaching the limit with a next
   * page still on offer throws, so a truncated list never gives a wrong answer.
   * @param {string} firstPath
   * @param {string} endpoint
   * @param {number} maxPages
   * @returns {Promise<any[]>}
   */
  async function paginate(firstPath, endpoint, maxPages) {
    const pages = [];
    /** @type {string | null} */
    let target = firstPath;
    while (target) {
      const answer = await send("GET", target);
      pages.push(answer.data);
      target = nextLink(answer.headers.get(LINK_HEADER));
      if (target && pages.length >= maxPages) {
        throw new Error(`${endpoint} has more than ${maxPages} pages; refusing to guess`);
      }
    }
    return pages;
  }

  const firstLine = (/** @type {string} */ message) => message.split("\n")[0].replace(/\r$/, "");

  /** @returns {TagRef} */
  const toTagRef = (/** @type {any} */ item) => ({
    ref: item.ref,
    sha: item.object.sha,
    type: item.object.type,
  });

  /** @returns {Pull} */
  const toPull = (/** @type {any} */ pull) => ({ number: pull.number, url: pull.html_url });

  return {
    /** @returns {Promise<TagRef[]>} */
    async listTagRefs() {
      const endpoint = TAG_REFS_ENDPOINT;
      const pages = await paginate(`/${endpoint}?per_page=${PER_PAGE}`, endpoint, MAX_TAG_PAGES);
      return pages.flat().map(toTagRef);
    },

    /** @returns {Promise<TagRef | null>} */
    async getTagRef(/** @type {string} */ tag) {
      const answer = await orNull(() => send("GET", `/git/ref/tags/${encodePath(tag)}`));
      return answer && toTagRef(answer.data);
    },

    /** Returns the commit SHA a tag entry points at, unwrapping an annotated tag. */
    async resolveTagCommit(/** @type {TagRef} */ entry) {
      if (entry.type !== ANNOTATED_TAG) return entry.sha;
      const answer = await send("GET", `/git/tags/${encodeURIComponent(entry.sha)}`);
      return /** @type {string} */ (answer.data.object.sha);
    },

    async createTagRef(/** @type {string} */ tag, /** @type {string} */ sha) {
      await send("POST", REFS_PATH, { ref: `refs/tags/${tag}`, sha });
    },

    /** Returns the release for a tag, drafts included, or null. */
    async getRelease(/** @type {string} */ tag) {
      const answer = await orNull(() => send("GET", `/releases/tags/${encodePath(tag)}`));
      if (answer) return answer.data;
      // The tag endpoint hides draft releases, so look for one in the full list.
      const pages = await paginate(`/releases?per_page=${PER_PAGE}`, "releases", MAX_RELEASE_PAGES);
      return pages.flat().find((/** @type {any} */ item) => item.tag_name === tag) ?? null;
    },

    async createRelease(/** @type {{ tag: string, sha: string }} */ { tag, sha }) {
      const answer = await send("POST", "/releases", {
        tag_name: tag,
        name: tag,
        target_commitish: sha,
        generate_release_notes: true,
      });
      return answer.data;
    },

    async getBranchSha(/** @type {string} */ branch) {
      const answer = await send("GET", `/git/ref/heads/${encodePath(branch)}`);
      return /** @type {string} */ (answer.data.object.sha);
    },

    async getCommitTree(/** @type {string} */ sha) {
      const answer = await send("GET", `/git/commits/${encodeURIComponent(sha)}`);
      return /** @type {string} */ (answer.data.tree.sha);
    },

    async getFileText(/** @type {string} */ path, /** @type {string} */ ref) {
      const answer = await send("GET", `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(answer.data.content, "base64").toString("utf8");
    },

    /** Reads only the first page, so a long history never reaches the page limit. */
    async compareStatus(/** @type {string} */ base, /** @type {string} */ head) {
      const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const answer = await send("GET", `/compare/${range}?per_page=1`);
      return /** @type {string} */ (answer.data.status);
    },

    /** @returns {Promise<{ status: string, titles: string[] }>} */
    async compareCommits(/** @type {string} */ base, /** @type {string} */ head) {
      const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const pages = await paginate(`/compare/${range}?per_page=${PER_PAGE}`, "compare", MAX_COMPARE_PAGES);
      const titles = pages.flatMap((page) => page.commits.map((/** @type {any} */ item) => firstLine(item.commit.message)));
      return { status: pages[0].status, titles };
    },

    async getCommitTitle(/** @type {string} */ sha) {
      const answer = await send("GET", `/commits/${encodeURIComponent(sha)}`);
      return firstLine(answer.data.commit.message);
    },

    async createBlob(/** @type {string} */ text) {
      const answer = await send("POST", "/git/blobs", { content: text, encoding: "utf-8" });
      return /** @type {string} */ (answer.data.sha);
    },

    async createTree(/** @type {string} */ baseTree, /** @type {TreeEntry[]} */ entries) {
      const answer = await send("POST", "/git/trees", { base_tree: baseTree, tree: entries });
      return /** @type {string} */ (answer.data.sha);
    },

    async createCommit(/** @type {string} */ message, /** @type {string} */ tree, /** @type {string} */ parent) {
      const answer = await send("POST", "/git/commits", { message, tree, parents: [parent] });
      return /** @type {string} */ (answer.data.sha);
    },

    /** Force-moves a branch to sha, creating it only when it does not exist. */
    async setBranch(/** @type {string} */ branch, /** @type {string} */ sha) {
      try {
        await send("PATCH", `/git/refs/heads/${encodePath(branch)}`, { sha, force: true });
        return;
      } catch (error) {
        if (!isMissingRef(error)) throw error;
      }
      await send("POST", REFS_PATH, { ref: `refs/heads/${branch}`, sha });
    },

    /** Returns the generated release notes text. */
    async generateNotes(/** @type {{ tag: string, target: string, previous?: string }} */ { tag, target, previous }) {
      const answer = await send("POST", "/releases/generate-notes", {
        tag_name: tag,
        target_commitish: target,
        ...(previous === undefined ? {} : { previous_tag_name: previous }),
      });
      return /** @type {string} */ (answer.data.body);
    },

    /** @returns {Promise<Pull | null>} */
    async findOpenPull(/** @type {string} */ headLabel) {
      const answer = await send("GET", `/pulls?state=open&head=${encodeURIComponent(headLabel)}&per_page=${PER_PAGE}`);
      return answer.data.length > 0 ? toPull(answer.data[0]) : null;
    },

    /** @returns {Promise<Pull>} */
    async createPull(/** @type {{ head: string, base: string, title: string, body: string }} */ { head, base, title, body }) {
      const answer = await send("POST", "/pulls", { head, base, title, body });
      return toPull(answer.data);
    },

    /** @returns {Promise<Pull>} */
    async updatePull(/** @type {number} */ number, /** @type {{ title: string, body: string }} */ { title, body }) {
      const answer = await send("PATCH", `/pulls/${number}`, { title, body });
      return toPull(answer.data);
    },
  };
}
