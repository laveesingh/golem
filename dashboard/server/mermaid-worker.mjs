// Mermaid check worker thread (GOL-369 D7): owns the single mermaid import.
// The parent (mermaid-check.js) drives it synchronously via shared memory
// because the tracker DB layer is synchronous: the parent posts {sources},
// blocks in Atomics.wait, and reads the JSON results from the shared buffer.
// Never imported by the web bundle.
import { parentPort } from 'node:worker_threads';
import DOMPurify from 'dompurify';

// Node has no DOM: stub the hooks mermaid needs before it loads. Without the
// stub, state/class/mindmap diagrams throw `DOMPurify.addHook is not a
// function`; with it, parse is syntax-only (layout-time failures still show
// in the browser renderer, as before).
if (typeof DOMPurify.addHook !== 'function') {
  DOMPurify.addHook = () => {};
  DOMPurify.removeHook = () => {};
  DOMPurify.removeHooks = () => {};
}
if (typeof DOMPurify.sanitize !== 'function') {
  DOMPurify.sanitize = (x) => String(x ?? '');
}

const mermaid = (await import('mermaid')).default;

parentPort.on('message', async ({ flagBuffer, dataBuffer, sources }) => {
  const flag = new Int32Array(flagBuffer);
  const data = Buffer.from(dataBuffer);
  try {
    const results = [];
    for (const source of sources) {
      try {
        await mermaid.parse(String(source));
        results.push({ ok: true });
      } catch (err) {
        results.push({ ok: false, error: String(err?.message ?? err).slice(0, 500) });
      }
    }
    const json = Buffer.from(JSON.stringify(results));
    if (json.length > data.length) {
      Atomics.store(flag, 0, -1); // overflow: parent fails open
    } else {
      json.copy(data);
      Atomics.store(flag, 0, json.length);
    }
  } catch {
    Atomics.store(flag, 0, -1);
  }
  Atomics.notify(flag, 1);
});
