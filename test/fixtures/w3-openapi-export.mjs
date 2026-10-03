import fs from 'node:fs';
import path from 'node:path';
import { startPrivateDashboard } from '../support/private-dashboard.mjs';

const target = path.join(process.env.GOLEM_W2_SANDBOX, 'openapi.json');
const dashboard = await startPrivateDashboard({
  env: { ...process.env, GOLEM_OPENAPI_EXPORT: target },
});
try {
  console.log(fs.readFileSync(target, 'utf8'));
} finally {
  await dashboard.stop();
}
