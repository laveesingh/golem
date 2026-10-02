import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  TicketCreatedOutput,
  TicketCreateInput,
} from '../../lib/contracts/pilot.ts';
import {
  HealthResponse,
  JsonValue,
  PilotError,
  TicketCreateBody,
  TicketCreated,
} from '../../lib/contracts/pilot.ts';
import { pilotValidationError } from './contract-policy.ts';

interface PilotDependencies {
  projectsRoot: string;
  projectCount: () => number;
  enforceAttribution: (reply: FastifyReply, body: TicketCreateInput) => unknown;
  createTicket: (body: TicketCreateInput) => TicketCreatedOutput;
  broadcast: (ticket: TicketCreatedOutput) => void;
  sendTrackerError: (reply: FastifyReply, error: unknown) => unknown;
}
export function registerContractPilot(
  server: FastifyInstance,
  deps: PilotDependencies,
): void {
  const app = server.withTypeProvider<TypeBoxTypeProvider>();
  app.addSchema(JsonValue);
  app.get(
    '/api/health',
    {
      schema: {
        operationId: 'health',
        tags: ['pilot'],
        response: { 200: HealthResponse },
      },
    },
    async () => ({
      ok: true as const,
      projects_root: deps.projectsRoot,
      project_count: deps.projectCount(),
      server_time: new Date().toISOString(),
    }),
  );
  app.post(
    '/api/tickets',
    {
      schema: {
        operationId: 'createTicket',
        tags: ['pilot'],
        body: TicketCreateBody,
        response: {
          201: TicketCreated,
          400: PilotError,
          413: PilotError,
          415: PilotError,
          500: PilotError,
        },
      },
      errorHandler: (error, request, reply) => {
        if (error.validation)
          return reply
            .code(400)
            .send(pilotValidationError(request.body, error.message));
        const rawReply: FastifyReply = reply;
        return rawReply.send(error); // Fastify owns parser/content-type serialization.
      },
    },
    async (req, reply) => {
      const body = req.body;
      const attribution = deps.enforceAttribution(reply, body);
      if (attribution) return reply;
      try {
        const ticket = deps.createTicket(body);
        deps.broadcast(ticket);
        return reply.code(201).send(ticket);
      } catch (error) {
        deps.sendTrackerError(reply, error);
        return reply;
      }
    },
  );
}
