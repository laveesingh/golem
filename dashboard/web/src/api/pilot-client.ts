import createClient from 'openapi-fetch';
import type { paths } from './types.d.ts';

type CreateTicketBody =
  paths['/api/tickets']['post']['requestBody']['content']['application/json'];
export function pilotClient(
  baseUrl = '',
  fetcher: typeof fetch = globalThis.fetch,
) {
  const client = createClient<paths>({ baseUrl, fetch: fetcher });
  const failed = (response: Response, payload: unknown, path: string) => {
    const error = Object.assign(
      new Error(`${response.status} ${response.statusText} ${path}`),
      { payload },
    );
    throw error;
  };
  return {
    async health() {
      const { data, error, response } = await client.GET('/api/health');
      if (!response.ok || data === undefined)
        return failed(response, error, '/api/health');
      return data;
    },
    async createTicket(body: CreateTicketBody) {
      // Preserve legacy JS null-call transport: send {} and let the real
      // server's owned semantic missing-field error remain the public result.
      const { data, error, response } = await client.POST('/api/tickets', {
        body: body ?? ({} as CreateTicketBody),
      });
      if (!response.ok || data === undefined)
        return failed(response, error, '/api/tickets');
      return data;
    },
  };
}
const browser = pilotClient();
export const createPilotTicket = browser.createTicket;
export const pilotHealth = browser.health;
