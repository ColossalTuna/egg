# Egg, Inc. helper tools — review context

A pnpm-workspaces monorepo of community helper tools for the game Egg, Inc.

## Layout

| Path | What it is |
| --- | --- |
| `lib/` | Shared TypeScript library, including the client for the private Egg, Inc. API |
| `ui/` | Shared Vue components |
| `eicoop/` | Co-op tracker web app |
| `wasmegg/*` | ~20 single-page apps, each its own workspace |
| `wasmegg/_common/` | Go and TypeScript shared between the wasmegg apps |
| `protobuf/` | The `ei.proto` schema mirroring the private API |
| `periodicals/` | Python data tooling |

Stack: Vue 3 with `<script setup lang="ts">`, TypeScript in strict mode, Vite, Tailwind, and Go 1.23.

## What to prioritise

**Cross-file and cross-workspace correctness above all.** This is where real bugs in this repo actually hide — a change that looks locally fine but breaks a consumer three workspaces away. Anything exported from `lib/` is consumed by every app listed in `pnpm-workspace.yaml`.

Beyond that, in rough order:

1. Logic and correctness of the game math. These tools compute values players make decisions on, so a wrong formula is worse than an inelegant one.
2. Vue reactivity bugs and missing lifecycle cleanup (see the scoped rules in `config.json`).
3. Unsafe handling of decoded save data — see `wasmegg/.greptile/rules.md`.
4. Error handling around the private API in `lib/api/`.

## What not to comment on

The `no-formatting-nitpicks`, `respect-eslint-config`, `no-docstring-requests`, and `no-test-suggestions` rules in `config.json` cover this in detail. In short: formatting is Prettier's job, lint is ESLint's job, and this codebase uses neither docstrings nor a universal test harness.

Generated game data is excluded via `ignorePatterns` — several `.github/workflows/update-*.yml` jobs commit regenerated JSON blobs on a schedule, and those diffs are machine output.
