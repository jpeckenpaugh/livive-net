import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The hub is our own code, so every check below is a hard assertion.

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('hub', () => {
  test('returns HTTP 200 with no runtime errors and one h1', async ({ page }, testInfo) => {
    const errors = collectRuntimeErrors(page);
    const resp = await page.goto('/');
    expect(resp, 'no navigation response').toBeTruthy();
    expect(resp!.status(), 'hub HTTP status').toBe(200);

    await expect(page.locator('#main .card').first()).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    expect(errors, 'runtime errors on hub').toEqual([]);

    const shot = await page.screenshot({
      path: testInfo.outputPath('screenshot.png'),
      fullPage: false,
    });
    await testInfo.attach('screenshot', { body: shot, contentType: 'image/png' });
  });

  test('has no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main .card').first()).toBeVisible();
    expect(await horizontalOverflow(page), 'horizontal overflow (px)').toBeLessThanOrEqual(1);
  });

  test('every card image has non-empty alt text', async ({ page }) => {
    await page.goto('/');
    const imgs = page.locator('#main .card img');
    const count = await imgs.count();
    expect(count, 'card image count').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const alt = await imgs.nth(i).getAttribute('alt');
      expect((alt ?? '').trim(), `card img[${i}] alt`).not.toBe('');
    }
  });

  test('search filters the grid', async ({ page }) => {
    await page.goto('/');
    const cards = page.locator('#main .card');
    await expect(cards.first()).toBeVisible();
    const total = await cards.count();
    expect(total, 'unfiltered card count').toBeGreaterThan(1);

    // A query that matches at least one project narrows the grid to matches only.
    await page.fill('#q', 'lokarta');
    const filtered = page.locator('#main .card');
    await expect(filtered.first()).toBeVisible();
    const filteredCount = await filtered.count();
    expect(filteredCount, 'filtered card count').toBeGreaterThanOrEqual(1);
    expect(filteredCount, 'filtered card count').toBeLessThan(total);
    for (let i = 0; i < filteredCount; i++) {
      await expect(filtered.nth(i)).toContainText(/lokarta/i);
    }

    // A query that matches nothing shows the empty state.
    await page.fill('#q', 'zzzz-no-such-project-zzzz');
    await expect(page.locator('#main .empty')).toBeVisible();
    await expect(page.locator('#main .card')).toHaveCount(0);

    // Clearing restores the full grid.
    await page.fill('#q', '');
    await expect(page.locator('#main .card')).toHaveCount(total);
  });

  test('has no axe WCAG 2 A/AA violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main .card').first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`,
    );
    expect(summary, 'axe violations on hub').toEqual([]);
  });
});
