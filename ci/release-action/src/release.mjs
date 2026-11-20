// @ts-check
/**
 * Mode `release`: after a push to the default branch, make sure the tag and the GitHub release
 * for the version exist. It first repairs a release a failed earlier run left missing, then
 * tags and releases the manifest version (with files) or the version the commits ask for
 * (without files). It returns `{ outputs, log }` and never writes to stdout.
 */

import { agreedVersion, readVersions } from "./manifests.mjs";
import { bumpFor, highestBump, nextVersion, pickLatestTag, tagFor, versionOf } from "./version.mjs";

const NOTICE = "notice";
const STATUS_AHEAD = "ahead";
const STATUS_IDENTICAL = "identical";
const STATUS_BEHIND = "behind";
const STATUS_DIVERGED = "diverged";
const BASE_VERSION = "0.0.0";
const TAG_REF_PREFIX = "refs/tags/";
const TRUE = "true";
const FALSE = "false";

/**
 * @typedef {{ level: "info" | "notice", text: string }} LogEntry
 * @typedef {{ outputs: { version: string, tag: string, released: string }, log: LogEntry[] }} ReleaseResult
 */

/**
 * @param {{
 *   client: ReturnType<typeof import("./github.mjs").createClient>,
 *   workspace: string,
 *   files: string[],
 *   sha: string,
 * }} options `files` is the parsed list; an empty list means the version comes from the commits.
 * @returns {Promise<ReleaseResult>}
 */
export async function release({ client, workspace, files, sha }) {
  /** @type {LogEntry[]} */
  const log = [];
  const manifestVersion = files.length > 0 ? agreedVersion(readVersions(workspace, files)) : null;

  /** Tags whose release was already looked up or created, so each tag costs one lookup. */
  const checkedReleases = new Set();

  /**
   * @param {string} tag
   * @param {string} commit
   * @returns {Promise<boolean>} True when this call created the release.
   */
  async function ensureRelease(tag, commit) {
    if (checkedReleases.has(tag)) return false;
    checkedReleases.add(tag);
    if (await client.getRelease(tag)) return false;
    await client.createRelease({ tag, sha: commit });
    return true;
  }

  const refs = await client.listTagRefs();
  const latestTag = pickLatestTag(refs.map(({ ref }) => ref));
  const latestRef = latestTag ? refs.find(({ ref }) => ref === `${TAG_REF_PREFIX}${latestTag}`) : null;
  const latestCommit = latestRef ? await client.resolveTagCommit(latestRef) : null;
  const comparison = latestTag ? await client.compareCommits(latestTag, sha) : null;

  const repairable = comparison?.status === STATUS_AHEAD || comparison?.status === STATUS_IDENTICAL;
  const repaired =
    repairable && latestTag && latestCommit ? await ensureRelease(latestTag, latestCommit) : false;

  /**
   * @param {string} tag
   * @param {boolean} released
   * @param {LogEntry[]} [more]
   * @returns {ReleaseResult}
   */
  function finish(tag, released, more = []) {
    if (repaired && latestTag && tag !== latestTag) {
      log.push({ level: NOTICE, text: `created the missing release for ${latestTag}` });
    }
    log.push(...more);
    return { outputs: { version: versionOf(tag), tag, released: released ? TRUE : FALSE }, log };
  }

  /** @param {string} tag */
  async function createTagAndRelease(tag) {
    await client.createTagRef(tag, sha);
    await client.createRelease({ tag, sha });
  }

  if (manifestVersion !== null) {
    const tag = tagFor(manifestVersion);
    const existing = tag === latestTag ? latestRef : await client.getTagRef(tag);
    if (!existing) {
      await createTagAndRelease(tag);
      return finish(tag, true);
    }
    const commit = tag === latestTag ? latestCommit : await client.resolveTagCommit(existing);
    if (commit !== sha) {
      const alreadyReleased = { level: NOTICE, text: `${tag} is already released at ${commit}; nothing to release` };
      // A release repaired for this very tag counts as this run's work, so no notice then.
      const repairedThisTag = repaired && tag === latestTag;
      return finish(tag, repairedThisTag, repairedThisTag ? [] : [alreadyReleased]);
    }
    const created = await ensureRelease(tag, sha);
    return finish(tag, created || (repaired && tag === latestTag));
  }

  if (latestTag && comparison) {
    if (latestCommit === sha) return finish(latestTag, repaired);
    if (comparison.status === STATUS_DIVERGED) {
      throw new Error(`${latestTag} is not an ancestor of ${sha}; fix the tag before releasing`);
    }
    if (comparison.status === STATUS_BEHIND || comparison.status === STATUS_IDENTICAL || comparison.titles.length === 0) {
      const notAhead = { level: NOTICE, text: `${sha} is not ahead of ${latestTag}; nothing to release` };
      return finish(latestTag, repaired, [notAhead]);
    }
    const current = versionOf(latestTag);
    const bump = highestBump(comparison.titles.map((title) => bumpFor(title, current)));
    if (bump === null) throw new Error(`no commits to read a bump from between ${latestTag} and ${sha}`);
    const tag = tagFor(nextVersion(current, bump));
    await createTagAndRelease(tag);
    return finish(tag, true);
  }

  const bump = bumpFor(await client.getCommitTitle(sha), BASE_VERSION);
  const tag = tagFor(nextVersion(BASE_VERSION, bump));
  await createTagAndRelease(tag);
  return finish(tag, true);
}
