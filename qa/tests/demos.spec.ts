import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const qaDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectsFile = path.join(qaDir, '..', 'projects.json');

interface Demo {
  key: string;
  display_title: string;
  live_url: string;
  has_live_demo?: boolean;
}

const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as { projects: Demo[] };
const live = data.projects.filter((p) => p.has_live_demo && p.live_url);

// Demos are third-party sites we do not control. HTTP status and uncaught page
// errors are hard regressions and fail the run. Baseline issues (console noise,
// mobile overflow, missing <h1>, unlabelled images, axe findings) are recorded
// as findings on the report so a known-accepted state does not paint CI red.
// Set STRICT_DEMOS=1 to promote every finding to a failure.
const STRICT = process.env.STRICT_DEMOS === '1';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function imagesMissingAlt(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img'))
      .filter((img) => !img.hasAttribute('alt') || (img.getAttribute('alt') ?? '').trim() === '')
      .map((img) => img.currentSrc || img.src || '(inline)')
      .slice(0, 10),
  );
}

for (const project of live) {
  test(`${project.display_title} (${project.key})`, async ({ page }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (e) => runtimeErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') runtimeErrors.push(`console.error: ${msg.text()}`);
    });

    const soft: string[] = [];
    let status: number | null = null;
    let overflow: number | null = null;
    let h1: number | null = null;
    let missingAlt: string[] = [];
    let axeSummary: string[] = [];

    try {
      const resp = await page.goto(project.live_url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      status = resp ? resp.status() : null;

      // Let late JS settle without waiting on unbounded asset downloads.
      await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);

      overflow = await horizontalOverflow(page);
      h1 = await page.locator('h1').count();
      missingAlt = await imagesMissingAlt(page);

      try {
        const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        axeSummary = results.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}`);
      } catch (e) {
        soft.push(`axe could not run: ${(e as Error).message.split('\n')[0]}`);
      }
    } catch (e) {
      soft.push(`navigation: ${(e as Error).message.split('\n')[0]}`);
    }

    const pageErrors = runtimeErrors.filter((e) => e.startsWith('pageerror:'));
    const consoleErrors = runtimeErrors.filter((e) => e.startsWith('console.error:'));

    if (overflow !== null && overflow > 1) soft.push(`horizontal overflow ${overflow}px`);
    if (h1 !== null && h1 < 1) soft.push('no <h1>');
    if (consoleErrors.length) soft.push(`${consoleErrors.length} console.error(s)`);
    if (missingAlt.length) soft.push(`${missingAlt.length} image(s) missing alt`);
    if (axeSummary.length) soft.push(`axe: ${axeSummary.join(', ')}`);

    const findings = {
      key: project.key,
      title: project.display_title,
      url: project.live_url,
      viewport: testInfo.project.name,
      status,
      pageErrors,
      consoleErrors,
      overflow,
      h1,
      missingAlt,
      axe: axeSummary,
      soft,
    };

    if (soft.length) {
      testInfo.annotations.push({ type: 'finding', description: soft.join(' | ') });
    }
    console.log(
      `[${testInfo.project.name}] ${project.key}: status=${status} overflow=${overflow} ` +
        `h1=${h1} pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length} ` +
        `missingAlt=${missingAlt.length} axe=${axeSummary.length}` +
        (soft.length ? ` :: ${soft.join(' | ')}` : ''),
    );

    await testInfo.attach('findings.json', {
      body: JSON.stringify(findings, null, 2),
      contentType: 'application/json',
    });
    try {
      // Write the PNG into the test's output dir (uploaded as an artifact) and
      // also embed it in the HTML report.
      const shot = await page.screenshot({
        path: testInfo.outputPath('screenshot.png'),
        fullPage: false,
      });
      await testInfo.attach('screenshot', { body: shot, contentType: 'image/png' });
    } catch {
      // Page may be unreachable/closed; findings are the important artifact.
    }

    // --- Hard regressions ---------------------------------------------------
    expect(status, `HTTP status for ${project.live_url}`).toBe(200);
    expect(pageErrors, `uncaught page errors on ${project.key}`).toEqual([]);

    // --- Opt-in strict mode -------------------------------------------------
    if (STRICT) {
      expect(overflow, `horizontal overflow on ${project.key}`).toBeLessThanOrEqual(1);
      expect(h1, `<h1> count on ${project.key}`).toBeGreaterThanOrEqual(1);
      expect(missingAlt, `images missing alt on ${project.key}`).toEqual([]);
      expect(axeSummary, `axe violations on ${project.key}`).toEqual([]);
      expect(consoleErrors, `console errors on ${project.key}`).toEqual([]);
    }
  });
}

test.afterAll(() => {
  // A guard so an empty roster is obvious rather than silently passing.
  expect(live.length, 'live demos discovered in projects.json').toBeGreaterThan(0);
});
