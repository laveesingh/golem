// Test fixture (T2 follow-up): a checker worker that receives requests and
// never answers. The parent must time out, fail open, and still commit the
// write — never freeze the event loop on a hung parse.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => {
  // Never answer.
});
