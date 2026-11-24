// @ts-check
/**
 * Mode `verify`: works out the version a pull request title asks for and checks that every
 * manifest file already holds it. Returns the outputs and log entries; it never prints.
 */

import { agreedVersion, describe, readVersions } from "./manifests.mjs";
import { matchesAny } from "./paths.mjs";
import {
  BASE_VERSION,
  bumpFor,
  nextVersion,
  pickLatestTag,
  tagFor,
  versionOf,
} from "./version.mjs";

const INFO = "info";
const NOTICE = "notice";
const NO_VERSION = "";
const LINE_SEPARATOR = "\n";

/** @typedef {import("./github.mjs").LogEntry} LogEntry */

/**
 * @param {{
 *   client: {
 *     listTagRefs(): Promise<{ ref: string }[]>,
 *     listPullFiles(number: number): Promise<string[]>,
 *   },
 *   workspace: string,
 *   files: string[],
 *   title: string | undefined,
 *   paths: string[],
 *   pullNumber: number | undefined,
 * }} options `paths` is the parsed list; an empty list means every change needs a version.
 * @returns {Promise<{ outputs: { version: string, tag: string }, log: LogEntry[] }>}
 */
export async function verify({ client, workspace, files, title, paths, pullNumber }) {
  if (paths.length > 0) {
    if (pullNumber === undefined) throw new Error("event payload has no pull_request.number");
    if (!matchesAny(await client.listPullFiles(pullNumber), paths)) {
      const text = "no release-worthy files changed, no version needed";
      return { outputs: { version: NO_VERSION, tag: NO_VERSION }, log: [{ level: NOTICE, text }] };
    }
  }
  if (!title?.trim()) throw new Error("pull request title missing");
  const refs = await client.listTagRefs();
  const latestTag = pickLatestTag(refs.map(({ ref }) => ref));
  const entries = readVersions(workspace, files);
  const expected = expectedVersion({ latestTag, title, entries });
  if (latestTag !== null) requireFilesAt(entries, expected);
  const tag = tagFor(expected);
  const log = [{ level: INFO, text: `expected ${tag} for title ${title}` }];
  return { outputs: { version: expected, tag }, log };
}

/**
 * @param {{ latestTag: string | null, title: string, entries: import("./manifests.mjs").ManifestEntry[] }} input
 * @returns {string}
 */
function expectedVersion({ latestTag, title, entries }) {
  if (latestTag === null && entries.length > 0) return firstVersion(entries);
  const current = latestTag === null ? BASE_VERSION : versionOf(latestTag);
  return nextVersion(current, bumpFor(title, current));
}

/** @param {import("./manifests.mjs").ManifestEntry[]} entries */
function firstVersion(entries) {
  try {
    return agreedVersion(entries);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`files must agree on the first version${LINE_SEPARATOR}${reason}`);
  }
}

/**
 * @param {import("./manifests.mjs").ManifestEntry[]} entries
 * @param {string} expected
 */
function requireFilesAt(entries, expected) {
  const lines = entries
    .filter(({ version }) => version !== expected)
    .map(({ file, version }) => `${file} has ${describe(version)}, set it to ${expected}`);
  if (lines.length > 0) throw new Error(lines.join(LINE_SEPARATOR));
}
