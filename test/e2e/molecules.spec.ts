import fs from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './molecules.fixture.ts';

const themes = ['light', 'dark'] as const,
  densities = ['cozy', 'compact'] as const;
const molecules = ['Card', 'ListRow', 'Menu', 'EmptyState'] as const;
function storyOf(molecule: string) {
  return `${molecule
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()}--states`;
}
async function catalog(page: Page, molecule: string, theme: string, density: string) {
  await page.goto(
    `/?story=${storyOf(molecule)}&mode=preview&atomTheme=${theme}&atomDensity=${density}`,
  );
  const panel = page.locator('[data-atom-panel]');
  await expect(panel).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return panel;
}
for (const theme of themes)
  for (const density of densities) {
    test(`all four actual molecule panels axe clean ${theme}/${density}`, async ({
      page,
    }) => {
      for (const molecule of molecules) {
        const panel = await catalog(page, molecule, theme, density);
        const result = await new AxeBuilder({ page })
          .include('[data-atom-panel]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(result.violations).toEqual([]);
        expect(await panel.locator('h1').textContent()).toContain(molecule);
      }
    });
    test(`molecule native behavior ${theme}/${density}`, async ({ page }) => {
      await catalog(page, 'Card', theme, density);
      await expect(
        page.getByRole('article', { name: 'Work summary' }),
      ).toBeVisible();
      await catalog(page, 'ListRow', theme, density);
      const before = await page.getByLabel('Activations').textContent();
      await page.getByRole('button', { name: 'Open task' }).click();
      expect(await page.getByLabel('Activations').textContent()).not.toBe(
        before,
      );
      await expect(
        page.getByRole('button', { name: 'Unavailable task' }),
      ).toBeDisabled();
      await catalog(page, 'Menu', theme, density);
      const trigger = page.getByRole('button', { name: 'Task actions' });
      await trigger.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('menu')).toBeHidden();
      await catalog(page, 'EmptyState', theme, density);
      await expect(
        page.getByRole('heading', { name: 'No tasks yet' }),
      ).toBeVisible();
    });
    test(`molecule unbroken reflow at narrow width ${theme}/${density}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 1200 });
      for (const molecule of molecules) {
        const panel = await catalog(page, molecule, theme, density),
          panelBox = await panel.boundingBox();
        if (!panelBox) throw Error('Visible molecule panel required');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(320);
      }
    });
  }
for (const theme of themes)
  for (const density of densities)
    for (const width of [320, 640])
      for (const molecule of molecules) {
        test(`@visual ${molecule} states ${theme}/${density}/${width}`, async ({
          page,
        }) => {
          if (
            process.platform !== 'linux' ||
            !process.env.GOLEM_MOLECULES_IMAGE_DIGEST?.startsWith('sha256:') ||
            !process.env.GOLEM_MOLECULES_BROWSER_VERSION
          )
            throw Error(
              'Snapshots require verified pinned Linux image digest and browser version',
            );
          await page.setViewportSize({ width, height: 1200 });
          const panel = await catalog(page, molecule, theme, density);
          const accessibility = await new AxeBuilder({ page })
            .include('[data-atom-panel]')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze();
          expect(accessibility.violations).toEqual([]);
          const geometry = await panel.boundingBox();
          if (!geometry) throw Error('Actual visible panel geometry required');
          const name = `${molecule.toLowerCase()}-${theme}-${density}-${width}.png`;
          await expect(panel).toHaveScreenshot(name, {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixels: 0,
          });
          if (process.env.GOLEM_MOLECULES_CAPTURE === 'initial') {
            const records = process.env.GOLEM_MOLECULES_CAPTURE_RECORDS;
            if (!records || !path.isAbsolute(records))
              throw Error('Owned capture record facility required');
            const browser = page.context().browser();
            if (!browser)
              throw Error('Actual captured browser identity missing');
            fs.writeFileSync(
              path.join(records, name + '.json'),
              JSON.stringify(
                {
                  name,
                  molecule: molecule.toLowerCase(),
                  theme,
                  density,
                  viewport: { width, height: 1200 },
                  panel: geometry,
                  scale: 1,
                  axeViolations: accessibility.violations.length,
                  fontsReady: true,
                  browserVersion: browser.version(),
                },
                null,
                2,
              ),
              { flag: 'wx', mode: 0o600 },
            );
          }
        });
      }
