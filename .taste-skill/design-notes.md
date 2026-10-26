# Xiangqi Online interface

Style: True-black flat, seed 1192223736. No redraws. Product hues replace the dealt lime as allowed by the sheet: red playing pieces and warm neutral carved tokens. This is an app screen; game geometry, clocks, tokens, and notation are real game data.

Screen question: whose turn is it, and where can I move? The live SVG board is the largest element. The distinct face is the river, two palaces, double-ring black tokens, and red glyphs. The interface surrounds a shared table instead of imitating a dashboard.

Objects: 90 intersections, 32 pieces, two colors, seven piece kinds, one active turn, three clock modes, private code, two named seats, ordered move pairs, offers, result. Names come from guests, moves from the engine, countdowns from authoritative timestamps. No invented people or metrics. Initial board is playable local pass-and-play, clearly labeled.

Desktop grid: 210 sidebar + 76 gutters + fluid board + 30 gap + 310 rail. Phone: top bar, one full-width board, room controls, status, moves. Appearance is a modal; preferences stay local. No external photography or sample data. The SVG is the actual playable product.

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
