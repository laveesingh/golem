import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
    test(`real Ladle authoring axe panel ${theme}/${density}`, async ({
      page,
    }) => {
      await page.goto(
        `/?story=button--states&atomTheme=${theme}&atomDensity=${density}`,
      );
      await expect(page.locator('[data-atom-panel]')).toBeVisible();
      await page
        .getByRole('button', {
          name: 'Show accessibility report.',
          exact: true,
        })
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Dialog with the story accessibility report.',
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('There are no');
      await expect(dialog).toContainText('accessibility violations. Good job!');
    });
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
            (font: {
              isCustomFont: boolean;
              glyphCount: number;
              familyName: string;
            }) =>
              font.isCustomFont &&
              font.glyphCount > 0 &&
              font.familyName
                .toLowerCase()
                .replace(/[\s-]/g, '')
                .includes(
                  sample.startsWith('code') ? 'jetbrainsmono' : 'geist',
                ),
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
            opacity: css.opacity,
            filter: css.filter,
            expectedBackground: background,
            expectedForeground: foreground,
          };
        }, expected);
        expect(actual.background).toBe(actual.expectedBackground);
        expect(actual.foreground).toBe(actual.expectedForeground);
        expect(actual.opacity).toBe('1');
        expect(actual.filter).toBe('none');
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
      const busyBounds = await busy.boundingBox();
      if (!busyBounds) throw Error('Busy action must remain visible');
      await page.mouse.click(
        busyBounds.x + busyBounds.width / 2,
        busyBounds.y + busyBounds.height / 2,
      );
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
    test(`visible static busy cues and unbroken reflow ${theme}/${density}`, async ({
      page,
    }) => {
      expect(
        await page.evaluate(
          () => matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      ).toBe(true);
      for (const atom of ['Button', 'IconButton']) {
        await catalog(page, atom, theme, density);
        const target = page.locator(
            atom === 'Button' ? '#transition' : '#icon-transition',
          ),
          cue = target.locator('[data-busy-indicator]');
        await page.keyboard.press('Tab');
        await target.focus();
        await page.keyboard.press('Shift');
        const name = atom === 'Button' ? 'Run action' : 'Run icon action';
        await expect(target).toHaveAccessibleName(name);
        await expect(cue).toHaveCSS('visibility', 'hidden');
        const beforeBox = await target.boundingBox(),
          before = await target.screenshot({ animations: 'disabled' });
        await page.keyboard.press('Enter');
        await expect(target).toHaveAttribute('aria-busy', 'true');
        await expect(target).toBeFocused();
        await expect(target).toHaveAccessibleName(name);
        await expect(cue).toHaveCSS('visibility', 'visible');
        await expect(cue).toHaveAttribute('aria-hidden', 'true');
        expect(await target.boundingBox()).toEqual(beforeBox);
        const after = await target.screenshot({ animations: 'disabled' });
        expect(createHash('sha256').update(after).digest('hex')).not.toBe(
          createHash('sha256').update(before).digest('hex'),
        );
      }
      await page.setViewportSize({ width: 320, height: 1200 });
      for (const atom of ['Badge', 'Input']) {
        const panel = await catalog(page, atom, theme, density),
          panelBox = await panel.boundingBox();
        if (!panelBox) throw Error('Visible reflow panel required');
        const right = panelBox.x + panelBox.width;
        const text =
          atom === 'Badge'
            ? panel.locator('.g-badge').last()
            : panel.locator('label[for="unbroken"],#unbroken-error');
        for (const element of await text.all()) {
          const geometry = await element.evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            return {
              right: box.right,
              client: node.clientWidth,
              scroll: node.scrollWidth,
              height: box.height,
            };
          });
          expect(geometry.right).toBeLessThanOrEqual(right + 1);
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
          expect(geometry.height).toBeGreaterThan(20);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(320);
        if (atom === 'Input')
          await expect(page.locator('#unbroken')).toHaveValue(
            'Native_value_'.repeat(20),
          );
      }
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
          if (atom === 'Button' || atom === 'IconButton' || atom === 'Input') {
            await page.keyboard.press('Tab');
            const target = page.locator(
              atom === 'Button'
                ? '#busy'
                : atom === 'IconButton'
                  ? '#icon-busy'
                  : '#invalid',
            );
            await target.focus();
            await page.keyboard.press('Shift');
            await expect(target).toBeFocused();
            expect(
              await target.evaluate(
                (element) => getComputedStyle(element).outlineStyle,
              ),
            ).toBe('solid');
          }
          const accessibility = await new AxeBuilder({ page })
            .include('[data-atom-panel]')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze();
          expect(accessibility.violations).toEqual([]);
          const geometry = await panel.boundingBox();
          if (!geometry) throw Error('Actual visible panel geometry required');
          const name = `${atom.toLowerCase()}-${theme}-${density}-${width}.png`;
          await expect(panel).toHaveScreenshot(name, {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixels: 0,
          });
          if (process.env.GOLEM_ATOMS_CAPTURE === 'initial') {
            const records = process.env.GOLEM_ATOMS_CAPTURE_RECORDS;
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
                  atom: atom.toLowerCase(),
                  theme,
                  density,
                  viewport: { width, height: 1200 },
                  panel: geometry,
                  scale: 1,
                  axeViolations: accessibility.violations.length,
                  fontsReady: true,
                  browserVersion: browser.version(),
                  focusState: ['Button', 'IconButton'].includes(atom)
                    ? 'busy+keyboard-focus'
                    : atom === 'Input'
                      ? 'invalid+keyboard-focus'
                      : 'noninteractive',
                },
                null,
                2,
              ),
              { flag: 'wx', mode: 0o600 },
            );
          }
        });
      }
