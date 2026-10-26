# Release verification

Verified locally on 2026-10-25:

- 55 unit/backend tests pass: 25 rules tests and 30 room, clock, security, concurrency, and HTTP boundary tests.
- All 6 Playwright browser cases pass against a production build, using two isolated player contexts where appropriate.
- The browser cases cover timed play, refresh recovery of seats/board/clocks/offers, draw agreement, resignation, color-swapped rematch, approved undo, stalemate loss, timeout, keyboard play, appearance persistence, and leaving while a delayed read is in flight.
- TypeScript, ESLint, and the optimized Next.js build pass.
- Taste Skill inspected the production interface at 1440px, 768px, and 390px: 0 failures, 0 warnings. Every final screenshot was visually reviewed. The direction is True-black flat, seed 1192223736; see `.taste-skill/design-notes.md` for the critique.

The source is on the local `main` branch with separate scaffold, rules, backend, interface, and release-documentation commits.

## Remaining external verification

The connected Vercel account returned a team permission error during integration inspection. No cloud project, GitHub repository, or deployment was created. Publishing requires team access and configured Upstash Redis/QStash services.

Live Redis atomic operations and event delivery, native Vercel WebSocket upgrades/reconnect, and actual idle timeout callback delivery still require verification on that configured deployment. Local tests use the development file store; it is refused in normal production. The local file lock has basic crash recovery and is not a production persistence layer.

Full perpetual-chase adjudication and 3D pieces are deliberately deferred, as specified in the brief. The UI and RULES.md identify the simplified chase rule.
