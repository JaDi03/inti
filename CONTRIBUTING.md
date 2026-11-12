# Contributing

## Report a problem

Open an [issue](https://github.com/JaDi03/inti/issues) and say what you did, what you expected and what happened instead. Never paste a key, a `.env` file or a seed phrase.

## Set up

You need Node 24 (`.nvmrc`) and pnpm 11.

```bash
git clone https://github.com/JaDi03/inti.git
cd inti
pnpm install
pnpm test
```

To run the app on your computer, copy `.env.example` to `.env`. Fill in the four keys listed in the [README](README.md#run-your-own-server), and these values, which a server install creates by itself:

| Value | Where it comes from |
|---|---|
| `SERVER_GRANT_KEY` | the command in `.env.example` |
| `SERVER_INTI_KEY_FILE`, `INTI_KEY_PUBLIC` | `pnpm new-key` creates the key file and prints both lines; copy them into `.env` |

Then start the server and the web app:

```bash
pnpm server    # agent API on http://localhost:8787
pnpm web:dev   # app on http://localhost:5173
```

Orders are real: with a funded account, the agent spends real funds within the limits you sign.

The contract in `contracts/spending-limits/` has its own build and tests: see its [README](contracts/spending-limits/README.md).

## Before a pull request

Run the same checks as CI:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm web:build
```

## Pull requests

Work on a branch of your own and open the pull request against `main`. Keep one change per pull request, and say in it what changes for the user.
