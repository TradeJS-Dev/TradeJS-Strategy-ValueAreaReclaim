# AGENTS.md

## Scope

These rules apply to an independent TradeJS strategy repository.

## Workspace Routing

- Start from `~/dev/tradejs/AGENTS.md`; do not scan sibling repositories.
- This repository owns ValueAreaReclaim source, figures, config and tests.
- Run package checks here. Run backtests and research from `tradejs-project`;
  do not store research artifacts in this repository.
- Preserve the fixed 15m source contract. On 1h, use StrategyAPI.getClosedCandles
  for the completed UTC-day window. Fail closed on incomplete source history;
  never substitute hourly candles for profile input.

## Package contract

- Export `strategyEntries` from the package root.
- Every strategy entry must own a strict `parseConfig` implementation built
  from `@tradejs/strategy-kit/config` and covered by contract tests.
- Keep detector state replayable and bounded.
- Keep StrategyAPI side effects in strategy core code, outside pure engines.
- Import TradeJS APIs only through public package exports.
- Put strategy tests in this repository.
- Do not add Redis, exchange clients, deployment logic, production containers,
  credentials, or user configuration.
- Keep `@tradejs/strategy-kit` because the standard config contract consumes
  its public `config` subpath.
- A repository exports one strategy unless the central architecture catalog
  records a grouped exception.

## Verification

Run `yarn checks` before every commit.

## Runtime Dependency Contract

- Keep every `@tradejs/*` runtime package in both `peerDependencies` and `devDependencies`, never in `dependencies`.
- The consuming TradeJS Project must own the exact runtime composition; nested TradeJS package copies are forbidden.
- Keep the package-contract test in `yarn checks` whenever dependency metadata changes.
