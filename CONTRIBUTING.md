# Contributing

1. Clone the repo and use the Node version in `.nvmrc`.
2. Install: `pnpm install`
3. Copy `.env.example` to `.env` and fill in your own values. Never commit `.env`.
4. Develop: `pnpm dev`
5. Before opening a PR run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
6. Open a PR from a feature branch. One concern per PR.
