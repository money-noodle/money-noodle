import Fastify, { type FastifyInstance } from 'fastify';

export function createHttpServer(): FastifyInstance {
  return Fastify({ logger: false });
}
