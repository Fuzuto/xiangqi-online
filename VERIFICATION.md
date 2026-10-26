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

## Remaining external verification

The connected Vercel account returned a team permission error during integration inspection. No cloud project, GitHub repository, or deployment was created. Publishing requires team access and configured Upstash Redis/QStash services.

Live Redis atomic operations and event delivery, native Vercel WebSocket upgrades/reconnect, and actual idle timeout callback delivery still require verification on that configured deployment. Local tests use the development file store; it is refused in normal production. The local file lock has basic crash recovery and is not a production persistence layer.

Full perpetual-chase adjudication and 3D pieces are deliberately deferred, as specified in the brief. The UI and RULES.md identify the simplified chase rule.
