// @ts-check
/**
 * Release version rules: strict semver parsing, tag forms, the bump a pull request title asks
 * for, and picking the latest tag. A version is `X.Y.Z` and a tag is `vX.Y.Z`.
 */

const SEMVER_SOURCE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)`;
const SEMVER_REGEX = new RegExp(`^${SEMVER_SOURCE}$`);
const TAG_REGEX = new RegExp(`^v${SEMVER_SOURCE}$`);
const BREAKING_REGEX = /^[a-z]+(\([^)]*\))?!:/;
const FEATURE_REGEX = /^feat(\([^)]*\))?!?:/;
const TAG_REF_PREFIX = "refs/tags/";
const TAG_PREFIX = "v";
const NEWLINE = "\n";

export const MAJOR = "major";
export const MINOR = "minor";
export const PATCH = "patch";

/** @typedef {"major" | "minor" | "patch"} Bump */
/** @typedef {{ major: number, minor: number, patch: number }} Version */

/**
 * @param {string} text
 * @returns {Version | null} The parsed version, or null unless `text` is strict `X.Y.Z`.
 */
export function parseVersion(text) {
  const match = SEMVER_REGEX.exec(text);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  return { major, minor, patch };
}

/** @param {Version} version */
export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

/** @param {string} version */
export function tagFor(version) {
  return `${TAG_PREFIX}${version}`;
}

/**
 * @param {string} tag
 * @returns {string} The version inside a strict `vX.Y.Z` tag.
 */
export function versionOf(tag) {
  if (!TAG_REGEX.test(tag)) throw new Error(`${JSON.stringify(tag)} is not a vX.Y.Z tag`);
  return tag.slice(TAG_PREFIX.length);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when `a` is lower, zero when equal, positive when higher.
 */
export function compareVersions(a, b) {
  const left = requireVersion(a);
  const right = requireVersion(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * @param {string} title Only the first line is read.
 * @param {string} current The current version.
 * @returns {Bump}
 */
export function bumpFor(title, current) {
  const { major } = requireVersion(current);
  const firstLine = title.split(NEWLINE)[0];
  const breaking = BREAKING_REGEX.test(firstLine);
  if (breaking && major > 0) return MAJOR;
  if (breaking || FEATURE_REGEX.test(firstLine)) return MINOR;
  return PATCH;
}

/**
 * @param {Bump[]} bumps
 * @returns {Bump | null} The largest bump, or null for an empty list.
 */
export function highestBump(bumps) {
  if (bumps.includes(MAJOR)) return MAJOR;
  if (bumps.includes(MINOR)) return MINOR;
  return bumps.length > 0 ? PATCH : null;
}

/**
 * @param {string} current
 * @param {Bump} bump An explicit major gives the next major at any version.
 * @returns {string}
 */
export function nextVersion(current, bump) {
  const { major, minor, patch } = requireVersion(current);
  if (bump === MAJOR) return formatVersion({ major: major + 1, minor: 0, patch: 0 });
  if (bump === MINOR) return formatVersion({ major, minor: minor + 1, patch: 0 });
  if (bump === PATCH) return formatVersion({ major, minor, patch: patch + 1 });
  throw new Error(`unknown bump: ${bump}`);
}

/**
 * @param {string[]} refNames Full names such as `refs/tags/v0.9.0`.
 * @returns {string | null} The highest strict `vX.Y.Z` tag name, or null when there is none.
 */
export function pickLatestTag(refNames) {
  const tags = refNames
    .filter((ref) => ref.startsWith(TAG_REF_PREFIX))
    .map((ref) => ref.slice(TAG_REF_PREFIX.length))
    .filter((tag) => TAG_REGEX.test(tag));
  // Sort by number: a string sort would put v0.9.0 above v0.10.0.
  tags.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
  return tags[0] ?? null;
}

/**
 * @param {string} text
 * @returns {Version}
 */
function requireVersion(text) {
  const version = parseVersion(text);
  if (!version) throw new Error(`${JSON.stringify(text)} is not an X.Y.Z version`);
  return version;
}
