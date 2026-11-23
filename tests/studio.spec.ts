import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("Local engine online")).toBeVisible();
});
test.afterEach(async ({ page, request }) => {
  const ids = await page.evaluate(
    () => JSON.parse(localStorage.getItem("fh-jobs") || "[]") as string[],
  );
  for (const id of ids) await request.delete("/api/jobs/" + id);
  expect(errors).toEqual([]);
});

test("convert a sample, compare result, download individual and ZIP", async ({
  page,
}) => {
  await page.screenshot({
    path: "data/verification/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Coba gambar contoh" }).click();
  await expect(page.getByText("1 gambar siap diproses")).toBeVisible();
  await page.getByRole("button", { name: "Proses 1 gambar" }).click();
  await expect(page.locator(".status-done")).toBeVisible();
  await expect(page.locator(".job-output")).toContainText("WEBP");
  await page.locator(".job-thumb").click();
  await expect(
    page.getByRole("dialog", { name: "Preview gambar" }),
  ).toBeVisible();
  await page
    .getByRole("slider", { name: "Bandingkan sebelum dan sesudah" })
    .fill("35");
  await expect(page.locator(".comparison-line")).toHaveAttribute(
    "style",
    "left: 35%;",
  );
  const individual = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Download hasil" })
    .click();
  const downloaded = await individual;
  expect(downloaded.suggestedFilename()).toMatch(/\.webp$/);
  const content = await fs.readFile((await downloaded.path())!);
  expect(content.subarray(0, 4).toString()).toBe("RIFF");
  await page.keyboard.press("Escape");
  const zipPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download semua ZIP" }).click();
  const zip = await zipPromise;
  const zipContent = await fs.readFile((await zip.path())!);
  expect(zipContent.subarray(0, 2).toString()).toBe("PK");
  await page.screenshot({
    path: "data/verification/desktop-result.png",
    fullPage: true,
  });
});

test("background removal runs the real quality model through Nginx", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Hapus background", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Background remover." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Coba gambar contoh" }).click();
  await page.locator(".process-button").click();
  await expect(page.locator(".status-done")).toBeVisible({ timeout: 90000 });
  await expect(page.locator(".job-output")).toContainText("PNG");
  await page.locator(".job-thumb").click();
  await expect(page.locator(".comparison-base")).toBeVisible();
  await page
    .getByRole("slider", { name: "Bandingkan sebelum dan sesudah" })
    .fill("20");
  await page.screenshot({
    path: "data/verification/background-preview.png",
    fullPage: true,
  });
});

test("mobile layout, format selection, and settings stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  expect(fits).toBeTruthy();
  await page.getByRole("button", { name: "WebP Ringan & modern" }).click();
  await page.getByRole("button", { name: "TIFF Arsip & cetak" }).click();
  await expect(
    page.getByRole("button", { name: "TIFF Arsip & cetak" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resize & rotate" }).click();
  await page.getByRole("spinbutton", { name: "Lebar" }).fill("800");
  await page.getByRole("button", { name: "Coba gambar contoh" }).click();
  await page.getByRole("button", { name: "Proses 1 gambar" }).click();
  await expect(page.locator(".status-done")).toBeVisible();
  await page.locator(".job-thumb").click();
  await expect(page.getByRole("dialog")).toContainText("800 × 533");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pengaturan", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Pengaturan" })).toContainText(
    "Siap digunakan",
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "data/verification/mobile.png",
    fullPage: true,
  });
});

test("API documentation is self-hosted and has no blocked resources", async ({
  page,
}) => {
  const blocked: string[] = [];
  page.on("requestfailed", (r) => blocked.push(r.url()));
  await page.goto("/api/docs");
  await expect(page.locator(".swagger-ui")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /File Handler/ }),
  ).toBeVisible();
  expect(blocked).toEqual([]);
});
