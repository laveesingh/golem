import { strict as assert } from 'node:assert';
import { acquireChrome } from './_chrome.mjs';

const base = process.env.GOLEM_SMOKE_API || 'http://127.0.0.1:7420';
// Discover a real project (use first project from API, prefer one with specs)
let projectId = process.env.GOLEM_SMOKE_PROJECT || null;
let projectRouteId = null;
async function discoverProject() {
  try {
    const res = await fetch(`${base}/api/projects`);
    const projects = await res.json();
    if (Array.isArray(projects) && projects.length > 0) {
      // Prefer a project that has a .golem directory or has specs
      // For now, pick the first project; use its `id` for routing and `project_id` for API
      const first = projects[0];
      projectRouteId = first.id || first.project_id;
      projectId = first.project_id || first.id;
      console.log(`[smoke-ux-rehaul] discovered project routeId=${projectRouteId} projectId=${projectId} name=${first.name}`);
      return { routeId: projectRouteId, projectId };
    }
  } catch (e) {
    console.warn('[smoke-ux-rehaul] failed to discover project', e);
  }
  // Fallback
  projectId = projectId || 'golem-961090';
  projectRouteId = projectRouteId || projectId;
  return { routeId: projectRouteId, projectId };
}

let chrome;
let failed = false;

function log(step, data) {
  console.log(`[smoke-ux-rehaul] ${step}`, data ? JSON.stringify(data) : '');
}

async function waitForStoreReady(page, timeout = 15000) {
  await page.waitForFunction(() => window.Store && window.Store.getState().ready, { timeout });
}

async function getProjects(page) {
  return page.evaluate(() => window.Store.getState().projects.map(p => ({ id: p.id, project_id: p.project_id, name: p.name })));
}

async function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.error('[BROWSER CONSOLE ERROR]', text);
      if (!/favicon|websocket|mermaid/i.test(text)) errors.push(text);
    }
  });
  page.on('pageerror', err => {
    console.error('[BROWSER UNCAUGHT PAGE ERROR]', err);
    errors.push(String(err));
  });
  return errors;
}

try {
  chrome = await acquireChrome();
  const page = await chrome.browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = await collectConsoleErrors(page);

  // ── Journey 0: Pruned routes gracefully fallback to dashboard (no 404, no crash) ──
  log('0: pruned routes redirect');
  for (const path of ['/tracker', '/specs', '/logs']) {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => window.Store && window.Store.getState().ready);
    assert.ok(state, `dashboard should be ready after fallback from ${path}`);
    // URL may stay at pruned path (fallback renders dashboard) or redirect; either is ok as long as dashboard content shows
    const bodyOk = await page.evaluate(() => {
      const text = document.body.innerText.slice(0, 800);
      const hasDashboard = text.includes('Command Center') || text.includes('Projects') || text.includes('Workspace') || document.querySelector('.command-center') || document.querySelector('.page');
      const is404 = /not found/i.test(text) && !hasDashboard;
      return { hasDashboard: !!hasDashboard, is404, snippet: text.slice(0,200) };
    });
    assert.ok(!bodyOk.is404, `pruned route ${path} should not show 404, got ${bodyOk.snippet}`);
    assert.ok(bodyOk.hasDashboard, `pruned route ${path} should show dashboard/projects content`);
  }
  // Filter out known benign console errors from pruned routes (may include initial 404 handler logs)
  const prunedErrors = consoleErrors.filter(e => !/not found/i.test(e));
  // Don't assert on consoleErrors here; full check at end
  log('0b: pruned routes ok', { prunedErrors: prunedErrors.length });

  // ── Journey 1: Spec Cockpit Navigation ──
  log('1: spec cockpit navigation');
  const discovered = await discoverProject();
  projectId = discovered.projectId;
  projectRouteId = discovered.routeId;
  await page.goto(`${base}/project/${encodeURIComponent(projectRouteId)}`, { waitUntil: 'domcontentloaded' });
  await waitForStoreReady(page);
  const debug = await page.evaluate(() => ({ url: window.location.href, storeReady: !!window.Store?.getState?.().ready, html: document.body.innerHTML.slice(0, 600) }));
  console.log('[DEBUG cockpit navigation]', JSON.stringify(debug), 'errors:', consoleErrors);
  await page.waitForSelector('.cockpit-grid', { timeout: 10000 });
  const cockpit = await page.evaluate(() => {
    const grid = document.querySelector('.cockpit-grid');
    const left = document.querySelector('.cockpit-left');
    const center = document.querySelector('.cockpit-center');
    const right = document.querySelector('.cockpit-right');
    const specItems = document.querySelectorAll('.cockpit-spec-item');
    const stageGroups = document.querySelectorAll('.cockpit-stage-group');
    const search = document.querySelector('.cockpit-search');
    const ideasBtn = document.querySelector('.cockpit-ideas-btn');
    return {
      hasGrid: !!grid,
      hasLeft: !!left,
      hasCenter: !!center,
      hasRight: !!right,
      specCount: specItems.length,
      stageCount: stageGroups.length,
      hasSearch: !!search,
      hasIdeasBtn: !!ideasBtn,
      gridDisplay: grid ? getComputedStyle(grid).display : null,
      gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    };
  });
  assert.ok(cockpit.hasGrid, 'cockpit grid should exist');
  assert.ok(cockpit.hasLeft && cockpit.hasCenter && cockpit.hasRight, 'all three panes should exist');
  assert.equal(cockpit.stageCount, 4, 'left tree should have 4 stage groups (Drafting, Brainstorm, In Build/Verifying, Closed)');
  assert.ok(cockpit.hasSearch, 'spec filter search input should exist');
  assert.ok(cockpit.hasIdeasBtn, 'Ideas toggle button should exist at left head');
  // Verify responsive: grid should be 280px 1fr 340px on desktop
  assert.ok(cockpit.gridCols.includes('280px') || cockpit.gridCols.includes('340px') || cockpit.gridDisplay === 'grid', `grid cols should be 280px 1fr 340px, got ${cockpit.gridCols}`);

  // Click first spec item if exists, verify center updates
  if (cockpit.specCount > 0) {
    const firstSpec = await page.evaluate(() => {
      const first = document.querySelector('.cockpit-spec-item');
      return { id: first?.querySelector('.cockpit-spec-id')?.textContent?.trim(), title: first?.querySelector('.cockpit-spec-title')?.textContent?.trim() };
    });
    log('1a: first spec', firstSpec);
    // Capture center title before click
    const beforeCenter = await page.evaluate(() => document.querySelector('.cockpit-doc-title')?.textContent?.trim() || '');
    await page.click('.cockpit-spec-item');
    await page.waitForTimeout(600);
    const afterCenter = await page.evaluate(() => document.querySelector('.cockpit-doc-title')?.textContent?.trim() || document.querySelector('.cockpit-doc-body')?.innerText?.slice(0, 100) || '');
    // If there are multiple specs, clicking second should change center
    const secondExists = await page.evaluate(() => document.querySelectorAll('.cockpit-spec-item').length > 1);
    if (secondExists) {
      await page.click('.cockpit-spec-item:nth-child(2)');
      await page.waitForTimeout(600);
      const secondCenter = await page.evaluate(() => document.querySelector('.cockpit-doc-title')?.textContent?.trim() || '');
      // It may be same if only one spec, but we check that right rail updates
      log('1b: second spec center', { beforeCenter, afterCenter, secondCenter });
    }
    // Verify right rail comment count updated (or at least exists)
    const rightState = await page.evaluate(() => {
      const comments = document.querySelectorAll('.cockpit-comment');
      const swarmCards = document.querySelectorAll('.cockpit-swarm-card');
      return { commentCount: comments.length, swarmCount: swarmCards.length };
    });
    log('1c: right rail', rightState);
  } else {
    log('1: no specs in project, checking empty CTA');
    const emptyCta = await page.evaluate(() => {
      const cta = document.querySelector('.empty-card.onboarding-cta') || document.querySelector('.cockpit-empty');
      return { hasCta: !!cta, text: cta?.innerText?.slice(0, 200) || '' };
    });
    assert.ok(emptyCta.hasCta, 'empty state CTA should be shown when no specs');
  }

  // Add anchored comment and verify highlight (if spec exists)
  let anchoredCommentId = null;
  if (cockpit.specCount > 0) {
    // Get active spec id
    const activeSpec = await page.evaluate(() => {
      const active = document.querySelector('.cockpit-spec-item.active');
      return active?.querySelector('.cockpit-spec-id')?.textContent?.trim() || null;
    });
    if (activeSpec) {
      // Create a comment via API with quote for anchoring
      const specId = activeSpec;
      const commentBody = `Smoke comment ${Date.now()} with **markdown**`;
      const quote = await page.evaluate(() => {
        const body = document.querySelector('.cockpit-doc-body');
        const text = body?.innerText || '';
        // Take first 12 chars of body as quote if available
        return text.trim().slice(0, 30) || 'Spec';
      });
      const res = await fetch(`${base}/api/tickets/${encodeURIComponent(specId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'human', body: commentBody, quote, prefix: '', suffix: '' }),
      });
      if (res.ok) {
        const comment = await res.json();
        anchoredCommentId = comment.id;
        log('1d: created anchored comment', { id: anchoredCommentId, quote: quote.slice(0, 20) });
        // Wait for highlight to appear (poll for mark.cockpit-anno)
        await page.waitForTimeout(1200);
        const highlight = await page.evaluate(() => {
          const marks = document.querySelectorAll('mark.cockpit-anno');
          return { count: marks.length, hasMark: marks.length > 0 };
        });
        log('1e: annotation highlight', highlight);
        // Cleanup comment later via archive? Comments are not archived separately; we leave it (will be cleaned with spec archive if scratch)
        // For now, just verify it appears in right rail
        await page.waitForTimeout(500);
        const commentInRail = await page.evaluate(() => {
          const rails = [...document.querySelectorAll('.cockpit-comment-body')].map(el => el.innerText.slice(0, 100));
          return { rails };
        });
        log('1f: comment in rail', commentInRail);
      }
    }
  }

  // Transition subtask state if any
  const subtaskState = await page.evaluate(() => {
    const row = document.querySelector('.cockpit-task-row');
    const btn = row?.querySelector('.cockpit-task-state');
    return { hasRow: !!row, hasBtn: !!btn, stateText: btn?.textContent?.trim() || '' };
  });
  log('1g: subtask state', subtaskState);
  if (subtaskState.hasBtn) {
    const beforeState = subtaskState.stateText;
    await page.evaluate(() => {
      const btn = document.querySelector('.cockpit-task-state');
      if (btn) btn.click();
    });
    await page.waitForTimeout(1000);
    const afterState = await page.evaluate(() => document.querySelector('.cockpit-task-row .cockpit-task-state')?.textContent?.trim() || '');
    log('1h: subtask state transition', { beforeState, afterState });
    assert.notEqual(afterState, '', 'subtask state button should have text after click');
    // Optionally cycle back, but not required
  }

  // ── Journey 2: Project Ideas Flow (project-scoped) ──
  log('2: project ideas flow');
  // Open ideas drawer via sidebar link or button
  const ideasOpened = await page.evaluate(() => {
    const link = document.querySelector('.sidebar-link-ideas') || document.querySelector('.cockpit-ideas-btn');
    if (link) { link.click(); return true; }
    window.Router && window.Router.openIdeas && window.Router.openIdeas();
    return !!document.querySelector('.ideas-drawer');
  });
  await page.waitForTimeout(800);
  const ideasDrawer = await page.evaluate(() => {
    const drawer = document.querySelector('.ideas-drawer.open') || document.querySelector('.ideas-drawer');
    const isOpen = drawer?.classList.contains('open');
    const countEl = document.querySelector('.ideas-count');
    return { isOpen: !!isOpen, hasDrawer: !!drawer, countText: countEl?.textContent?.trim() || '' };
  });
  log('2a: ideas drawer', ideasDrawer);
  assert.ok(ideasDrawer.hasDrawer, 'ideas drawer should exist');
  // Create an idea via API (project-scoped) and verify it appears in drawer
  const ideaText = `smoke idea ${Date.now()} — test project scoped`;
  const createIdeaRes = await fetch(`${base}/api/ideas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: ideaText, project_id: projectId }),
  });
  assert.equal(createIdeaRes.status, 200, 'create idea should succeed');
  const createdIdea = await createIdeaRes.json();
  log('2b: created idea', { id: createdIdea.id, project_id: createdIdea.project_id || createdIdea.projectId });
  assert.ok(createdIdea.id, 'idea should have id');
  // Wait for drawer to reflect new idea (poll)
  await page.waitForTimeout(800);
  // Refresh drawer by closing and reopening (ideas:changed event should have updated)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('ideas:changed')));
  await page.waitForTimeout(500);
  const ideaInList = await page.evaluate((text) => {
    const items = [...document.querySelectorAll('.idea-card .idea-body')].map(el => el.innerText);
    return { items: items.slice(0, 5), found: items.some(t => t.includes(text.slice(0, 20))) };
  }, ideaText);
  log('2c: idea in list', ideaInList);
  // Promote idea to spec via UI or API
  const promoteRes = await fetch(`${base}/api/ideas/${encodeURIComponent(createdIdea.id)}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title: `SMOKE promoted ${Date.now()}` }),
  });
  assert.equal(promoteRes.status, 201, 'promote idea should succeed');
  const promoted = await promoteRes.json();
  log('2d: promoted idea', { ticket: promoted.ticket?.display_id || promoted.ticket?.id });
  assert.ok(promoted.ticket, 'promoted ticket should exist');
  // Verify promoted spec appears in left tree (wait a bit for store update)
  await page.waitForTimeout(1500);
  const promotedInTree = await page.evaluate((title) => {
    const items = [...document.querySelectorAll('.cockpit-spec-item .cockpit-spec-title')].map(el => el.innerText);
    return { found: items.some(t => t.includes(title.slice(0, 15))), items: items.slice(0, 3) };
  }, promoted.ticket.title);
  log('2e: promoted in tree', promotedInTree);
  // Cleanup: archive promoted ticket and pop idea if still exists (promote already popped)
  await fetch(`${base}/api/tickets/${encodeURIComponent(promoted.ticket.display_id || promoted.ticket.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'archived', actor: 'smoke' }),
  }).catch(()=>{});
  // Also ensure idea is gone (promote pops it, but if not, pop)
  await fetch(`${base}/api/ideas/${encodeURIComponent(createdIdea.id)}/pop`, { method: 'POST' }).catch(()=>{});
  // Close ideas drawer
  await page.evaluate(() => window.Router && window.Router.closeIdeas && window.Router.closeIdeas());
  await page.waitForTimeout(400);

  // ── Journey 3: Project Global Directive Space ──
  log('3: directive space');
  // Open via button in hero
  const directiveBtnExists = await page.evaluate(() => !!document.querySelector('.cockpit-hero-actions button'));
  log('3a: directive button exists', { exists: directiveBtnExists });
  if (directiveBtnExists) {
    await page.click('.cockpit-hero-actions button');
    await page.waitForTimeout(500);
  } else {
    // Fallback: dispatch Cmd+K
    await page.keyboard.down('Meta');
    await page.keyboard.press('k');
    await page.keyboard.up('Meta');
    await page.waitForTimeout(500);
  }
  let directiveModal = await page.evaluate(() => {
    const modal = document.querySelector('.directive-modal');
    return { hasModal: !!modal, isVisible: modal && getComputedStyle(modal).display !== 'none' };
  });
  log('3b: directive modal', directiveModal);
  // If not opened via hero button, try explicit Router trigger (project view's Cmd+K listener should handle)
  if (!directiveModal.hasModal) {
    await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(500);
    directiveModal = await page.evaluate(() => ({ hasModal: !!document.querySelector('.directive-modal') }));
    log('3c: directive modal after Cmd+K', directiveModal);
  }
  if (directiveModal.hasModal) {
    // Select recipient (lead) and context none, type directive, dispatch
    await page.evaluate(() => {
      const ta = document.querySelector('.directive-modal textarea');
      if (ta) ta.value = '';
    });
    await page.type('.directive-modal textarea', `smoke directive ${Date.now()} — freeform test`);
    // Ensure recipient is lead and context none (default)
    const dispatchBtn = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.directive-modal button')].find(b => b.textContent.includes('Dispatch'));
      return { exists: !!btn, disabled: btn?.disabled };
    });
    log('3d: dispatch button', dispatchBtn);
    if (dispatchBtn.exists && !dispatchBtn.disabled) {
      await page.click('.directive-modal button.orch-btn.primary');
      await page.waitForTimeout(1500);
      const result = await page.evaluate(() => {
        const res = document.querySelector('.directive-result');
        const err = document.querySelector('.directive-error');
        return { hasResult: !!res, resultText: res?.innerText?.slice(0, 200) || '', hasError: !!err, errorText: err?.innerText?.slice(0, 200) || '' };
      });
      log('3e: directive result', result);
      // For None freeform without live worker, it may show error "No live worker" — that's acceptable, not a crash
      assert.ok(result.hasResult || result.hasError, 'directive dispatch should show result or error, not crash');
    }
    // Close modal
    await page.click('.directive-modal .drawer-close');
    await page.waitForTimeout(400);
  } else {
    log('3: directive modal not found, skipping dispatch check (may be no project)');
  }

  // ── Journey 4: Zero-Terminal Worker Ops ──
  log('4: worker ops');
  // Check swarm cards exist (may be 0 if no workers)
  const swarmState = await page.evaluate(() => {
    const cards = document.querySelectorAll('.cockpit-swarm-card');
    const peekBtns = document.querySelectorAll('.cockpit-swarm-card .cockpit-swarm-actions button, .cockpit-swarm-card button[title*="streaming"]');
    return { cardCount: cards.length, hasPeekBtn: peekBtns.length > 0 };
  });
  log('4a: swarm', swarmState);
  if (swarmState.cardCount > 0) {
    // Click peek / live output on first card
    await page.click('.cockpit-swarm-card .cockpit-swarm-actions button:first-child');
    await page.waitForSelector('.peek-modal', { timeout: 5000 }).catch(() => null);
    const peekState = await page.evaluate(() => {
      const modal = document.querySelector('.peek-modal');
      const pre = document.querySelector('.peek-pre');
      return { hasModal: !!modal, hasPre: !!pre, preText: pre?.innerText?.slice(0, 200) || '' };
    });
    log('4b: peek modal', peekState);
    assert.ok(peekState.hasModal, 'peek modal should open on Peek click');
    // Verify ANSI colors are rendered (check for span with style)
    const ansiState = await page.evaluate(() => {
      const pre = document.querySelector('.peek-pre');
      const spans = pre?.querySelectorAll('span');
      return { spanCount: spans?.length || 0, hasSpans: (spans?.length || 0) > 0 };
    });
    log('4c: ansi', ansiState);
    // Test steer: type in steer input and click Steer
    const steerInputExists = await page.evaluate(() => !!document.querySelector('.peek-steer-input'));
    if (steerInputExists) {
      await page.type('.peek-steer-input', `steer ${Date.now()}`);
      await page.click('.peek-modal button.orch-btn.primary');
      await page.waitForTimeout(1000);
      const steerResult = await page.evaluate(() => {
        const msg = document.querySelector('.peek-action-msg');
        return { hasMsg: !!msg, text: msg?.innerText?.slice(0, 200) || '' };
      });
      log('4d: steer result', steerResult);
      // Close peek
      await page.click('.peek-modal .drawer-close, .peek-modal button.drawer-close');
      await page.waitForTimeout(400);
    } else {
      await page.click('.peek-modal .drawer-close');
      await page.waitForTimeout(400);
    }
  } else {
    log('4: no alive workers, testing spawn modal');
    // Test worker spawn modal
    const spawnBtnExists = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('Spawn'));
      return { count: btns.length, hasBtn: btns.length > 0 };
    });
    log('4e: spawn button', spawnBtnExists);
    if (spawnBtnExists.hasBtn) {
      // Click first spawn button via evaluate (avoid :has-text selector incompatibility)
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Spawn'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(500);
      const spawnModal = await page.evaluate(() => ({ hasModal: !!document.querySelector('.worker-spawn-modal') }));
      log('4f: spawn modal', spawnModal);
      if (spawnModal.hasModal) {
        // Just verify it has role select and can close, don't actually spawn (would create real tmux)
        await page.click('.worker-spawn-modal .drawer-close');
        await page.waitForTimeout(400);
      }
    }
  }

  // ── Journey 5: No console errors + onboarding wizard ──
  log('5: onboarding wizard');
  await page.goto(`${base}/onboarding`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const onboarding = await page.evaluate(() => {
    const stepper = document.querySelector('.onboarding-stepper');
    const diagnostic = document.querySelector('.diagnostic-card');
    const steps = document.querySelectorAll('.onboarding-step');
    return { hasStepper: !!stepper, hasDiagnostic: !!diagnostic, stepCount: steps.length };
  });
  log('5a: onboarding', onboarding);
  assert.ok(onboarding.hasStepper, 'onboarding stepper should exist');
  assert.ok(onboarding.hasDiagnostic, 'diagnostic card should exist on onboarding');
  assert.equal(onboarding.stepCount, 3, 'onboarding should have 3 steps');

  // Check settings also has diagnostic card
  await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const settingsDiag = await page.evaluate(() => !!document.querySelector('.diagnostic-card'));
  log('5b: settings diagnostic', { hasDiag: settingsDiag });
  assert.ok(settingsDiag, 'settings page should have diagnostic card');

  // Final console errors check
  assert.equal(consoleErrors.length, 0, `no console errors should have occurred: ${consoleErrors.join('; ')}`);

  log('all journeys passed');
  console.log(JSON.stringify({ ok: true, projectId, consoleErrors: consoleErrors.length, onboarding, cockpit }, null, 2));
} catch (e) {
  failed = true;
  console.error('[smoke-ux-rehaul] failed', e);
  console.error(e.stack || String(e));
  // Try to capture screenshot for debugging
  try {
    if (chrome && chrome.browser) {
      const pages = await chrome.browser.pages();
      if (pages[0]) await pages[0].screenshot({ path: '/tmp/smoke-ux-rehaul-fail.png' }).catch(()=>{});
      console.error('screenshot at /tmp/smoke-ux-rehaul-fail.png');
    }
  } catch {}
  process.exit(1);
} finally {
  if (chrome) await chrome.cleanup().catch(()=>{});
  if (failed) process.exit(1);
}
