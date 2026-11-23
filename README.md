# workflows
Reusable GitHub Actions and workflows for versioning and releasing repositories

## What this repo offers

A JavaScript action, `ci/release-action`, with three modes: `verify`, `prepare` and `release`.

Two reusable workflows that call it. Pick one type for your repo and copy one caller file.

- `release-continuous.yml`: every merged pull request is released. The pull request title sets the version bump.
- `release-manual.yml`: a maintainer dispatches `prepare`, which opens or updates a release pull request. Merging that pull request releases.

Both workflows run on GitHub-hosted runners, or on a self-hosted runner version 2.336.0 or newer. They refer to the action with the `$/` self-repository reference, so the action always matches the workflow commit you pin.

Pin the workflow to a full commit SHA, never to a branch or a tag. Put the release version in a trailing comment so Dependabot can update both. Replace `<sha>` and `vX.Y.Z` below with a real commit and its release.

## Version rules

The version comes from the first line of the pull request title (continuous type) or from the first lines of the commits since the latest tag (manual type, mode `auto`).

| Title | Current `0.y.z` | Current `1.y.z` and up |
|-------|-----------------|------------------------|
| `type!: x` or `type(scope)!: x` (breaking) | minor | major |
| `feat: x` or `feat(scope): x` | minor | minor |
| anything else | patch | patch |

Types are lowercase and the match is case sensitive, so `Feat: x` is a patch. An explicit `major` bump from `prepare` gives the next major at any version, for example `0.3.0` to `1.0.0`. A tag must look like `vX.Y.Z` with no leading zeros and no suffix. Other tags are ignored.

Any change to these rules ships as a minor release with notes.

## The continuous type

Copy this file to `.github/workflows/release.yml` in your repo. Replace `main` if your default branch has another name.

```yaml
name: release

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  push:
    branches: [main]

permissions: {}

jobs:
  release:
    name: release
    permissions:
      contents: write
    uses: AmplifiedEngineer/workflows/.github/workflows/release-continuous.yml@<sha> # vX.Y.Z
```

This is for a repo with no manifest. Releases are tags only, and the latest tag holds the version. The first release is `v0.0.1` or `v0.1.0`, depending on the title.

For a repo with manifests, add `files`. It lists JSON files with a top-level `version`, one path per line.

```yaml
name: release

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  push:
    branches: [main]

permissions: {}

jobs:
  release:
    name: release
    permissions:
      contents: write
    uses: AmplifiedEngineer/workflows/.github/workflows/release-continuous.yml@<sha> # vX.Y.Z
    with:
      files: |
        package.json
        .claude-plugin/plugin.json
```

Rules for the caller:

- The job must be named `release`. The required check name is built from it.
- The `pull_request` types must include `edited`, so a title edit runs the check again.
- Keep `permissions: {}` at the top and `contents: write` on the job. The called `release` job needs it to create the tag and the release.

Then add the required check `release / verify` to your branch ruleset.

How it works:

- On a pull request to the default branch, `verify` works out the expected version from the title. With `files`, every file must already hold that version. Without `files`, the check only confirms the title gives a version.
- On a push to the default branch, `release` creates the tag `vX.Y.Z` and a release with generated notes.
- With `files`, the first release uses the version the files hold, as long as they all agree.
- A pull request that targets another branch is not checked.

Outputs of the called workflow: `version`, `tag` and `released`.

## The manual type

Copy this file to `.github/workflows/release.yml` in your repo.

```yaml
name: release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: Version bump
        type: choice
        options: [auto, patch, minor, major]
        default: auto
      dry-run:
        description: Report what would change without writing
        type: boolean
        default: false
  push:
    branches: [main]

permissions: {}

jobs:
  release:
    name: release
    permissions:
      contents: write
    uses: AmplifiedEngineer/workflows/.github/workflows/release-manual.yml@<sha> # vX.Y.Z
    with:
      files: |
        package.json
      bump: ${{ inputs.bump || 'auto' }}
      dry-run: ${{ inputs.dry-run == true }}
    secrets:
      app-client-id: ${{ secrets.RELEASE_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

Inside one organisation you can write `secrets: inherit` instead of naming the two secrets.

The caller passes these inputs: `files` (required, at least one file), `bump` (`auto`, `patch`, `minor` or `major`, default `auto`) and `dry-run` (default `false`). Use `files` to name the manifests the release pull request updates.

Set it up once:

1. Create a GitHub App with repository permissions Contents (read and write) and Pull requests (read and write). Install it on the repo.
2. Store the App client ID and private key as secrets. Put them in an environment limited to the default branch.
3. If a branch rule covers `release/*`, let the App push to it.
4. The repo needs one release tag first. Merge to the default branch to release the manifest version, then dispatch.

How it works:

- Dispatch from the default branch. `prepare` works out the next version from the commits since the latest tag, rewrites the `version` in each file and opens or updates a pull request titled `chore(release): vX.Y.Z`. A dry run only reports.
- Merging that pull request is a push to the default branch, so `release` tags it and creates the release.
- The release pull request uses the fixed branch `release/next`. The App force-updates it on every dispatch, so commits pushed there by hand are lost.
- If the default branch moves while the release pull request is open, dispatch `prepare` again. Do not use "update branch".
- The manual type has no `verify` job. Its required checks are your repo's own.
- Every file must hold the same version. A file above the latest tag fails with a message to let the release job finish first.

Outputs of the called workflow: `version`, `tag` and `released`.

## Action modes

The workflows call the action for you. These are its inputs and outputs, in case you call it from your own workflow.

| Input | Default | Meaning |
|-------|---------|---------|
| `mode` | none, required | `verify`, `prepare` or `release` |
| `token` | `github.token` | Token for the GitHub API calls |
| `files` | empty | JSON files with a top-level `version`, one path per line |
| `bump` | `auto` | `auto`, `patch`, `minor` or `major` (used by `prepare`) |
| `dry-run` | `false` | `true` or `false` only. Any other value fails |

| Mode | Runs on | What it does | Outputs |
|------|---------|--------------|---------|
| `verify` | `pull_request` | Checks the pull request title against the latest tag and the files | `version`, `tag` |
| `prepare` | `workflow_dispatch` | Opens or updates the release pull request on `release/next`. Needs files and an existing tag | `version`, `tag`, `pull-request` |
| `release` | `push` to the default branch | Creates the tag and the release | `version`, `tag`, `released` |

`version` has no leading `v`. `tag` has one. `released` is `true` when this run created the tag or the release. `pull-request` is the pull request URL, and empty on a dry run.

## Notes

- A tag ruleset must let the token create `v*` tags.
- Tags and releases made with `GITHUB_TOKEN` start no other workflows. To build or publish, chain a job on the `tag` and `released` outputs of the called workflow, for example `needs: release` and `if: needs.release.outputs.released == 'true'`.
- A tag-only continuous repo needs squash merges, so `verify` and `release` read the same title.
- A continuous repo with `files` needs the required-check setting "Require branches to be up to date before merging". Without it, two pull requests can claim one version.
- Queued runs can skip a version. GitHub keeps one pending run per concurrency group. In the continuous type with `files`, a dropped run leaves its manifest version without a tag, and the next run tags its own version. In the manual type, a dropped run tags the next run's commit, and a maintainer can move the tag by hand.
- `release` first repairs a missing release. If the latest tag has no release and sits on the pushed commit or one of its ancestors, the run creates that release. This includes a tag pushed by hand.
- The organisation Actions policy must allow `AmplifiedEngineer/workflows` and the actions it uses.
- The `$/` reference needs GitHub-hosted runners, or a runner version 2.336.0 or newer.
- A pull request from a fork gets a read-only token. Check that the caller still starts on your fork pull requests.

## Keep the pin current

Add this to `.github/dependabot.yml`. Dependabot updates the SHA and the version comment together. The cooldown makes it wait 7 days after a release before it proposes the update.

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
```

## How this repo checks and releases itself

- The `check` job in `.github/workflows/check.yml` runs on every pull request and push to main. It runs `node --test`, actionlint and zizmor.
- `.github/workflows/release.yml` is this repo's own caller of `release-continuous.yml`, with no `files`. Every merge is tagged.
- `.github/workflows/release-manual-dry-run.yml` is a dispatch-only caller of `release-manual.yml` with `dry-run: true` and a fixture manifest. Run it to see what `prepare` would do.
