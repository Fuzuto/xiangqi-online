# Rules

The interface must identify this game as **WXF-based, simplified chase rule**.

## Pinned source

[World Xiangqi Federation, _World Xiangqi Rules_, English 2018 edition](https://www.wxf-xiangqi.org/images/wxf-rules/2018_World_XiangQi_Rules_English2018.pdf). The source is a scanned 116-page PDF; references below use its printed page numbers. Reviewed 2026-10-25.

Articles 1–3 define movement and king safety. Both checkmate and stalemate lose (3.1.A, p.6). The engine filters moves exposing the mover's general, including facing generals. Soldiers never promote to another piece; crossing the river adds sideways movement.

The natural count is **50 moves per player, 100 plies without capture** (3.2.D, pp.7–8). Article 8 (pp.17–18) counts at most ten checking moves per player; additional checks are excluded. Captures reset the count, soldier moves do not. `NO_CAPTURE_DRAW_PLIES` holds the threshold; `naturalMoveCount` adjusts the raw `halfmoveClock`.

Four appearances of the same board and side to move trigger repetition (3.2.B). A sole perpetual checker loses; mutual perpetual checks draw (20.1, p.38). This online implementation automatically adjudicates at the fourth appearance, replacing tournament arbiter warnings and requests.

## Deliberate simplification

**WXF-based, simplified chase rule:** repetitions without uninterrupted checking are draws. Full chase adjudication, alternate-threat categories, and tournament penalties are deferred. `repetitionResult` is the extension point. This is unsuitable for tournaments requiring full WXF adjudication.

Insufficient material uses only the conservative case where both sides have generals, advisors and elephants alone (3.2.A). It does not guess other dead positions. Room rules separately provide agreement, resignation and timeout results.

## Engine evaluation and verification

[xiangqi.js](https://github.com/lengyanyu258/xiangqi.js) was evaluated: BSD-2-Clause, established JavaScript API and tests, but its documented 60-move rule and generic repetition detection do not match this edition. The engine here is an independent, dependency-free TypeScript implementation; no source was copied.

Perft fixtures use [Nguyen Hong Pham's published results and Pikafish cross-check, 2026-01-11](https://www.talkchess.com/forum3/viewtopic.php?t=85880). Tests check depths 1–3 of the initial position (44, 1,920, 79,666) and five tactical positions. Dedicated tests cover blocking, cannon screens, king safety, checkmate, stalemate loss, repetition, perpetual checking and the natural count. A documented xiangqi.js checkmate position provides an additional independent fixture.
