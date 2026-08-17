# Agent Note：桌面端 dsh 运行时打包

Status: implemented

[English](2026-08-16-desktop-runtime-packaging.md) | 中文

## Problem

桌面安装程序需要把 `dsh` CLI 运行时打包到 `resources/apps/desktop/dsh-runtime`，以便 Electron 主进程可以启动它。原工作流直接把 `@deepseek-ai/dsh` 部署到 `apps/desktop/dsh-runtime`，而 `electron-builder.yml` 只把 `lib`、`config` 和 `node_modules` 列为 `extraResources`。这漏掉了 `dsh-runtime/package.json`，但 `lib/bin.js` 在 `--version` 时会同步读取 `../package.json`，因此打包后的 CLI 在启动时会失败。

在 `injectWorkspacePackages: true` 的情况下，`pnpm deploy --legacy` 还会在运行时内部产生约 98 个指向目标目录外部的符号链接和联接，包括 `pnpm-workspace.yaml` 中的 `@deepseek-ai/cosmokit` 和 `@deepseek-ai/schemastery` 链接覆盖。全局 `injectWorkspacePackages` 设置会强制整个 monorepo 的工作区包都被复制或硬链接，既带来陈旧副本风险，又使每次部署布局变化时产生大量 lockfile 变更。

## Decision

从 `pnpm-workspace.yaml` 中移除 `injectWorkspacePackages`，保留 `linkWorkspacePackages: true`；重新生成 `pnpm-lock.yaml`，使工作区依赖在正常开发时以链接方式解析。

使用现有的 `--prod --legacy --ignore-scripts` 标志把 CLI 部署到暂存目录 `apps/desktop/dsh-runtime-staging`，并在该步骤设置 `pnpm_config_inject_workspace_packages=true`，使工作区包仅在打包暂存树中被内联，而不会强制整个仓库回到陈旧副本布局。然后运行 `scripts/materialize-desktop-runtime.mjs`：

1. 验证暂存树包含 `package.json`、`lib`、`config` 和 `node_modules`。
2. 删除已有的 `apps/desktop/dsh-runtime`。
3. 递归复制暂存树到 `apps/desktop/dsh-runtime`，同时反引用每个符号链接和联接；一个记录当前正在复制的源真实路径的 `Set` 会打断 pnpm 在 `.pnpm` 内部创建的循环 peer-dependency 链接。
4. 遍历物化后的树，断言不再存在任何符号链接或联接。
5. 运行 `node <dest>/lib/bin.js --version` 并打印版本号，证明运行时可以在隔离环境中执行。

`electron-builder.yml` 把物化后的整个 `dsh-runtime` 目录作为一个 `extraResources` 条目打包，而不是只选子目录，这样 `package.json` 会被包含，且 `lib/bin.js` 期望的相对路径保持有效。

`apps/desktop/.gitignore` 忽略 `dsh-runtime/` 和 `dsh-runtime-staging/`。

桌面工作流在构建和打包步骤上保留 `pnpm_config_verify_deps_before_run=false` 防护，避免部署导致的工作区状态漂移触发 pnpm 11 执行 `pnpm install --production`、清除 devDependencies，进而无法编译桌面主进程。

## Alternatives considered

**保留 `injectWorkspacePackages: true` 并只修复 `electron-builder.yml` 路径。** 这样仍会复制或硬链接整个 monorepo 的工作区包，保留陈旧副本风险，并继续产生大量 lockfile 差异。

**把 `package.json` 作为额外的 `extraResources` 项列出，而不是打包整个目录。** 这能修复缺失的清单，但仍然脆弱：以后在顶层添加的任何运行时文件都会再次被静默遗漏，且符号链接/联接问题依然存在。

**把桌面构建切换到 `npm` 或普通 `node_modules` 复制。** 这会重复 pnpm 的解析逻辑，增加第二种包管理器维护面，且无法解决工作区链接物化问题。

## Consequences

桌面安装程序现在携带一个完全自包含、无符号链接的 `dsh` 运行时。移除 `injectWorkspacePackages` 后的 lockfile 差异被限制为 pnpm 现在显式记录的两个 CLI 直接依赖。日常开发安装重新使用轻量的工作区链接，而 CI 打包路径只在需要打包的位置物化运行时。
