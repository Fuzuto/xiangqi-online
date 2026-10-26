import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RoomResponse, RoomSnapshot } from '../../src/lib/server/types';

type Player = { page: Page; context: BrowserContext; token: string; code: string };
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
  const guestContext = await browser.newContext({ baseURL });
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
  await guestPage.getByLabel('Your name', { exact: true }).fill('Mountain');
  await expect(guestPage.getByLabel('Room code', { exact: true })).toHaveValue(code);
  const joined = guestPage.waitForResponse((item) =>
    item.url().endsWith(`/api/rooms/${code}/join`),
  );
  await guestPage.getByRole('button', { name: 'Join room', exact: true }).click();
  const joinResponse = await joined;
  expect(joinResponse.ok()).toBe(true);
  const guestData = (await joinResponse.json()) as RoomResponse;
  expect(guestData.token).toBeTruthy();
  await expect(hostPage.getByRole('button', { name: 'Ready to play', exact: true })).toBeEnabled();
  return {
    host: { page: hostPage, context: hostContext, token: hostData.token!, code },
    guest: { page: guestPage, context: guestContext, token: guestData.token!, code },
  };
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
    await guest.page.getByRole('button', { name: 'Accept takeback', exact: true }).click();
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
