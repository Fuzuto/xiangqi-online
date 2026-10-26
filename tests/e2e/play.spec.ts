import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RoomResponse, RoomSnapshot } from '../../src/lib/server/types';

type Player = { page: Page; context: BrowserContext; token: string; code: string };
type PlacementEvent = { name: string; delay: string };
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? '3000'}`;

async function snapshot(player: Player): Promise<RoomSnapshot> {
  const response = await player.page.request.get(`/api/rooms/${player.code}`, {
    headers: { Authorization: `Bearer ${player.token}` },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as RoomResponse).snapshot;
}

async function pair(browser: Browser): Promise<{ host: Player; guest: Player }> {
  const hostContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  await hostPage.goto('/');
  await hostPage.getByLabel('Your name', { exact: true }).fill('River');
  const created = hostPage.waitForResponse(
    (response) => response.url().endsWith('/api/rooms') && response.request().method() === 'POST',
  );
  await hostPage.getByRole('button', { name: 'Create a private room' }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const hostData = (await response.json()) as RoomResponse;
  expect(hostData.token).toBeTruthy();
  const code = hostData.snapshot.code;
  await expect(hostPage.getByTestId('room-code')).toHaveText(code);

  await guestPage.goto(`/?room=${code}`);
  const invitation = guestPage.getByRole('dialog', { name: 'Join room', exact: true });
  await expect(invitation).toBeVisible();
  await expect(invitation.getByText('River', { exact: true })).toBeVisible();
  await invitation.getByLabel('Your name', { exact: true }).fill('Mountain');
  const joined = guestPage.waitForResponse((item) =>
    item.url().endsWith(`/api/rooms/${code}/join`),
  );
  await invitation.getByRole('button', { name: 'Join room', exact: true }).click();
  const joinResponse = await joined;
  expect(joinResponse.ok()).toBe(true);
  const guestData = (await joinResponse.json()) as RoomResponse;
  expect(guestData.token).toBeTruthy();
  await expect(invitation).toHaveCount(0);
  await expect(hostPage.getByRole('button', { name: 'Ready to play', exact: true })).toBeEnabled();
  return {
    host: { page: hostPage, context: hostContext, token: hostData.token!, code },
    guest: { page: guestPage, context: guestContext, token: guestData.token!, code },
  };
}

async function recordPlacements(page: Page) {
  await page.evaluate(() => {
    const observed = window as Window & { placementEvents?: PlacementEvent[] };
    observed.placementEvents = [];
    document.addEventListener('animationstart', (event) => {
      if (event.target instanceof Element && event.target.matches('.piece-reset')) {
        observed.placementEvents!.push({
          name: event.animationName,
          delay: getComputedStyle(event.target).animationDelay,
        });
      }
    });
  });
}

async function placementEvents(page: Page): Promise<PlacementEvent[]> {
  return page.evaluate(
    () => (window as Window & { placementEvents?: PlacementEvent[] }).placementEvents ?? [],
  );
}

async function expectPlacementAnimation(page: Page) {
  await expect.poll(async () => (await placementEvents(page)).length).toBe(32);
  const placements = await placementEvents(page);
  expect(new Set(placements.map((event) => event.delay)).size).toBeGreaterThan(1);
  expect(placements.every((event) => event.name !== 'none')).toBe(true);
  await expect(page.locator('.piece-face')).toHaveCount(32);
}

async function start(host: Player, guest: Player, allowUndo = false) {
  await host.page.getByLabel('Clock mode', { exact: true }).selectOption('per-move');
  const heartbeat = host.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/rooms/${host.code}`) && response.request().method() === 'GET',
  );
  await host.page.getByLabel('Seconds per move', { exact: true }).fill('90');
  await heartbeat;
  await host.page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect(host.page.getByLabel('Seconds per move', { exact: true })).toHaveValue('90');
  await host.page.getByLabel('Seconds per move', { exact: true }).fill('60');
  if (allowUndo)
    await host.page.getByLabel('Allow takebacks by agreement', { exact: true }).check();
  const settings = host.page.waitForResponse((response) => response.url().endsWith('/settings'));
  await host.page.getByRole('button', { name: 'Save match settings' }).click();
  expect((await settings).ok()).toBe(true);
  await host.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
  await expect(host.page.getByRole('button', { name: 'Unready', exact: true })).toBeVisible();
  await guest.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
  await expect(host.page.getByRole('heading', { name: 'Red to move', exact: true })).toBeVisible();
  await expect(guest.page.getByRole('heading', { name: 'Red to move', exact: true })).toBeVisible();
}

async function move(player: Player, from: number, to: number) {
  const response = player.page.waitForResponse((item) =>
    item.url().endsWith(`/api/rooms/${player.code}/move`),
  );
  await player.page.locator(`[data-square="${from}"]`).click();
  await expect(player.page.locator(`[data-square="${to}"]`)).toHaveClass(/legal/);
  await player.page.locator(`[data-square="${to}"]`).click();
  expect((await response).ok()).toBe(true);
}

async function fixture(player: Player, scenario: 'stalemate' | 'timeout') {
  const url = new URL(player.page.url());
  test.skip(
    !['127.0.0.1', 'localhost'].includes(url.hostname),
    'Fixtures run only against the local test server.',
  );
  const response = await player.page.request.post('/api/internal/test-room', {
    headers: { 'x-test-secret': process.env.E2E_TEST_SECRET ?? 'local-e2e-fixture' },
    data: { code: player.code, scenario },
  });
  expect(response.status()).toBe(200);
}

test('two friends play a timed game, recover seats and pending offers, and rematch with swapped colors', async ({
  browser,
}) => {
  const { host, guest } = await pair(browser);
  try {
    await start(host, guest);
    await expect(host.page.getByLabel('Clock mode', { exact: true })).toHaveCount(0);
    await move(host, 54, 45);
    await expect(
      guest.page.getByRole('heading', { name: 'Black to move', exact: true }),
    ).toBeVisible();
    await move(guest, 27, 36);
    await expect.poll(async () => (await snapshot(host)).game.moves.length).toBe(2);
    await expect(host.page.getByLabel('Move list', { exact: true })).toContainText('a3');
    await host.page.getByRole('button', { name: 'Offer draw', exact: true }).click();
    await expect(
      guest.page.getByRole('button', { name: 'Accept draw', exact: true }),
    ).toBeVisible();
    const before = await snapshot(host);
    await host.page.reload();
    await guest.page.reload();
    await expect(
      guest.page.getByRole('button', { name: 'Accept draw', exact: true }),
    ).toBeVisible();
    const restoredHost = await snapshot(host);
    const restoredGuest = await snapshot(guest);
    expect(restoredHost.you.id).toBe(before.you.id);
    expect(restoredHost.you.color).toBe('red');
    expect(restoredGuest.you.color).toBe('black');
    expect(restoredHost.game.board).toEqual(before.game.board);
    expect(restoredHost.game.moves).toEqual(before.game.moves);
    expect(restoredHost.clocks.turnStartedAt).toBe(before.clocks.turnStartedAt);
    expect(restoredHost.clocks.turnRemainingMs).toBe(before.clocks.turnRemainingMs);
    expect(restoredHost.pendingOffers.draw?.by).toBe('red');
    await expect(host.page.getByRole('button', { name: 'Tap to enable sound' })).toBeVisible();

    await guest.page.getByRole('button', { name: 'Accept draw', exact: true }).click();
    await expect(
      host.page.getByRole('heading', { name: 'A drawn game', exact: true }),
    ).toBeVisible();
    await recordPlacements(host.page);
    await host.page.getByRole('button', { name: 'Request rematch', exact: true }).click();
    await guest.page.getByRole('button', { name: 'Accept rematch', exact: true }).click();
    await expect(
      host.page.getByRole('button', { name: 'Ready to play', exact: true }),
    ).toBeVisible();
    const rematch = await snapshot(host);
    expect(rematch.you.color).toBe('black');
    expect((await snapshot(guest)).you.color).toBe('red');
    expect(rematch.game.moves).toHaveLength(0);
    expect(rematch.seats.red?.ready).toBe(false);
    expect(rematch.seats.black?.ready).toBe(false);
    await expectPlacementAnimation(host.page);
    await host.page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/rooms/${host.code}`) && response.request().method() === 'GET',
    );
    expect(await placementEvents(host.page)).toHaveLength(32);
    await host.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
    await guest.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
    await expect(
      host.page.getByRole('heading', { name: 'Red to move', exact: true }),
    ).toBeVisible();
    await host.page.getByRole('button', { name: 'Resign', exact: true }).click();
    await host.page.getByRole('button', { name: 'Resign game', exact: true }).click();
    await expect(guest.page.getByRole('heading', { name: 'Red wins', exact: true })).toBeVisible();
    expect((await snapshot(host)).result?.reason).toBe('resignation');
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('an approved takeback restores the move history and active clock', async ({ browser }) => {
  const { host, guest } = await pair(browser);
  try {
    await start(host, guest, true);
    await move(host, 54, 45);
    await expect(
      guest.page.getByRole('heading', { name: 'Black to move', exact: true }),
    ).toBeVisible();
    const afterFirst = await snapshot(host);
    await move(guest, 27, 36);
    await expect(
      host.page.getByRole('heading', { name: 'Red to move', exact: true }),
    ).toBeVisible();
    await host.page.getByRole('button', { name: 'Takeback', exact: true }).click();
    const accepted = guest.page.waitForResponse((response) =>
      response.url().endsWith(`/api/rooms/${guest.code}/undo`),
    );
    await guest.page.getByRole('button', { name: 'Accept takeback', exact: true }).click();
    const acceptedResponse = await accepted;
    expect(acceptedResponse.ok()).toBe(true);
    expect(((await acceptedResponse.json()) as RoomResponse).snapshot.game.moves).toHaveLength(1);
    await expect.poll(async () => (await snapshot(host)).game.moves.length).toBe(1);
    const restored = await snapshot(host);
    expect(restored.game.board).toEqual(afterFirst.game.board);
    expect(restored.game.history).toEqual(afterFirst.game.history);
    expect(restored.game.turn).toBe('black');
    expect(restored.clocks.turnRemainingMs).toBeGreaterThan(0);
    expect(restored.clocks.turnRemainingMs).toBeLessThanOrEqual(60_000);
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('stalemate is displayed as a loss for the player with no legal moves', async ({ browser }) => {
  const { host, guest } = await pair(browser);
  try {
    await start(host, guest);
    await fixture(host, 'stalemate');
    await host.page.reload();
    await expect(host.page.locator('[data-square="15"]')).toHaveAttribute(
      'aria-label',
      'Red rook at g8',
    );
    await move(host, 15, 14);
    await expect(host.page.getByRole('heading', { name: 'Red wins', exact: true })).toBeVisible();
    await expect(guest.page.getByRole('heading', { name: 'Red wins', exact: true })).toBeVisible();
    expect((await snapshot(host)).result?.reason).toBe('stalemate');
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('an expired server clock produces the same timeout result on both devices', async ({
  browser,
}) => {
  const { host, guest } = await pair(browser);
  try {
    await start(host, guest);
    await fixture(host, 'timeout');
    await expect(host.page.getByRole('heading', { name: 'Black wins', exact: true })).toBeVisible();
    await expect(
      guest.page.getByRole('heading', { name: 'Black wins', exact: true }),
    ).toBeVisible();
    expect((await snapshot(host)).result).toEqual({ winner: 'black', reason: 'timeout' });
    expect((await snapshot(guest)).result).toEqual({ winner: 'black', reason: 'timeout' });
  } finally {
    await host.context.close();
    await guest.context.close();
  }
});

test('local board supports keyboard moves and remembers appearance preferences', async ({
  page,
}) => {
  await page.goto('/');
  const soldier = page.locator('[data-square="54"]');
  await soldier.focus();
  await soldier.press('Enter');
  await expect(soldier).toHaveAttribute('aria-pressed', 'true');
  await soldier.press('ArrowUp');
  await page.locator('[data-square="45"]').press('Enter');
  await expect(page.getByRole('heading', { name: 'Black to move', exact: true })).toBeVisible();
  await expect(page.locator('[data-square="45"]')).toHaveAttribute(
    'aria-label',
    'Red soldier at a4',
  );
  await page.getByRole('button', { name: 'Board appearance', exact: true }).click();
  await page.getByRole('button', { name: /Jade/ }).click();
  await page.getByLabel('Piece faces', { exact: true }).selectOption('symbols');
  await page.getByLabel('Colorblind-friendly pieces').check();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await expect(page.locator('.board-wrap')).toHaveClass(/board-jade/);
  await expect(page.locator('.board-wrap')).toHaveClass(/colorblind/);
  await expect(page.locator('.piece-symbol').first()).toBeVisible();
});

test('reset quickly places every piece, clears the played move, and remains playable', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-square="54"]').click();
  await page.locator('[data-square="45"]').click();
  await expect(page.getByRole('heading', { name: 'Black to move', exact: true })).toBeVisible();
  await recordPlacements(page);
  await page.getByRole('button', { name: 'New local game', exact: true }).click();
  await page.getByRole('button', { name: 'Start new game', exact: true }).click();
  await expectPlacementAnimation(page);
  await expect(page.getByRole('heading', { name: 'Red to move', exact: true })).toBeVisible();
  await expect(page.locator('[data-square="54"]')).toHaveAttribute(
    'aria-label',
    'Red soldier at a3',
  );
  await expect(page.locator('[data-square="45"]')).toHaveAttribute(
    'aria-label',
    'Empty square at a4',
  );
  await expect(page.getByLabel('Move list', { exact: true })).not.toContainText('a3');
  await page.locator('[data-square="54"]').click();
  await expect(page.locator('[data-square="45"]')).toHaveClass(/legal/);
});

test('reset respects the reduced-motion preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await recordPlacements(page);
  await page.getByRole('button', { name: 'New local game', exact: true }).click();
  await page.getByRole('button', { name: 'Start new game', exact: true }).click();
  await expect(page.locator('.piece-face')).toHaveCount(32);
  const animationNames = await page
    .locator('.piece-face')
    .evaluateAll((pieces) => pieces.map((piece) => getComputedStyle(piece).animationName));
  expect(animationNames.every((name) => name === 'none')).toBe(true);
  expect(await placementEvents(page)).toHaveLength(0);
});

test('reconnecting prevents a forfeit, then an absent opponent automatically loses after 30 seconds', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { host, guest } = await pair(browser);
  let guestClosed = false;
  try {
    await host.page.getByLabel('Clock mode', { exact: true }).selectOption('untimed');
    const settings = host.page.waitForResponse((response) => response.url().endsWith('/settings'));
    await host.page.getByRole('button', { name: 'Save match settings' }).click();
    expect((await settings).ok()).toBe(true);
    await host.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
    await guest.page.getByRole('button', { name: 'Ready to play', exact: true }).click();
    await expect(
      host.page.getByRole('heading', { name: 'Red to move', exact: true }),
    ).toBeVisible();
    await move(host, 54, 45);
    await guest.context.setOffline(true);
    await expect
      .poll(async () => (await snapshot(host)).seats.black?.connected, {
        timeout: 20_000,
      })
      .toBe(false);
    expect((await snapshot(host)).result).toBeNull();
    await guest.context.setOffline(false);
    await expect.poll(async () => (await snapshot(host)).seats.black?.connected).toBe(true);
    expect((await snapshot(host)).status).toBe('playing');
    await recordPlacements(host.page);
    await guest.context.close();
    guestClosed = true;
    await expect(host.page.getByTestId('return-notice')).toContainText(/won|win/i, {
      timeout: 40_000,
    });
    await expect(
      host.page.getByRole('heading', { name: 'A table for two', exact: true }),
    ).toBeVisible();
    expect(new URL(host.page.url()).searchParams.has('room')).toBe(false);
    await expectPlacementAnimation(host.page);
    await expect(host.page.locator('[data-square="54"]')).toHaveAttribute(
      'aria-label',
      'Red soldier at a3',
    );
    expect((await snapshot(host)).result).toEqual({ winner: 'red', reason: 'disconnect' });
  } finally {
    await host.context.close();
    if (!guestClosed) await guest.context.close();
  }
});

test('leaving a room cannot be reversed by a delayed room snapshot', async ({ browser }) => {
  const { host, guest } = await pair(browser);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let captured!: () => void;
  const inFlight = new Promise<void>((done) => {
    captured = done;
  });
  let delivered!: () => void;
  const completed = new Promise<void>((done) => {
    delivered = done;
  });
  try {
    await host.page.route(new RegExp(`/api/rooms/${host.code}$`), async (route) => {
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response });
      delivered();
    });
    await inFlight;
    await host.page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await host.page.getByRole('button', { name: 'Leave table', exact: true }).click();
    await expect(
      host.page.getByRole('heading', { name: 'A table for two', exact: true }),
    ).toBeVisible();
    release();
    await completed;
    await host.page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(
      host.page.getByRole('heading', { name: 'A table for two', exact: true }),
    ).toBeVisible();
    await expect(host.page.getByTestId('room-code')).toHaveCount(0);
    expect(new URL(host.page.url()).searchParams.has('room')).toBe(false);
  } finally {
    release();
    await host.context.close();
    await guest.context.close();
  }
});

test('a delayed leave from an older visit cannot disconnect a restored seat', async ({
  browser,
}) => {
  const { host, guest } = await pair(browser);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let captured!: () => void;
  const inFlight = new Promise<void>((done) => {
    captured = done;
  });
  let leaveCaptured = false;
  try {
    const before = await snapshot(host);
    await host.page.route(new RegExp(`/api/rooms/${host.code}/leave$`), async (route) => {
      if (leaveCaptured) {
        await route.continue();
        return;
      }
      leaveCaptured = true;
      expect(route.request().postDataJSON().presenceId).toBe(before.you.presenceId);
      captured();
      await gate;
      await route.continue();
    });
    const delayedLeave = host.page.waitForResponse((response) =>
      response.url().endsWith(`/api/rooms/${host.code}/leave`),
    );
    await host.page.getByRole('button', { name: 'Leave room', exact: true }).click();
    await host.page.getByRole('button', { name: 'Leave table', exact: true }).click();
    await inFlight;
    await expect(
      host.page.getByRole('heading', { name: 'A table for two', exact: true }),
    ).toBeVisible();
    await host.page.getByLabel('Your name', { exact: true }).fill('River');
    await host.page.getByLabel('Room code', { exact: true }).fill(host.code);
    const rejoined = host.page.waitForResponse((response) =>
      response.url().endsWith(`/api/rooms/${host.code}/join`),
    );
    await host.page.getByRole('button', { name: 'Join room', exact: true }).click();
    const restored = ((await (await rejoined).json()) as RoomResponse).snapshot;
    expect(restored.you.presenceId).not.toBe(before.you.presenceId);
    await expect(host.page.getByTestId('room-code')).toHaveText(host.code);
    release();
    expect((await delayedLeave).ok()).toBe(true);
    expect((await snapshot(guest)).seats.red?.connected).toBe(true);
    expect((await snapshot(host)).you.presenceId).toBe(restored.you.presenceId);
    await expect(host.page.getByTestId('room-code')).toHaveText(host.code);
  } finally {
    release();
    await host.context.close();
    await guest.context.close();
  }
});
