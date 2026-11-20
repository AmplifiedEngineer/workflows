// @ts-check
/**
 * Mode `prepare`: opens or updates the release pull request. It reads the manifest files from the
 * default branch head through the API, works out the next version, and puts the rewritten files
 * on the `release/next` branch. With `dryRun` it only reads and reports. It returns
 * `{ outputs, log }` and never writes to stdout.
 */

import { agreedVersion, replaceVersion } from "./manifests.mjs";
import {
  bumpFor,
  compareVersions,
  highestBump,
  nextVersion,
  pickLatestTag,
  tagFor,
  versionOf,
} from "./version.mjs";

export const RELEASE_BRANCH = "release/next";
export const FILE_MODE = "100644";
const BLOB_TYPE = "blob";
const INFO = "info";
const AUTO = "auto";
const VERSION_KEY = "version";
const NO_PULL_REQUEST = "";
const FILE_SEPARATOR = ", ";

/**
 * @typedef {{ level: "info" | "notice", text: string }} LogEntry
 * @typedef {{
 *   outputs: { version: string, tag: string, "pull-request": string },
 *   log: LogEntry[],
 * }} PrepareResult
 */

/**
 * @param {{
 *   client: ReturnType<typeof import("./github.mjs").createClient>,
 *   files: string[],
 *   bump: string,
 *   dryRun: boolean,
 *   defaultBranch: string,
 *   owner: string,
 * }} options `bump` is `auto` or an explicit `patch`, `minor` or `major`.
 * @returns {Promise<PrepareResult>}
 */
export async function prepare({ client, files, bump, dryRun, defaultBranch, owner }) {
  if (files.length === 0) throw new Error("prepare needs at least one version file");
  const refs = await client.listTagRefs();
  const latestTag = pickLatestTag(refs.map(({ ref }) => ref));
  if (latestTag === null) {
    throw new Error(`no release tag yet: merge to ${defaultBranch} to release the manifest version first`);
  }
  const latest = versionOf(latestTag);

  const head = await client.getBranchSha(defaultBranch);
  const texts = await Promise.all(files.map((file) => client.getFileText(file, head)));
  const current = agreedVersion(files.map((file, index) => ({ file, version: readVersion(texts[index]) })));
  if (compareVersions(current, latest) > 0) {
    throw new Error(
      `${files.join(FILE_SEPARATOR)} hold ${current}, which has no tag yet: let the release job finish first`,
    );
  }

  const next = nextVersion(latest, await chooseBump({ client, bump, latestTag, head }));
  const tag = tagFor(next);
  const title = `chore(release): ${tag}`;
  const updated = texts.map((text) => replaceVersion(text, current, next));

  if (dryRun) {
    const log = [
      ...files.map((file) => ({ level: INFO, text: `${file}: ${current} -> ${next}` })),
      { level: INFO, text: title },
    ];
    return { outputs: { version: next, tag, "pull-request": NO_PULL_REQUEST }, log };
  }

  const blobs = [];
  for (const text of updated) blobs.push(await client.createBlob(text));
  const baseTree = await client.getCommitTree(head);
  const entries = files.map((path, index) => ({ path, mode: FILE_MODE, type: BLOB_TYPE, sha: blobs[index] }));
  const tree = await client.createTree(baseTree, entries);
  const commit = await client.createCommit(title, tree, head);
  await client.setBranch(RELEASE_BRANCH, commit);
  const body = await client.generateNotes({ tag, target: head, previous: latestTag });

  const open = await client.findOpenPull(`${owner}:${RELEASE_BRANCH}`);
  const pull = open
    ? await client.updatePull(open.number, { title, body })
    : await client.createPull({ head: RELEASE_BRANCH, base: defaultBranch, title, body });
  return { outputs: { version: next, tag, "pull-request": pull.url }, log: [] };
}

/**
 * @param {{
 *   client: ReturnType<typeof import("./github.mjs").createClient>,
 *   bump: string,
 *   latestTag: string,
 *   head: string,
 * }} options
 * @returns {Promise<import("./version.mjs").Bump>}
 */
async function chooseBump({ client, bump, latestTag, head }) {
  if (bump !== AUTO) return /** @type {import("./version.mjs").Bump} */ (bump);
  const { titles } = await client.compareCommits(latestTag, head);
  const current = versionOf(latestTag);
  const highest = highestBump(titles.map((title) => bumpFor(title, current)));
  if (highest === null) throw new Error(`nothing to release since ${latestTag}`);
  return highest;
}

/**
 * @param {string} text
 * @returns {string | null} The top-level `version` when it is a string, otherwise null.
 */
function readVersion(text) {
  try {
    const value = JSON.parse(text)?.[VERSION_KEY];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
