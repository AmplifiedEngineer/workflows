// @ts-check
/**
 * Entry point of the release action. `run` validates the inputs, runs one mode, appends the
 * mode's outputs to the GITHUB_OUTPUT file and prints its log as workflow commands. It returns
 * the exit code and never calls `process.exit`.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "./src/github.mjs";
import { parseFiles } from "./src/manifests.mjs";
import { prepare } from "./src/prepare.mjs";
import { release } from "./src/release.mjs";
import { verify } from "./src/verify.mjs";

const MODE_VERIFY = "verify";
const MODE_RELEASE = "release";
const MODE_PREPARE = "prepare";
const BUMPS = ["auto", "patch", "minor", "major"];
const DEFAULT_BUMP = "auto";
const TRUE = "true";
const FALSE = "false";
const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_WORKSPACE = ".";
const NOTICE = "notice";
const REPOSITORY_SEPARATOR = "/";
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EVENT_ENCODING = "utf8";

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   fetch: typeof fetch,
 *   stdout: (text: string) => unknown,
 * }} RunContext
 */

/**
 * Escapes text for a workflow command, using GitHub's documented rules.
 * @param {string} text
 * @returns {string}
 */
function escapeCommandData(text) {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * @param {RunContext} context
 * @returns {Promise<number>} 0 on success, 1 after writing one `::error::` line.
 */
export async function run({ env, fetch, stdout }) {
  try {
    const inputs = readInputs(env);
    const event = readEvent(inputs.eventPath);
    const client = createClient({
      fetch,
      apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL,
      token: inputs.token,
      repo: inputs.repository,
    });
    const files = parseFiles(inputs.files);
    const { outputs, log } = await runMode({ inputs, event, client, files });
    appendFileSync(
      inputs.outputPath,
      Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
    for (const { level, text } of log) {
      const line = level === NOTICE ? `::notice::${escapeCommandData(text)}` : escapeCommandData(text);
      stdout(`${line}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout(`::error::${escapeCommandData(message)}\n`);
    return EXIT_FAILURE;
  }
}

/**
 * Checks every input before any API call.
 * @param {Record<string, string | undefined>} env
 */
function readInputs(env) {
  const mode = env.INPUT_MODE ?? "";
  if (![MODE_VERIFY, MODE_RELEASE, MODE_PREPARE].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const bump = env.INPUT_BUMP || DEFAULT_BUMP;
  if (!BUMPS.includes(bump)) throw new Error(`unknown bump: ${bump}`);
  const dryRun = env["INPUT_DRY-RUN"] || FALSE;
  if (dryRun !== TRUE && dryRun !== FALSE) throw new Error("dry-run must be true or false");
  return {
    mode,
    bump,
    dryRun: dryRun === TRUE,
    files: env.INPUT_FILES ?? "",
    token: requireEnv(env, "INPUT_TOKEN", "token"),
    repository: requireEnv(env, "GITHUB_REPOSITORY"),
    sha: requireEnv(env, "GITHUB_SHA"),
    eventPath: requireEnv(env, "GITHUB_EVENT_PATH"),
    outputPath: requireEnv(env, "GITHUB_OUTPUT"),
    workspace: env.GITHUB_WORKSPACE || DEFAULT_WORKSPACE,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {string} [label] What to call it in the error when the env name is an internal detail.
 * @returns {string}
 */
function requireEnv(env, name, label = name) {
  const value = env[name];
  if (!value) throw new Error(`${label} is missing`);
  return value;
}

/**
 * @param {string} path
 * @returns {any}
 */
function readEvent(path) {
  try {
    return JSON.parse(readFileSync(path, EVENT_ENCODING));
  } catch {
    throw new Error(`cannot read event payload at ${path}`);
  }
}

/**
 * @param {{
 *   inputs: ReturnType<typeof readInputs>,
 *   event: any,
 *   client: ReturnType<typeof createClient>,
 *   files: string[],
 * }} options
 * @returns {Promise<{ outputs: Record<string, string>, log: { level: string, text: string }[] }>}
 */
function runMode({ inputs, event, client, files }) {
  const { workspace, sha, mode } = inputs;
  if (mode === MODE_VERIFY) {
    return verify({ client, workspace, files, title: event?.pull_request?.title });
  }
  if (mode === MODE_PREPARE) {
    const defaultBranch = event?.repository?.default_branch;
    if (!defaultBranch) throw new Error("event payload has no repository.default_branch");
    const owner = inputs.repository.split(REPOSITORY_SEPARATOR)[0];
    return prepare({ client, files, bump: inputs.bump, dryRun: inputs.dryRun, defaultBranch, owner });
  }
  return release({ client, workspace, files, sha });
}

const isEntryScript =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntryScript) {
  process.exitCode = await run({
    env: process.env,
    fetch,
    stdout: (text) => process.stdout.write(text),
  });
}
