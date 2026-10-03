// Generated from contracts/dist/openapi.json by tools/contracts-build.ts.
import createClient from 'openapi-fetch';
import type { paths } from './contracts/pilot-api.d.ts';

type CreateTicketBody =
  paths['/api/tickets']['post']['requestBody']['content']['application/json'];
const failed = (response: Response, payload: unknown, path: string) => {
  throw Object.assign(new Error(response.status + ' ' + response.statusText + ' ' + path), { payload });
};
export function createPilotClient(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const client = createClient<paths>({ baseUrl, fetch: fetchImpl });
  return {
    async health() {
      const { data, error, response } = await client.GET('/api/health');
      if (!response.ok || data === undefined) return failed(response, error, `/api/health`);
      return data;
    },
    async createTicket(body: CreateTicketBody) {
      const { data, error, response } = await client.POST('/api/tickets', { body });
      if (!response.ok || data === undefined) return failed(response, error, `/api/tickets`);
      return data;
    },
  };
}
