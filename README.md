# Inti

![status](https://img.shields.io/badge/status-early%20development-orange?style=for-the-badge)
![node](https://img.shields.io/badge/node-24-339933?style=for-the-badge&logo=node.js&logoColor=white)
![typescript](https://img.shields.io/badge/typescript-6-3178C6?style=for-the-badge&logo=typescript&logoColor=white)

Inti is an investment agent on NEAR. You say in plain words what to buy or sell, and it does it from your own wallet, within limits you sign.

Giving an AI agent money usually means giving it your keys. With Inti your funds stay in your wallet. Inti gets a key that can only send orders, and a contract on your own account refuses any order above your limits.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Run Your Own Server](#run-your-own-server)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

## How It Works

1. **Sign in** with email or Google. [Privy](https://docs.privy.io) creates a NEAR wallet for you.
2. **Set your limits**: how much one order may spend, and how much in a day. The app installs the Spending Limits contract on your account and adds Inti's key, which can call only `fund_agent` (`web/src/limits/client.ts`).
3. **Create your agent** on the NEAR Intents [Agent API](https://docs.agentsonintents.com) and sign a trading permission (a grant) for 7, 30 or 90 days.
4. **Chat**: "buy $5 of bitcoin", "sell half my ether", "buy Zcash if it drops to $900". The agent quotes, buys, sells or places an order that waits for a price.
5. **Results go to your wallet.** Anything left with the agent is sent back to your wallet every 5 minutes.

The agent buys and sells bitcoin (BTC), ether (ETH) and Zcash (ZEC), and pays with NEAR (`agent/policy/assets.ts`). Its trades run on the agent's confidential balance in NEAR Intents.

### Earlier version: gold, euro and Solana

Until 12 November 2026 Inti also bought gold (XAUT), euro (EURe) and Solana and sent them to the user's NEAR wallet. The Agent API now trades only from the agent's confidential balance, and from there it sends to a NEAR wallet only the assets 1Click lists on the NEAR chain. Gold, euro and Solana are not on that list, so Inti no longer offers them. That version is kept in the tag [`gold-euro-sol-final`](https://github.com/JaDi03/inti/tree/gold-euro-sol-final).

One of its trades on mainnet, a sale of gold for Solana on 12 November 2026:

1. [`7BrWbDgR`](https://nearblocks.io/txns/7BrWbDgRiVyknCV2Trr5KrggQvMMRNH1K9XQVvavhnhx): the Spending Limits contract on the user's account sends 0.000062 XAUT to the agent in NEAR Intents.
2. [`CCAuxeuM`](https://nearblocks.io/txns/CCAuxeuMU2BsLT5ZeMWEcS9jnFrXpvk9R9g46TeAvVRs): the agent gives the gold to a market maker.
3. [`2S16iWuB`](https://nearblocks.io/txns/2S16iWuBepvzSeoykpxMBV3z5CmfoV8cRvCfPbPRvjZw): the market maker gives 0.002874 SOL to the agent.
4. [`9N1LZEDu`](https://nearblocks.io/txns/9N1LZEDuh4STZYtx6QLbVtkmnXoGcb8H1U7uupWCbdDV): the SOL leaves NEAR Intents for the user's wallet.

### The agent

The model decides; the code and the contract enforce the limits.

- `agent/core/loop.ts`: the loop. A brain is any object with a `step()` method.
- `agent/brains/nearai.ts`: the brain, on [NEAR AI Cloud](https://docs.near.ai/cloud/quickstart), model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, which runs inside NEAR AI's TEE (private inference). Each step keeps its response id, which NEAR AI signs inside the TEE.
- `agent/server/realTools.ts`: the seven tools the model can call: `get_portfolio`, `get_quote`, `buy_now`, `buy_at_price`, `get_sell_quote`, `sell_now` and `ask_user`. The model picks an asset by name and an amount in dollars; it never writes an address.

Until you have an agent and a live grant, the chat runs on a simulated portfolio and no funds move.

### Private AI, checked live

Next to the logo, a shield says whether the model is verified. Tap it to see each check and run them again.

```ts
if (reportData.slice(64) === nonce) passed.add("binds_nonce");
if (reportData.slice(0, 64) === signingAddress.slice(2).padEnd(64, "0")) passed.add("binds_key");
```

`agent/server/attestation.ts`: Inti sends NEAR AI a new random challenge and gets back the hardware report of its model. It checks the Intel TDX quote against Intel's own certificates ([@phala/dcap-qvl](https://github.com/Phala-Network/dcap-qvl)), that the quote carries the challenge and the model's signing key, that the machine is not in debug mode and runs the software it measured, and asks NVIDIA whether the GPU is genuine. The steps follow [NEAR AI's verification docs](https://docs.near.ai/cloud/verification). Nothing is stored.

This proves where the model runs. It does not yet prove that each reply came from that chip, and Inti's own server still sees your messages to pass them on.

### The limits

```rust
require!(new_spent <= limit.per_day.0, "over the daily limit");
```

`contracts/spending-limits/src/lib.rs`: before Inti's key sends an order, the contract adds it to what the last 24 hours already sent. If the total would pass your daily limit, the order is refused and nothing moves. Even with Inti's key, nobody can spend more than your limits. To stop Inti at once, delete its key from your account. Details: [Spending Limits contract](contracts/spending-limits/README.md).

### Server and web app

`agent/server/` is the API the web app calls: `POST /api/chat` runs the agent for the signed-in user, and the `/api/agent/*` routes create the user's agent and the grant the user signs. It checks the Privy access token on every request with Privy's public verification key, so it never needs the Privy app secret.

`web/` is the app. `PrivyNearSigner` plugs the Privy wallet into the near-api-js `Signer`, so near-api-js builds and hashes NEP-413 messages and NEP-366 delegate actions, the two signatures the Agent API asks an owner for, and Privy signs the hash.

## Run Your Own Server

The app and its API on your own server, at `https://your-domain.com`. You need Ubuntu or Debian (x64, tested on Ubuntu 24.04), a user with `sudo`, and a domain pointing to the server with ports 80 and 443 open.

```bash
git clone https://github.com/JaDi03/inti.git
cd inti
cp .env.example .env && chmod 600 .env
nano .env                       # INTI_SITE and the four keys at the top of the file
sudo bash deploy/install.sh
```

| Key | Where it comes from |
|---|---|
| `NEAR_INTENTS_AGENT_API_KEY` | your partner key for the [Agent API](https://docs.agentsonintents.com) |
| `NEAR_AI_API_KEY` | [cloud.near.ai](https://cloud.near.ai) |
| `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | your app in the [Privy dashboard](https://dashboard.privy.io) |

The script checks `.env` before it installs anything and says what is missing. It installs Node, pnpm and Caddy, creates Inti's key and the key that encrypts the grants, builds the app, and starts the API behind HTTPS. It ends with `Done. Open https://your-domain.com`. In the Privy dashboard, add that domain to the app's allowed domains.

To update, or to apply a changed setting, run the same command from the same folder:

```bash
cd inti
sudo bash deploy/install.sh
```

The script first updates the folder with `git pull`, then installs exactly that commit. It runs as root, so whoever can push to the branch you cloned decides what runs on your server: clone a repository you trust, or your own fork.

`.env` is merged into `/etc/inti/inti.env` and removed, so no copy with your keys stays in the folder you cloned. To change a setting, edit that file, or write a new `.env` with only the settings to change, and run the command again. The key that encrypts the grants is made once and never replaced.

Each install is a new release. If the new one does not start, the previous one keeps running.

| What | Where |
|---|---|
| The live release (code, packages and built app), owned by root; the previous one is kept | `/opt/inti/current`, `/opt/inti/releases` |
| Where the system user `inti-build` builds the app; it cannot read any key | `/var/lib/inti-build` |
| Settings, readable only by root and `inti` | `/etc/inti/inti.env` |
| Inti's key and the users' grants, readable only by `inti` | `/var/lib/inti` |
| The API, run by the system user `inti`, which cannot change the code, and restarted if it stops | systemd: `inti-agent` (`journalctl -u inti-agent -f`) |
| The app with HTTPS, and `/api` to the API | Caddy: `/etc/caddy/inti.caddy` |

Users authorize Inti's key on their own account. Keep a copy of `/var/lib/inti/inti-key.json` and of `SERVER_GRANT_KEY` from `/etc/inti/inti.env`. To move to a new server without asking users to do it again, copy `inti-key.json` and `grants.json` to the new server's `/var/lib/inti/`, and put `SERVER_GRANT_KEY` in its `.env`, before you run the script. It keeps a key and grants that are already there.

## Project Structure

```
agent/                 the investment agent (TypeScript)
  core/                loop, simulated portfolio, money math
  brains/              model adapters: NEAR AI Cloud, scripted brain for tests
  policy/              the assets the agent trades, token units
  server/              the API the web app calls, orders and grants
  cli/new-key.ts       create Inti's key for a local setup
contracts/
  spending-limits/     NEAR contract on the user's own account (Rust)
web/                   app: login, Spending Limits, chat (React)
deploy/                install.sh and the server files it sets up
```

## Tech Stack

- **[NEAR Intents](https://docs.near-intents.org)**: the swaps and price orders behind every buy and sell
- **[@near-intents-agent-api/sdk](https://docs.agentsonintents.com/integration/agent-api/sdk)**: official Agent API types
- **[NEAR AI Cloud](https://docs.near.ai/cloud/quickstart)**: private inference in a TEE, through the [OpenAI SDK](https://github.com/openai/openai-node)
- **[Privy](https://docs.privy.io)**: email and Google login with an embedded NEAR wallet
- **[near-api-js](https://github.com/near/near-api-js)**: NEAR transactions, NEP-413 and NEP-366 encoding
- **[fastify](https://fastify.dev)**: the API server
- **[zod](https://zod.dev)**: checks settings, requests and the model's tool calls
- **[vitest](https://vitest.dev)**: tests
- **[TypeScript](https://www.typescriptlang.org)**: language

## Contributing

To run it on your computer or change the code, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
