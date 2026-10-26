# Xiangqi Online interface

Style: True-black flat, seed 1192223736. No redraws. Product hues replace the dealt lime as allowed by the sheet: red playing pieces and warm neutral carved tokens. This is an app screen; game geometry, clocks, tokens, and notation are real game data.

Screen question: whose turn is it, and where can I move? The live SVG board is the largest element. The distinct face is the river, two palaces, double-ring black tokens, and red glyphs. The interface surrounds a shared table instead of imitating a dashboard.

Objects: 90 intersections, 32 pieces, two colors, seven piece kinds, one active turn, three clock modes, private code, two named seats, ordered move pairs, offers, result. Names come from guests, moves from the engine, countdowns from authoritative timestamps. No invented people or metrics. Initial board is playable local pass-and-play, clearly labeled.

Desktop grid: 210 sidebar + centered canvas with 64px padding, a fluid board, 24px gap and 300–380px rail. Phone: top bar, one full-width board, room controls, status, moves. Appearance is a modal; preferences stay local. No external photography or sample data. The SVG is the actual playable product.

Final inspection used the production build at 1440, 768, and 390 pixels: 0 failures and 0 warnings. All six final screenshots were opened and reviewed. Three look rounds fixed initial page scrolling, minimum type sizes, contrast, a crowded phone header, and the desktop board height.

## Final app-screen critique

1. The largest object is the live board. Active player treatment and the turn heading answer whose move it is; legal destinations appear after selection. The top action focuses the online-room form.
2. The board, player strips and toolbar share edges. The rail uses consistent gutters; its panels keep their natural content heights. The board scales with desktop height. The phone has one column without horizontal page scrolling.
3. Red identifies game data and the Xiangqi mark; primary actions use ivory. Warm neutrals connect the interface to the round playing tokens. The river and palaces make the product recognizable.
4. Move totals derive from the move array. Clock displays use the same server timestamp and remaining-time snapshot. No sample totals, names, or clocks are invented.
5. Untimed clocks show a dash. The empty move list explicitly describes a fresh board. Errors remain beside the table and preserve the last valid position.
6. Move targets are dots and capture targets are rings on the actual board. The last origin and destination remain marked. Piece colors also have different rings, and letter faces include side initials.
7. At 390px the navigation folds, the product remains named, and the whole board fits the page width. Room setup, actions, and the move list follow it. The top Play online action focuses the room form when it is below the fold.

The source lint warnings are intentional: shadows belong to the floating sound prompt and open mobile menu; zero padding formats clocks; em dashes occur in the title/clock notation. The final browser inspector has no warnings. No inspector rules were disabled. No photographs, generated raster images, sample people, or placeholder data need replacing.

## Join and reset update

The existing True-black flat direction is retained. Opening an invite now uses a native modal with the host's real name, side and clock settings, an autofocus name field, and one join action. Desktop, tablet and 390px phone screenshots were reviewed; the dialog fits all three without horizontal overflow, and Escape returns home.

Initial setup, local reset, rematch and return from a disconnect result place the pieces with staggered translation, scale and opacity. Placement completes in roughly 0.54 seconds, stays inside the board, and does not replay on presence polls. Reduced-motion disables placement travel entirely.

The main screen remains unchanged in composition. The updated production build passed the 1440px/768px/390px inspector with zero failures and zero warnings, and all six updated page screenshots were reviewed. No new imagery or placeholder product content was introduced; River and Mountain appear only in automated test fixtures and review screenshots.

## Wide-screen board update

Retained True-black flat, seed 1192223736, with no redraws or new sample content. The screen still answers whose turn it is and where to move; its largest object is the playable board, with the river, palaces and red glyphs carrying its identity.

Removed the 650px ceiling and sized the board from the available screen height, up to 1600px. On wide desktops both clocks share one row above it. At 981–1190px the clocks retain their separate rows so player names have room. The board, title, toolbar and footer share edges; the controls sit 24px from the board in a compact column, and their panels keep their natural heights. An initial two-column control layout produced a ragged-row warning and over-wide forms, so it was replaced with this centered group.

Measured production-build board widths, before → after:

| Viewport    | Before |  After |
| ----------- | -----: | -----: |
| 1440 × 900  |  508px |  644px |
| 1920 × 1080 |  650px |  807px |
| 2560 × 1440 |  650px | 1133px |
| 390 × 844   |  358px |  358px |

Ten viewport checks from 390px through 3840px found no horizontal overflow; the 4K board measured 1600px. A real soldier move, legal-target feedback and board flipping passed at 1920px. The five-width inspector (1440, 1920, 2560, 768, 390) reported zero failures and zero warnings; all ten final fold/page images were reviewed. The existing seven-point critique still holds: data and clocks remain authoritative, missing values stay dashes, legal destinations retain their marks, and phone navigation folds without hiding the board. The CSS source warnings remain the two intentional overlay shadows; no checks were disabled.

The board itself fits the tested desktop heights. Its toolbar and footer may require a short vertical scroll when the board fills the screen.
