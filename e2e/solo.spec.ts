import { expect, test } from "@playwright/test";
import { watchErrors } from "./bridge";

test("camera permission denied falls back to the slider and the race still works", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // The injected camera rejects with a NotAllowedError, exactly like a user clicking "Block".
  await context.addInitScript(() => {
    window.__FINGER_RUN_TEST__ = { camera: { mode: "deny" } };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  watchErrors(page, "solo", errors);

  await page.goto("./");
  await page.getByRole("button", { name: /^SOLO/ }).click();
  // Camera is never requested before the click.
  await expect(page.getByTestId("camera-status")).toHaveText("Camera off");
  await page.getByRole("button", { name: "ENABLE CAMERA" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "CAMERA_PERMISSION_DENIED" })).toBeVisible();

  await page.getByRole("button", { name: "USE SLIDER" }).click();
  const slider = page.getByRole("slider", { name: /POWER/ });
  await expect(slider).toBeVisible();
  await slider.focus();
  await page.keyboard.press("End");
  await expect(page.locator("output[for=power]")).toHaveText("100");

  const start = page.getByRole("button", { name: "START" });
  await start.scrollIntoViewIfNeeded();
  const box = (await start.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await start.click();
  // Simulation time follows rendered frames (max 50ms each), so a busy headless browser runs slower than real time.
  await expect(page.locator(".hud .phase")).toHaveText("RUNNING", { timeout: 20_000 });
  await expect(page.locator(".hud")).toContainText("FINISHED", { timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: "FINISH!" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("a browser with no camera shows CAMERA_NOT_FOUND and offers the slider", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: /^SOLO/ }).click();
  await page.getByRole("button", { name: "ENABLE CAMERA" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "CAMERA_NOT_FOUND" })).toBeVisible();
  await expect(page.getByRole("button", { name: "USE SLIDER" })).toBeVisible();
});

test("synthetic camera drives solo power without any slider", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    window.__FINGER_RUN_TEST__ = { camera: { mode: "synthetic", amplitude: 0.09, hz: 5 } };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  watchErrors(page, "solo-cam", errors);
  await page.goto("./");
  await page.getByRole("button", { name: /^SOLO/ }).click();
  await page.getByRole("button", { name: "ENABLE CAMERA" }).click();
  await expect(page.getByTestId("camera-status")).toHaveText("Calibrating");
  await expect(page.getByTestId("camera-status")).toHaveText("Tracking", { timeout: 10_000 });
  // Exact power depends on how many frames a loaded CI machine samples; any clear signal is enough here.
  await expect
    .poll(async () => Number(await page.getByTestId("camera-power").textContent()), { timeout: 15_000 })
    .toBeGreaterThan(10);
  await page.getByRole("button", { name: "START", exact: true }).click();
  // The camera alone moves the runner (finishing is covered by the other tests).
  await expect
    .poll(async () => Number((await page.locator(".hud").innerText()).match(/([\d.]+) \/ 100 m/)?.[1] ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThan(20);
  expect(errors).toEqual([]);
  await context.close();
});

test("ONLINE without Supabase settings is disabled but SOLO still works", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: /^ONLINE/ }).click();
  await expect(page.getByText("REALTIME_CONFIG_MISSING")).toBeVisible();
  await expect(page.getByRole("button", { name: "CREATE ROOM" })).toBeDisabled();
  await page.getByRole("button", { name: "SOLO", exact: true }).click();
  await expect(page.getByRole("button", { name: "START", exact: true })).toBeEnabled();
});
