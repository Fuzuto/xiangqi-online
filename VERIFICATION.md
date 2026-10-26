# Release verification

Latest behavior update verified locally on 2026-10-26:

- 71 unit/backend tests pass: 25 rules tests, 40 room/clock/security/concurrency/HTTP tests, and 6 public-invitation tests.
- All 10 Playwright browser cases pass together against the latest production build, using isolated desktop and 390px guest contexts where appropriate. The consolidated run finished in 1.8 minutes.
- The browser cases cover the invite name dialog and opponent details, timed play, refresh recovery of seats/board/clocks/offers, draw agreement, resignation, color-swapped rematch, approved undo, stalemate loss, timeout, keyboard play, appearance persistence, and leaving while a delayed read is in flight.
- New reset checks observe 32 actual staggered piece-placement animations, verify a playable fresh board, confirm ordinary polling does not replay the rematch animation, and verify reduced-motion preferences suppress it.
- A real-time browser case reconnects an absent player before the deadline, verifies the game continues, then closes that player's browser and verifies automatic loss after 30 seconds, the winner's result notice, return to the main page, and board reset.
- A delayed-leave regression restores the seat with a new presence identifier before releasing an older leave request. The restored visit remains connected.
- TypeScript, ESLint, and the optimized Next.js build pass.
- The updated production interface passed Taste Skill inspection at 1440px, 768px, and 390px with 0 failures and 0 warnings. All six viewport screenshots were reviewed. The real invite dialog was also reviewed at all three widths for overflow, name-field autofocus, and Escape-to-home behavior. The direction remains True-black flat, seed 1192223736; see `.taste-skill/design-notes.md` for the critique.

The source is on the local `main` branch with separate scaffold, rules, backend, interface, and release-documentation commits.

## Public production release

Published on 2026-10-26:

- Public repository: [Fuzuto/xiangqi-online](https://github.com/Fuzuto/xiangqi-online), with the original local commit history on `main`.
- Public production app: [xiangqi-online-one.vercel.app](https://xiangqi-online-one.vercel.app), accessible without Vercel authentication.
- Vercel project `xiangqi-online` uses Node.js 24 and Fluid compute in `iad1`.
- Owned production Upstash Redis and QStash resources use free plans. Redis automatic paid upgrades and production packs are disabled.
- Live API checks passed for Redis room creation, safe invitation metadata, authenticated join, readiness, two legal moves, duplicate move safety, seat recovery, approved undo, draw agreement, and color-swapped rematch.
- Two native authenticated WebSocket connections received snapshots and confirmed move pushes through Redis streams.
- Unauthorized room reads returned 401 and the production test-fixture endpoint returned 404.
- A separate 10-second timed game was left idle with every socket closed and no subsequent room API reads. After its deadline, a direct read-only Redis inspection found the persisted timeout result already finalized. This verifies actual QStash callback delivery independently of lazy read enforcement.
- Production build and public HTTP 200 checks passed. GitHub Actions runs types, lint, unit tests, build, and browser tests against `pnpm start`, using the production bundle rather than a development server.

## Remaining limits

Free provider quotas apply. Local development tests use the file store; it is refused in normal production. The local file lock has basic crash recovery and is not a production persistence layer.

Full perpetual-chase adjudication and 3D pieces are deliberately deferred, as specified in the brief. The UI and RULES.md identify the simplified chase rule.
