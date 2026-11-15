# AGENTS.md

## Working with the user

Ask before choosing product intent or another costly, durable direction.

Disagree openly when an instruction, plan, or rule seems wrong, and say what you would do instead. Recommend the better option even when it's a bigger change than was asked for.

Write for a reader who has no background on the task and hasn't read the code. That includes the user, because agents write most of the code.

Write plainly and directly, in literal wording that is easy to follow. Avoid mannered prose, stock phrases, and jargon where plain words say the same thing, and don't compress sentences into fragments to save words.

When you ask the reader to decide, say what's at stake and where each option leads, and recommend one before giving technical evidence.

The user may read only your last message. While working, write only to answer a question, when your goal changes, when something is ready for review, or when you need something from the user, such as an approval, and leave out the details of the step you're on. Start each final message by answering every question the user asked after the last final message they replied to, even if you answered it before, then say what you need from them and what's ready for their review.

## Quality gates

Don't weaken a quality gate to make a change pass. Explain every inline suppression where it appears. Use a configuration exception only where a rule can't apply, scoped to the affected path and rule.

## Change policy

You are the owner and long-term maintainer of this codebase, and its design is up to you.

Don't build backwards compatibility by default. Code in these repositories has no consumers outside them, so migrate every call site and delete the old shape in the same change.

## Formatting

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose.

## Documentation and instructions

Agents are the main readers of documentation, skills, instructions, and prompts. Every sentence costs input tokens each time it's read, and every decision an agent works out itself costs reasoning tokens, so keep a sentence only when it saves more reasoning than it costs to read, such as a decision agents would otherwise get wrong or work out again on every run. Simplify by removing decisions and branches rather than compressing sentences, and before adding a rule, check whether changing an existing one would do. Give the reason for a rule that isn't obvious, and state each fact once. Keep history and status in PRs and issues, and cut documentation in the same change that makes it stale.

## Package management

Use Bun only, at the exact version declared by the root `packageManager`. Workspaces that use the Bun runtime or `bun:test` types declare `@types/bun` themselves.

## Architecture

- App code lives in `apps/*`. Business logic belongs in `src/features/<domain>` and app-wide infrastructure in `src/shared`. Code used by one app stays in that app unless it has an intentional shared contract.
- Shared code lives in `packages/*`, by default as `src/<capability>.ts(x)` with colocated tests, and with deeper folders only when the capability needs them.
- Package names use the project alias `@<actual-project-name>/<package-name>`. Canonical packages use `@davidvornholt` and change in the standards repository.
- Entrypoints route, parse initial inputs, wire Effect layers, and bridge to the runtime or UI.
- Dependencies flow `entrypoint -> features -> shared -> packages`. Features don't import sibling features, and cross-package imports use package aliases rather than relative paths.
- A cohesive boundary file may exceed the 400-line lint limit through a scoped `biome.jsonc` override and an entry in `docs/quality/no-excessive-lines-per-file-exceptions.md`.

## Workspace scripts

Operational scripts belong in the owning workspace's `package.json`. Root scripts stay minimal: the quality gates, including `lint` and `lint:fix`, plus a few filtered Turbo aliases that are actually useful. Biome lints the whole repository once from the root, so workspaces don't declare lint scripts. Canonical repo-spanning workflows and convenience recipes live in the root `justfile`, and project-specific recipes in `local.just`.

## Effect standards

Use Effect extensively wherever it makes sense, because it helps agents write more robust code. In an Effect v4 workspace, follow the agent guide shipped at `node_modules/effect/AGENTS.md`, because v4's API differs from the v3 most models learned.

## Project-specific rules

This is a canonical file from the standards repository. Project-specific rules belong in `AGENTS.local.md`.

@AGENTS.local.md
