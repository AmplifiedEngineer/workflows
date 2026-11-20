// @ts-check
/**
 * JSON manifest files that carry a release version: parsing the file list input, reading each
 * file's top-level `version`, checking that the files agree, and rewriting the version as text.
 */

import fs from "node:fs";
import path from "node:path";
import { parseVersion } from "./version.mjs";

const LINE_BREAK_REGEX = /\r?\n/;
const BACKSLASH = "\\";
const PARENT_SEGMENT = "..";
const CURRENT_SEGMENT = ".";
const EMPTY_SEGMENT = "";
const PATH_SEPARATOR = "/";
const ENCODING = "utf8";
const VERSION_KEY = "version";
const NO_VERSION = "no version";
const INVALID_VERSION = "invalid";

/** @typedef {{ file: string, version: string | null }} ManifestEntry */

/**
 * @param {string} input One workspace-relative path per line.
 * @returns {string[]} The trimmed, unique paths in order. Empty lines are dropped.
 */
export function parseFiles(input) {
  const files = input
    .split(LINE_BREAK_REGEX)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const file of files) requireWorkspacePath(file);
  return [...new Set(files)];
}

/**
 * @param {string} workspace
 * @param {string[]} files
 * @returns {ManifestEntry[]} `version` is null when the file is missing, is not JSON, or has no
 * string top-level `version`.
 */
export function readVersions(workspace, files) {
  return files.map((file) => ({ file, version: readVersion(path.join(workspace, file)) }));
}

/**
 * @param {ManifestEntry[]} entries
 * @returns {string} The strict `X.Y.Z` version every file shares.
 */
export function agreedVersion(entries) {
  if (entries.length === 0) throw new Error("no manifest files to read a version from");
  const lines = entries.map(({ file, version }) => `${file} has ${describe(version)}`);
  const versions = new Set(entries.map(({ version }) => version));
  const [shared] = versions;
  if (versions.size !== 1 || shared === null || !parseVersion(shared)) {
    throw new Error(lines.join("\n"));
  }
  return shared;
}

/**
 * Edits the text instead of re-serialising so indent, key order and line endings stay as they are.
 * @param {string} text
 * @param {string} from The current top-level version.
 * @param {string} to
 * @returns {string}
 */
export function replaceVersion(text, from, to) {
  const pattern = new RegExp(`("${VERSION_KEY}"\\s*:\\s*")${escapeRegex(from)}(")`, "g");
  const matches = text.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "${VERSION_KEY}": "${from}" but found ${matches.length}`);
  }
  const result = text.replace(pattern, (_match, open, close) => `${open}${to}${close}`);
  if (readTopLevelVersion(result) !== to) {
    throw new Error(`the "${from}" match is not the top-level "${VERSION_KEY}"`);
  }
  return result;
}

/** @param {string} file */
function requireWorkspacePath(file) {
  const segments = file.split(PATH_SEPARATOR);
  if (
    path.isAbsolute(file) ||
    file.includes(BACKSLASH) ||
    segments.includes(PARENT_SEGMENT) ||
    segments.includes(CURRENT_SEGMENT) ||
    segments.includes(EMPTY_SEGMENT)
  ) {
    throw new Error(`${JSON.stringify(file)} must be a relative path inside the workspace`);
  }
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readVersion(filePath) {
  try {
    return versionFromText(fs.readFileSync(filePath, ENCODING));
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string | null} The top-level `version` when it is a string, otherwise null, also for
 * text that is not JSON.
 */
export function versionFromText(text) {
  try {
    return readTopLevelVersion(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string | null} The top-level `version` when it is a string, otherwise null.
 */
function readTopLevelVersion(text) {
  const value = JSON.parse(text)?.[VERSION_KEY];
  return typeof value === "string" ? value : null;
}

/**
 * A version for a log line: only a strict version is shown, so a value cannot carry log commands.
 * @param {string | null} version
 */
export function describe(version) {
  if (version === null) return NO_VERSION;
  return parseVersion(version) ? version : INVALID_VERSION;
}

/** @param {string} text */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
