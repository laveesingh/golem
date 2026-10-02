import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './atoms.fixture.ts';

const themes = ['light', 'dark'] as const,
  densities = ['cozy', 'compact'] as const;
const fonts = [
  ['Geist', 400],
  ['Geist', 500],
  ['Geist', 600],
  ['Geist', 700],
  ['JetBrains Mono', 400],
  ['JetBrains Mono', 500],
  ['JetBrains Mono', 600],
] as const;
async function catalog(
  page: Page,
  atom: string,
  theme: string,
  density: string,
) {
  const story =
    atom === 'IconButton'
      ? 'icon-button--states'
      : `${atom.toLowerCase()}--states`;
  await page.goto(
    `/?story=${story}&mode=preview&atomTheme=${theme}&atomDensity=${density}`,
  );
  const panel = page.locator('[data-atom-panel]');
  await expect(panel).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
  await page.evaluate(async (data) => {
    await document.fonts.ready;
    for (const [family, weight] of data) {
      const descriptor = `${weight} 16px "${family}"`;
      const loaded = await document.fonts.load(descriptor, 'Golem Aa0123');
      if (!loaded.length || !document.fonts.check(descriptor, 'Golem Aa0123'))
        throw Error(`Required local font failed: ${descriptor}`);
    }
  }, fonts);
  return panel;
}
for (const theme of themes)
  for (const density of densities) {
    test(`all five actual catalog panels axe clean ${theme}/${density}`, async ({
      page,
    }) => {
      const baseURL = process.env.GOLEM_ATOMS_BASE_URL;
      if (!baseURL) throw Error('Missing validated private atom base URL');
      const requested: string[] = [],
        failed: string[] = [];
      page.on('request', (request) => {
        if (
          request.url().startsWith('http') &&
          !request.url().startsWith(baseURL)
        )
          failed.push(request.url());
        if (request.url().includes('.woff2')) requested.push(request.url());
      });
      page.on('requestfailed', (request) => failed.push(request.url()));
      for (const atom of ['Button', 'IconButton', 'Input', 'Pill', 'Badge']) {
        const panel = await catalog(page, atom, theme, density);
        const result = await new AxeBuilder({ page })
          .include('[data-atom-panel]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(result.violations).toEqual([]);
        expect(await panel.locator('h1').textContent()).toContain(atom);
      }
      expect(failed).toEqual([]);
      const urls = [...new Set(requested)];
      expect(new Set(urls.map((url) => new URL(url).pathname)).size).toBe(7);
      const inventory = JSON.parse(
        fs.readFileSync(
          new URL(
            '../../dashboard/web/src/ui/fonts/inventory.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Array<{ file: string; sha256: string; bytes: number }>;
      for (const font of inventory) {
        const match = urls.find((url) =>
          new URL(url).pathname.includes(font.file.replace('.woff2', '')),
        );
        if (!match) throw Error(`Missing served local font ${font.file}`);
        const response = await page.request.get(match);
        expect(response.ok()).toBe(true);
        const bytes = await response.body();
        expect(bytes.length).toBe(font.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(
          font.sha256,
        );
      }
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const dom = await cdp.send('DOM.getDocument');
      for (const sample of [
        'body',
        'label',
        'strong',
        'heading',
        'code',
        'codeLabel',
        'codeStrong',
      ]) {
        const found = await cdp.send('DOM.querySelector', {
          nodeId: dom.root.nodeId,
          selector: `[data-font-sample="${sample}"]`,
        });
        expect(found.nodeId).toBeTruthy();
        const rendered = await cdp.send('CSS.getPlatformFontsForNode', {
          nodeId: found.nodeId,
        });
        expect(
          rendered.fonts.some(
            (font: { isCustomFont: boolean; glyphCount: number }) =>
              font.isCustomFont && font.glyphCount > 0,
          ),
        ).toBe(true);
      }
      await cdp.detach();
    });
    test(`Button actual native states and paired paint ${theme}/${density}`, async ({
      page,
    }) => {
      await catalog(page, 'Button', theme, density);
      const button = page.locator('#primary');
      const paint = async (state: string, target = button) => {
        const expected = await page.evaluate((selected) => {
          const css = getComputedStyle(document.documentElement);
          return {
            background: css
              .getPropertyValue(
                `--g-component-button-primary-${selected}-background`,
              )
              .trim(),
            foreground: css
              .getPropertyValue(
                `--g-component-button-primary-${selected}-foreground`,
              )
              .trim(),
          };
        }, state);
        // Resolve generated hex values through the browser's own CSS color normalization.
        const actual = await target.evaluate((element, expected) => {
          const probe = document.createElement('span');
          document.body.append(probe);
          probe.style.color = expected.background;
          const background = getComputedStyle(probe).color;
          probe.style.color = expected.foreground;
          const foreground = getComputedStyle(probe).color;
          probe.remove();
          const css = getComputedStyle(element);
          return {
            background: css.backgroundColor,
            foreground: css.color,
            expectedBackground: background,
            expectedForeground: foreground,
          };
        }, expected);
        expect(actual.background).toBe(actual.expectedBackground);
        expect(actual.foreground).toBe(actual.expectedForeground);
      };
      await paint('default');
      await button.hover();
      await paint('hover');
      await page.mouse.down();
      await paint('active');
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await button.focus();
      await page.keyboard.press('Shift');
      await paint('focus');
      await expect(button).toBeFocused();
      expect(
        await button.evaluate((el) => getComputedStyle(el).outlineStyle),
      ).toBe('solid');
      const before = await page.locator('text=Activations:').textContent();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      expect(await page.locator('text=Activations:').textContent()).not.toBe(
        before,
      );
      const busy = page.locator('#busy');
      await busy.focus();
      await page.keyboard.press('Shift');
      await paint('busy', busy);
      const count = await page.locator('text=Activations:').textContent();
      await busy.click();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      expect(await page.locator('text=Activations:').textContent()).toBe(count);
      await expect(busy).toBeFocused();
      const disabled = page.locator('#disabled');
      await expect(disabled).toBeDisabled();
      await paint('disabled', disabled);
      const transition = page.locator('#transition');
      await transition.focus();
      await page.keyboard.press('Enter');
      await expect(transition).toBeFocused();
      await expect(transition).toHaveAttribute('aria-busy', 'true');
    });
    test(`Icon target, readonly/error and accessible full counts ${theme}/${density}`, async ({
      page,
    }) => {
      await catalog(page, 'IconButton', theme, density);
      const icon = page.getByRole('button', { name: 'Add item', exact: true });
      const bounds = await icon.boundingBox();
      if (!bounds) throw Error('IconButton must have a visible hit target');
      expect(bounds.width).toBe(density === 'compact' ? 32 : 44);
      expect(bounds.height).toBe(density === 'compact' ? 32 : 44);
      await catalog(page, 'Input', theme, density);
      const ro = page.getByRole('textbox', { name: 'Read-only item title' });
      await ro.focus();
      await ro.pressSequentially('X');
      await expect(ro).toHaveValue('Read-only example');
      const invalid = page.getByRole('textbox', {
        name: 'Invalid item title (required)',
      });
      await expect(invalid).toHaveAttribute('aria-invalid', 'true');
      await expect(invalid).toHaveAccessibleDescription(
        'Enter an item title before continuing.',
      );
      await catalog(page, 'Badge', theme, density);
      await expect(
        page.locator('.g-visually-hidden', { hasText: 'Items: 1234' }),
      ).toHaveCount(1);
    });
  }
for (const theme of themes)
  for (const density of densities)
    for (const width of [320, 640])
      for (const atom of ['Button', 'IconButton', 'Input', 'Pill', 'Badge']) {
        test(`@visual ${atom} states ${theme}/${density}/${width}`, async ({
          page,
        }) => {
          if (
            process.platform !== 'linux' ||
            !process.env.GOLEM_ATOMS_IMAGE_DIGEST?.startsWith('sha256:') ||
            !process.env.GOLEM_ATOMS_BROWSER_VERSION
          )
            throw Error(
              'Snapshots require verified pinned Linux image digest and browser version',
            );
          await page.setViewportSize({ width, height: 1200 });
          const panel = await catalog(page, atom, theme, density);
          await expect(panel).toHaveScreenshot(
            `${atom.toLowerCase()}-${theme}-${density}-${width}.png`,
            { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
          );
        });
      }
