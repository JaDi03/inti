# Contributing

1. Clone the repo and use the Node version in `.nvmrc`.
2. Install: `pnpm install`
3. Copy `.env.example` to `.env` and fill in your own values. Never commit `.env`.
4. Develop: `pnpm new-key` once, then `pnpm server` and `pnpm web:dev` (see the README, Quick Start).
5. Before opening a PR run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm web:build`
6. Open a PR from a feature branch. One concern per PR.
