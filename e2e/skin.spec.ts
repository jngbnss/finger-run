import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { FakeBackend, openPlayer, watchErrors } from "./bridge";

/** Encodes an RGB PNG whose pixels come from `color(x, y)`. */
function encodePng(w: number, h: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(color(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 64x64 drawing: an orange figure on white paper. */
const pngBytes = () =>
  encodePng(64, 64, (x, y) => (x >= 22 && x < 42 && y >= 8 && y < 56 ? [255, 122, 26] : [250, 250, 248]));

test("a player's drawing is cut out, rigged and shared with the room; turning it off unshares it", async ({ browser }) => {
  const backend = new FakeBackend();
  const errors: string[] = [];
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await openPlayer(ctx, backend, `skin-${i}`, { camera: { mode: "synthetic" } });
    watchErrors(page, `s${i}`, errors);
    pages.push(page);
  }
  const [host, guest] = pages;
  await host.goto("./");
  await host.getByRole("button", { name: /^ONLINE/ }).click();
  await host.getByLabel("Nickname").fill("Painter");
  await host.getByRole("button", { name: "CREATE ROOM" }).click();
  const code = (await host.getByTestId("room-code").textContent())!.trim();
  await guest.goto(`./?room=${code}`);
  await guest.getByLabel("Nickname").fill("Friend");
  await guest.getByRole("button", { name: "JOIN ROOM" }).click();
  await expect(guest.getByTestId("player-list").locator("li")).toHaveCount(2);

  // Host uploads a drawing; the skin toggle is on by default.
  await host.getByLabel("Drawing file (PNG or JPG, up to 5MB)").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: pngBytes(),
  });
  // The joint editor opens on the cut-out; accept the guessed joints.
  const editor = host.getByRole("dialog", { name: "Set up your runner" });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("slider")).toHaveCount(15);
  await editor.getByRole("button", { name: "USE THIS RUNNER" }).click();
  await expect(editor).toHaveCount(0);
  await expect(host.getByTestId("skin-note")).toHaveText(/shared with this room only/);
  const thumb = guest.getByRole("img", { name: "Painter's skin" });
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  expect(backend.server.skins.size).toBe(1);

  // Turning the toggle off stops sharing for everyone.
  await host.getByLabel("Race as my drawing and share it with this room").uncheck();
  await expect(thumb).toHaveCount(0);
  await expect.poll(() => backend.server.skins.size).toBe(0);
  expect(errors).toEqual([]);
});

test("SOLO: upload a drawing, move a joint with the keyboard, and race as it", async ({ page }) => {
  const errors: string[] = [];
  watchErrors(page, "solo-char", errors);
  await page.goto("./");
  await page.getByRole("button", { name: /^SOLO/ }).click();
  await page.getByLabel("Drawing file (PNG or JPG, up to 5MB)").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: pngBytes(),
  });
  const editor = page.getByRole("dialog", { name: "Set up your runner" });
  await expect(editor).toBeVisible();
  const head = editor.locator("[data-joint=head]");
  const before = await head.getAttribute("cy");
  await head.focus();
  await page.keyboard.press("ArrowUp");
  await expect(head).not.toHaveAttribute("cy", before!);
  await editor.getByRole("button", { name: "USE THIS RUNNER" }).click();
  await expect(page.getByTestId("character-status")).toHaveText("Racing as your drawing");
  await expect(page.getByRole("img", { name: "Your cut-out runner" })).toBeVisible();
  await page.getByRole("button", { name: "Edit joints" }).click();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a photo with no character on it explains what went wrong", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: /^SOLO/ }).click();
  // A blank sheet: nothing to cut out.
  const blank = encodePng(16, 16, () => [250, 250, 250]);
  await page.getByLabel("Drawing file (PNG or JPG, up to 5MB)").setInputFiles({ name: "blank.png", mimeType: "image/png", buffer: blank });
  await expect(page.getByRole("alert").filter({ hasText: "No character found" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
