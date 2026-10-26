# Xiangqi Online

Private Chinese chess for two friends, with guest names, invite links, server-owned clocks, and seats that survive a refresh. The first release uses an SVG board and a shared TypeScript rules engine.

**Rules:** WXF-based, simplified chase rule. Repeated checking is adjudicated; full perpetual-chase adjudication is deferred. Read [RULES.md](RULES.md) before competitive play.

## Run locally

Use Node.js 22 or later and pnpm. From this folder:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. Create a room in one browser and join its invite link in a second browser profile or private window. Separate profiles matter: two tabs in the same profile share the seat token.

No service account is required for local development. Without Redis credentials, the server uses its local development store. This fallback is for a single local application instance and is refused on Vercel. For phone testing, open the computer's LAN address and allow the development server through your local firewall.

For production-like local testing, configure Redis in `.env.local` using [.env.example](.env.example), then build and run:

```sh
pnpm build
pnpm start
```

The normal Next.js local server uses the polling fallback. Testing native Vercel WebSocket upgrades locally requires Vercel CLI 54.14.2 or later and `vercel dev`; see [Vercel's local development documentation](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#local-development).

## Play

1. Enter your guest name and create a private room.
2. Share the invite link. It opens a name dialog showing the host and match settings; the second player enters their name and joins from that dialog.
3. The host chooses sides, one of the three clock modes, and whether undo requests are allowed.
4. Both players choose **Ready to play**. Red moves first.
5. Select a piece, then a highlighted destination. Black sees the board from the opposite side.

Clock modes are **Untimed**, **Increment**, and **Per-move**. Increment is omitted on each player's first move. A disconnected player's clock keeps running. A short abort window is available before the first move. During an active game, a player who remains absent for 30 seconds automatically loses if the opponent is still connected. Reconnecting before the deadline restores the seat and cancels that disconnect loss. If both players are absent, the server does not arbitrarily award either side a disconnect win.

After a disconnect result, the remaining player sees a result notice and returns to the main page. The local board resets with a quick staggered piece-placement animation. The same reset animation runs for a new local game and a rematch, and respects reduced-motion preferences. Draw and undo requests need the other player's approval. A rematch swaps colors and returns both players to the ready screen.

Appearance and sound preferences are local to each player. Audio needs a gesture after each page load; visual alerts remain available when sound is muted or locked. Clearing browser storage removes that browser's secret seat token, so it cannot reclaim the seat.

## Commands

| Command          | Purpose                          |
| ---------------- | -------------------------------- |
| `pnpm dev`       | Start the local server           |
| `pnpm build`     | Create a production build        |
| `pnpm start`     | Run that build                   |
| `pnpm typecheck` | Check TypeScript                 |
| `pnpm lint`      | Check source conventions         |
| `pnpm test`      | Run rules and backend unit tests |
| `pnpm test:e2e`  | Run the browser tests            |
| `pnpm format`    | Format source files              |

Install a browser before running end-to-end tests:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

Browser tests use two isolated contexts to cover private-room play, seat recovery, results, and rematches. Controlled fixture positions exercise timeout and stalemate behavior without playing an entire game. Fixture endpoints require a local test secret, are enabled only by `E2E_TEST_MODE`, and are disabled on Vercel. They must never be enabled in a public environment.

## Architecture

`src/lib/xiangqi` contains the pure rules engine. It has no framework, browser, or persistence dependencies. The client uses it for hints; the server independently validates every move.

`src/lib/server` owns rooms, identity, settings, actions, and time. Redis stores a versioned JSON record for each room. An atomic compare-and-set rejects competing updates, and the operation retries against the latest record. Client move sequence numbers detect stale boards, and idempotency keys make move retries safe.

Seat tokens are random secrets. The browser stores its token locally; the server stores a hash. Authenticated HTTP calls carry the token in an authorization header. Public snapshots omit token hashes and expose only safe seat details. Room codes are unguessable invitations, not seat credentials.

HTTP commands are the source of confirmed moves. Every game action includes the snapshot's `gameId`; moves also carry `branchId`, the expected move sequence, and an idempotency key. Rematches change the game ID, and approved takebacks change the branch ID, so a delayed command cannot affect a new game or replay an undone move. Stale requests return the current snapshot.

Restoring a seat issues a new visit identifier, `you.presenceId`. Leave requests include that identifier, so an older delayed departure cannot disconnect the restored visit. Ordinary room reads cannot revive an explicit departure; restoring it uses the authenticated join endpoint.

Accepting or declining a draw or takeback also includes that pending offer's `offerId`. An answer to an old offer cannot accept a newer one. Online snapshots include a move log with sequence numbers, server timestamps, captures, notation, and both remaining clocks.

Realtime delivery is an optimization: Redis coordinates changes between function instances, sockets reconnect with backoff, and snapshots can always be recovered through HTTP polling. No game depends on an individual socket or function remaining alive.

The server records when the active turn began and the remaining time at that instant. The client estimates its clock offset from the server response and displays a countdown; it cannot decide a result. Room reads, writes, and protected scheduled callbacks enforce clock and disconnect deadlines against persisted server timestamps. Rolling QStash presence checks also cover untimed matches. Repeated or outdated callbacks cannot finalize a newer turn or forfeit a player who reconnected in time.

Requests validate input and enforce limits for IPs and rooms. Redis outages produce retryable errors instead of falling back to an independent game state. The inactivity expiry is configurable and defaults to 24 hours.

## API

All endpoints exchange JSON. Authenticated requests use `Authorization: Bearer <seat-token>`.

| Endpoint                           | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `POST /api/rooms`                  | Create a room with `{ "name": "Guest" }`                        |
| `POST /api/rooms/{code}/join`      | Claim the second seat or restore an existing seat               |
| `GET /api/rooms/{code}/invite`     | Read only the host and match details needed by the name dialog  |
| `GET /api/rooms/{code}`            | Recover a complete authorized snapshot                          |
| `POST /api/rooms/{code}/settings`  | Change host settings before play                                |
| `POST /api/rooms/{code}/ready`     | Update readiness                                                |
| `POST /api/rooms/{code}/move`      | Submit a legal move with sequence and idempotency key           |
| `POST /api/rooms/{code}/resign`    | Resign                                                          |
| `POST /api/rooms/{code}/draw`      | Offer, accept, or decline a draw                                |
| `POST /api/rooms/{code}/undo`      | Request, accept, or decline an undo                             |
| `POST /api/rooms/{code}/rematch`   | Request or accept a rematch                                     |
| `POST /api/rooms/{code}/abort`     | Cancel during the initial abort window                          |
| `POST /api/rooms/{code}/leave`     | Mark a player as departed and start the disconnect grace period |
| `POST /api/internal/timeout-check` | Protected scheduled deadline check                              |

Successful room responses contain `{ "snapshot": ... }`, plus a raw token only when a new seat is issued. Read the shared types in `src/lib/server/types.ts` for the snapshot fields.

## Deploy

See [DEPLOY.md](DEPLOY.md) for GitHub, Vercel, Redis, QStash, and post-deployment checks. Configure secrets in your hosting account; never commit `.env.local`, expose server credentials through `NEXT_PUBLIC_` variables, or include authorization headers in logs.

The project is ready to build locally. A working local build does not prove that a production Redis integration, scheduled callback, or WebSocket transport has been configured or tested.
