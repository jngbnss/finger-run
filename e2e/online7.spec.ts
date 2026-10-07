import { expect, test, type Browser, type Page } from "@playwright/test";
import { FakeBackend, openPlayer, watchErrors } from "./bridge";

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 720 }, isMobile: false },
  { name: "iphone", viewport: { width: 390, height: 844 }, isMobile: true },
  { name: "android", viewport: { width: 360, height: 740 }, isMobile: true },
];

async function player(browser: Browser, backend: FakeBackend, i: number, errors: string[]) {
  const device = VIEWPORTS[i % VIEWPORTS.length];
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: device.isMobile,
    hasTouch: device.isMobile,
    deviceScaleFactor: 1,
  });
  // Each player's synthetic finger moves at a different rate, so finish order is known.
  const page = await openPlayer(context, backend, `user-${i}`, {
    camera: { mode: "synthetic", amplitude: 0.09 - i * 0.006, hz: 5 },
  });
  watchErrors(page, `p${i}`, errors);
  return { page, device: device.name };
}

async function joinByLink(page: Page, code: string, nickname: string) {
  await page.goto(`./?room=${code}`);
  await page.getByLabel("Nickname").fill(nickname);
  await expect(page.getByLabel("Room code")).toHaveValue(code);
  await page.getByRole("button", { name: "JOIN ROOM" }).click();
  await expect(page.getByTestId("room-code")).toHaveText(code);
}

async function expectInViewport(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  const size = page.viewportSize()!;
  expect(box, `${name} has a box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 0.5);
  // No horizontal scrolling on the page.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test("7 players: create, join by link, ready, synced countdown, finish, same results; 8th gets ROOM_FULL", async ({
  browser,
}) => {
  // Seven WebGL pages on one machine are slow to set up.
  test.setTimeout(420_000);
  const backend = new FakeBackend();
  const errors: string[] = [];
  const players = [];
  for (let i = 0; i < 7; i++) players.push(await player(browser, backend, i, errors));
  const host = players[0].page;

  // Host creates the room.
  await host.goto("./");
  await host.getByRole("button", { name: /^ONLINE/ }).click();
  await host.getByLabel("Nickname").fill("Host");
  await host.getByRole("button", { name: "CREATE ROOM" }).click();
  const code = (await host.getByTestId("room-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await expect(host.getByLabel("Share link")).toHaveValue(new RegExp(`\\?room=${code}$`));

  // Six friends open the shared link.
  for (let i = 1; i < 7; i++) await joinByLink(players[i].page, code, `Runner${i}`);
  for (const { page } of players) {
    await expect(page.getByTestId("player-list").locator("li")).toHaveCount(7);
  }

  // An 8th player is refused.
  const extra = await player(browser, backend, 7, errors);
  await extra.page.goto(`./?room=${code}`);
  await extra.page.getByLabel("Nickname").fill("Late");
  await extra.page.getByRole("button", { name: "JOIN ROOM" }).click();
  await expect(extra.page.getByRole("alert").filter({ hasText: "ROOM_FULL" })).toBeVisible();
  await extra.page.context().close();
  expect(backend.server.roomByCode(code)!.players).toHaveLength(7);

  // Everyone turns on the (synthetic) camera and presses READY.
  for (const { page } of players) {
    await page.getByRole("button", { name: "ENABLE CAMERA" }).click();
  }
  for (const { page } of players) {
    await expect(page.getByTestId("camera-status")).toHaveText("Tracking", { timeout: 20_000 });
  }
  await expect(host.getByTestId("player-list").getByText("Camera ready")).toHaveCount(7);

  await expect(host.getByRole("button", { name: "START RACE" })).toBeDisabled();
  for (const { page, device } of players) {
    if (device !== "desktop") await expectInViewport(page, "READY");
    await page.getByRole("button", { name: "READY", exact: true }).click();
  }
  await expect(host.getByTestId("ready-tag").filter({ hasText: /^READY$/ })).toHaveCount(7);
  if (players[0].device === "desktop") await expectInViewport(host, "START RACE");
  await host.getByRole("button", { name: "START RACE" }).click();

  // Countdown shows on every device at once (checked in parallel: it lasts about 5s).
  await Promise.all(players.map(({ page }) => expect(page.getByTestId("countdown")).toBeVisible()));
  // Same race id and server start time on every device.
  const ids = [];
  for (const { page } of players) {
    const standings = page.locator(".standings");
    await expect(standings).toHaveAttribute("data-race-id", /.+/);
    ids.push([await standings.getAttribute("data-race-id"), await standings.getAttribute("data-start-at")]);
  }
  expect(new Set(ids.map((x) => x.join("|"))).size).toBe(1);
  for (const { page } of players) await expect(page.getByTestId("standings").locator("li")).toHaveCount(7);

  // Everyone runs and finishes; all devices show the identical leaderboard.
  // A race lasts at most 60s (then DNF), plus the 5s countdown.
  await Promise.all(players.map(({ page }) => expect(page.getByTestId("results")).toBeVisible({ timeout: 80_000 })));
  const boards = [];
  for (const { page } of players) {
    boards.push(
      await page
        .getByTestId("results")
        .locator("tbody tr")
        .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).innerText.replace(/\s*\(you\)/, "").replace(/\s+/g, " "))),
    );
  }
  expect(boards[0]).toHaveLength(7);
  for (const b of boards) expect(b).toEqual(boards[0]);
  // Every row is a finish time or a DNF, ranks ascend, and every player appears once.
  expect(boards[0].every((row) => /(\d+\.\d{2}s|DNF \(\d+\.\dm\))$/.test(row))).toBe(true);
  const ranks = boards[0].map((row) => Number(row.split(" ")[0]));
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  for (const name of ["Host", "Runner1", "Runner2", "Runner3", "Runner4", "Runner5", "Runner6"]) {
    expect(boards[0].filter((row) => row.includes(` ${name} `) || row.includes(` ${name}`))).toHaveLength(1);
  }

  for (const { page, device } of players.slice(0, 3)) {
    if (device !== "desktop") await expectInViewport(page, "REMATCH");
  }
  expect(errors).toEqual([]);
});
