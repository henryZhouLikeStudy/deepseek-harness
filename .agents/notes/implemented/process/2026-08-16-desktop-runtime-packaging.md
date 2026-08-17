# Agent Note: Desktop dsh runtime packaging

Status: implemented

English | [中文](2026-08-16-desktop-runtime-packaging.zh.md)

## Problem

The desktop installer must ship the `dsh` CLI runtime under `resources/apps/desktop/dsh-runtime` so the Electron main process can spawn it. The original workflow deployed `@deepseek-ai/dsh` directly into `apps/desktop/dsh-runtime` and `electron-builder.yml` listed only `lib`, `config`, and `node_modules` as `extraResources`. That omitted `dsh-runtime/package.json`, but `lib/bin.js` synchronously reads `../package.json` for `--version`, so the packaged CLI would fail at boot.

`pnpm deploy --legacy` with `injectWorkspacePackages: true` also produced about 98 symlinks and junctions inside the runtime that resolved outside the target tree, including the `@deepseek-ai/cosmokit` and `@deepseek-ai/schemastery` link overrides from `pnpm-workspace.yaml`. The global `injectWorkspacePackages` setting forced every workspace package to be copied or hard-linked across the whole monorepo, creating stale-copy risk and a large lockfile churn every time the deploy layout changed.

## Decision

Remove `injectWorkspacePackages` from `pnpm-workspace.yaml` and keep `linkWorkspacePackages: true`; regenerate `pnpm-lock.yaml` so workspace dependencies resolve as links during normal development.

Deploy the CLI to a staging directory, `apps/desktop/dsh-runtime-staging`, with the existing `--prod --legacy --ignore-scripts` flags. The deploy step sets `pnpm_config_inject_workspace_packages=true` so workspace packages are inlined into the staging tree for packaging, without forcing the whole repository back to the stale-copy layout. Then run `scripts/materialize-desktop-runtime.mjs`, which:

1. Verifies that the staging tree contains `package.json`, `lib`, `config`, and `node_modules`.
2. Removes any previous `apps/desktop/dsh-runtime`.
3. Recursively copies the staging tree into `apps/desktop/dsh-runtime` while dereferencing every symlink and junction; a `Set` of source realpaths currently being copied breaks cyclic peer-dependency links that pnpm creates inside `.pnpm`.
4. Traverses the materialized tree and asserts that no symbolic link or junction remains.
5. Runs `node <dest>/lib/bin.js --version` and prints the reported version to prove the runtime executes in isolation.

`electron-builder.yml` packages the whole materialized `dsh-runtime` directory as a single `extraResources` entry instead of selecting subdirectories, so `package.json` is included and the relative paths expected by `lib/bin.js` stay valid.

`apps/desktop/.gitignore` ignores both `dsh-runtime/` and `dsh-runtime-staging/`.

The desktop workflow keeps the `pnpm_config_verify_deps_before_run=false` guard on the build and installer steps so that the deploy-triggered workspace-state drift does not cause pnpm 11 to run `pnpm install --production` and purge devDependencies before the desktop main process is compiled.

## Alternatives considered

**Keep `injectWorkspacePackages: true` and fix only the `electron-builder.yml` paths.** This would still copy or hard-link every workspace package across the monorepo, keep the stale-copy risk, and continue producing a large lockfile diff on every dependency change.

**List `package.json` as an additional `extraResources` item instead of packaging the whole directory.** It would fix the missing manifest but would remain brittle: any future runtime file added at the top level would be silently omitted again, and the symlink/junction problem would still be present.

**Switch the desktop build to `npm` or a plain `node_modules` copy.** That would duplicate pnpm's resolution logic and add a second package-manager surface to maintain without solving the workspace-link materialization problem.

## Consequences

The desktop installer now carries a fully self-contained, symlink-free `dsh` runtime. The lockfile diff from removing `injectWorkspacePackages` is limited to the two direct CLI dependencies that pnpm now records explicitly. Normal development installs use lightweight workspace symlinks again, while the CI packaging path materializes the runtime only where it is packaged.
