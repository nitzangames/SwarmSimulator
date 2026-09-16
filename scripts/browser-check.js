import { chromium, devices } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const url = process.env.SWARM_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chrome", headless: true });
await mkdir("test-results", { recursive: true });
const errors = [];
const desktop = await browser.newContext({
  viewport: { width: 1440, height: 1040 },
  deviceScaleFactor: 1,
});
const page = await desktop.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
try {
  await page.goto(url);
  assert.equal(await page.title(), "Murmur — Three.js + Typed Arrays Swarm");
  await page.waitForTimeout(5000);
  assert.equal(await page.locator("#canvas-error").isVisible(), false);
  assert.equal(await page.locator("#draw-value").innerText(), "1");
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  console.log(
    "Desktop initial:",
    await page.locator(".population-number").innerText(),
    "FPS:",
    await page.locator("#fps-value").innerText(),
  );
  await page.getByRole("button", { name: "Pause simulation", exact: true }).click();
  assert.equal(await page.locator("#pause-overlay").isVisible(), true);
  const count = await page.locator("#population-value").innerText();
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#population-value").innerText(), count);
  await page.getByRole("button", { name: "Resume simulation", exact: true }).click();
  await page.getByRole("button", { name: "Vortex", exact: true }).click();
  assert.equal(await page.locator("#cohesion").inputValue(), "1.1");
  assert.equal(await page.locator("#scene-name").innerText(), "Vortex");
  await page.locator("#population").fill("600");
  assert.equal(await page.locator("#auto-scale").isChecked(), false);
  const manualCount = await page.locator("#population-value").innerText();
  await page.waitForTimeout(1300);
  assert.equal(await page.locator("#population-value").innerText(), manualCount);
  await page.locator("#population").fill("1000");
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("#population-value").innerText(), "300,000");
  assert.equal(await page.locator("#draw-value").innerText(), "1");
  assert.equal(await page.locator("#canvas-error").isVisible(), false);
  console.log("Full 300,000-agent pool renders in one draw call.");
  await page.locator("#population").fill("600");
  await page.getByRole("button", { name: "Attract", exact: false }).click();
  await page.mouse.move(550, 480);
  await page.mouse.down();
  await page.mouse.move(650, 520);
  assert.equal(await page.locator("#pointer-ring").isVisible(), true);
  await page.mouse.up();
  assert.equal(await page.locator("#pointer-ring").isVisible(), false);
  await page.getByRole("button", { name: "Behind the swarm" }).click();
  assert.equal(await page.locator("#about").isVisible(), true);
  assert.equal(await page.locator("#about pre code").count(), 3);
  assert.equal(
    await page
      .locator(
        '#about a[href="https://github.com/Data-Oriented-Design-for-Games/data-oriented-design"]',
      )
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(
        '#about a[href="https://www.manning.com/books/high-performance-unity-game-development"]',
      )
      .count(),
    1,
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#about").isVisible(), false);
  await page.getByRole("button", { name: "Stream", exact: true }).click();
  await page.getByRole("button", { name: "Find my limit" }).click();
  assert.equal(await page.locator("#auto-scale").isChecked(), true);
  await page.getByRole("button", { name: "Murmuration", exact: true }).click();
  await page.getByRole("button", { name: "Reseed flock", exact: true }).click();
  await page.waitForTimeout(20000);
  console.log(
    "Desktop adaptive:",
    await page.locator(".population-number").innerText(),
    "FPS:",
    await page.locator("#fps-value").innerText(),
    "CPU:",
    await page.locator("#cpu-value").innerText(),
  );
  await page.screenshot({
    path: "test-results/desktop-settled.png",
    fullPage: true,
  });
  const hasContextLossExtension = await page.evaluate(() => {
    const canvas = document.getElementById("swarm");
    const extension = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 600);
    return true;
  });
  if (hasContextLossExtension) {
    await page.locator("#canvas-error").waitFor({ state: "visible" });
    await page.locator("#canvas-error").waitFor({ state: "hidden" });
    console.log("WebGL context recovery passed.");
  }
  await desktop.close();

  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    defaultBrowserType: undefined,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(url);
  await phone.waitForTimeout(4000);
  assert.equal(await phone.locator("#canvas-error").isVisible(), false);
  assert.ok(
    await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await phone.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await phone.getByRole("button", { name: "Behind the swarm" }).tap();
  assert.equal(await phone.locator("#about pre code").count(), 3);
  assert.ok(
    await phone
      .locator("#about")
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  );
  await phone.locator("#about pre").first().scrollIntoViewIfNeeded();
  await phone.screenshot({ path: "test-results/mobile-code.png" });
  await phone.getByRole("button", { name: "Close explanation" }).tap();
  await phone.getByRole("button", { name: "Vortex", exact: true }).tap();
  assert.equal(await phone.locator("#scene-name").innerText(), "Vortex");
  await phone.locator("#auto-scale").uncheck();
  assert.equal(await phone.locator("#auto-scale").isChecked(), false);
  await phone.getByRole("button", { name: "Pause simulation", exact: true }).tap();
  assert.equal(await phone.locator("#pause-overlay").isVisible(), true);
  await phone.getByRole("button", { name: "Resume simulation", exact: true }).tap();
  await phone.touchscreen.tap(200, 340);
  assert.equal(await phone.locator("#pointer-ring").isVisible(), false);
  console.log("Mobile viewport and touch controls passed.");
  assert.deepEqual(errors, []);
  console.log("No browser errors. Screenshots in test-results/.");
} finally {
  await browser.close();
}
