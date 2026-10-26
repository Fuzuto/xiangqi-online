# Deploy Xiangqi Online

Deploy this folder as its own Next.js project. Use separate Redis databases or namespaces for production and previews so preview tests cannot alter real matches.

The current public release is [xiangqi-online-one.vercel.app](https://xiangqi-online-one.vercel.app), connected to [Fuzuto/xiangqi-online](https://github.com/Fuzuto/xiangqi-online). Production uses Node.js 24, Fluid compute, and free owned Upstash Redis/QStash resources in `iad1`.

## Validate the release

With Node.js 24 and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

Review [RULES.md](RULES.md), including the simplified chase adjudication. This app does not claim tournament-complete WXF adjudication.

## Publish a public GitHub repository

If the folder is not yet a repository:

```sh
git init -b main
git add .
git commit -m "Build Xiangqi Online"
```

For a separate copy, create an empty public repository named `xiangqi-online` in GitHub. Follow its existing-repository instructions to add the remote and push `main`. Alternatively, with the GitHub CLI already authenticated:

```sh
gh repo create xiangqi-online --public --source=. --push
```

Before pushing, inspect the staged files and confirm `.env.local`, generated room data, browser artifacts, and credentials are excluded. Commit the pnpm lockfile. The included GitHub Actions workflow checks types, lint, tests, and the production build. Require its check through branch protection for `main`.

## Import into Vercel

In the intended Vercel account, choose **Add New → Project**, import the repository, and keep the detected Next.js framework. If this is inside a larger repository, set the project's root directory to this folder. Select Node.js 22 or later.

Enable Fluid compute. The native WebSocket endpoint requires it; new projects have it enabled by default. Vercel closes a socket when its function reaches the configured maximum duration, so automatic reconnect and polling remain part of normal operation. The current Next.js API is `upgradeWebSocket` from `@vercel/functions` version 3.10.0 or later. See the [official WebSocket documentation](https://vercel.com/docs/functions/websockets) and [API reference](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#upgradewebsocket).

## Connect Redis

Add **Upstash Redis** from the Vercel Marketplace and connect it to the correct deployment environments. Set the server-only variables from [.env.example](.env.example):

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The `KV_REST_API_URL` and `KV_REST_API_TOKEN` aliases are also accepted. Do not use a read-only token: game commands need atomic Redis writes. Ensure the connection variables match the integration's current names and values. The app refuses a local storage fallback on Vercel.

To use the same development integration locally, link the project with the Vercel CLI and pull its development variables into the ignored `.env.local` file:

```sh
vercel link
vercel env pull .env.local
```

## Configure scheduled clock checks

Create QStash credentials in Upstash and set:

- `QSTASH_TOKEN`: server-side publishing credential.
- `TIMEOUT_SECRET`: a long random secret for the protected callback.
- `APP_BASE_URL`: the deployment's canonical public HTTPS origin, without a path.

`QSTASH_URL` is optional and defaults to Upstash's hosted QStash API. The server publishes a callback for the active turn's deadline using QStash's absolute-delay support. Delivery can be retried; callbacks are idempotent. See [Upstash QStash delay documentation](https://upstash.com/docs/qstash/features/delay).

The timeout-check route must be reachable by QStash. If Vercel Deployment Protection blocks it, configure an appropriate automation bypass for the scheduler rather than disabling all protection. Verify actual callback delivery in Upstash and the application logs. Lazy timeout checks still protect reads and moves, but do not replace scheduled delivery for idle games.

Set `ROOM_EXPIRY_HOURS` only if the default 24-hour inactivity expiry is unsuitable. Leave `ROOM_STORE_FILE`, `E2E_TEST_MODE`, and `E2E_TEST_SECRET` unset on Vercel. Redeploy after changing environment variables.

## Verify before inviting players

Use a phone and a laptop, or two independent browser profiles:

1. Create a room, share the invite link, join, and select a timed mode.
2. Ready both players, play legal moves, and check that both boards and clocks agree.
3. Refresh each device and confirm that seats, moves, clocks, and pending offers survive.
4. Open an invite link in a fresh browser profile and confirm the name dialog shows the host and match settings before joining.
5. Disconnect one device briefly, then reconnect within 30 seconds and confirm recovery from a full snapshot without a forfeit.
6. Leave one device disconnected for over 30 seconds while the other remains connected. Confirm the disconnected player loses automatically, the remaining player sees the result and returns to the main page, and the board resets with a quick piece-placement animation. Confirm the reduced-motion setting suppresses that animation.
7. Block the WebSocket transport and confirm HTTP polling continues the game.
8. Let a clock expire; verify the winner and inspect the QStash callback, including while both browsers are closed. Also inspect the scheduled disconnect checks; if both players are absent, neither side should receive an arbitrary disconnect win.
9. Test resignation, draw offer and acceptance, approved undo, and a rematch with colors swapped and both readiness states reset. Ordinary polling must not replay the placement animation.
10. Inspect application logs for errors and ensure seat tokens, authorization headers, and Redis credentials are absent.

Test preview deployments before merging. The Git integration deploys `main` to production by default. A custom domain can be added under **Settings → Domains**; update `APP_BASE_URL` and redeploy when the canonical origin changes.

## Deployment access

The connected Vercel integration must have access to the selected team. A project may be visible in a list while integration or deployment operations return a scope error. Complete the team consent link provided by the connector, then retry in the same connection. No one needs to paste account tokens into chat. The current release's team access and Upstash provider terms are already configured; a new account may require its owner to accept provider terms before provisioning resources.
