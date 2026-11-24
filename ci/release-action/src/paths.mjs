// @ts-check
/**
 * The `paths` input: repo-relative path prefixes that make a change release-worthy. An empty
 * list means every change is.
 */

const LINE_BREAK = /\r?\n/;
const ROOT_PREFIX = "/";
const PARENT_SEGMENT = "..";

/**
 * @param {string} text one prefix per line, blank lines ignored
 * @returns {string[]}
 */
export function parsePaths(text) {
  const prefixes = text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const prefix of prefixes) {
    if (prefix.startsWith(ROOT_PREFIX) || prefix.includes(PARENT_SEGMENT)) {
      throw new Error(`paths entry ${prefix} must be relative to the repository root and must not contain ${PARENT_SEGMENT}`);
    }
  }
  return prefixes;
}

/**
 * @param {string[]} files repo-relative file paths
 * @param {string[]} prefixes
 * @returns {boolean} True when any file starts with any prefix.
 */
export function matchesAny(files, prefixes) {
  return files.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
}
