/**
 * Zod ↔ Fastify bridge (plan §6).
 *
 * One Zod schema per route serves three jobs at once: it validates the
 * request, it serializes the response (stripping anything not declared), and
 * `@fastify/swagger` reads it to generate the OpenAPI document. That is the
 * mechanism behind the §15 "schema drift" mitigation — there is only one
 * schema, so request and response cannot disagree.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type FastifyPluginAsyncZod,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

export type { FastifyPluginAsyncZod, ZodTypeProvider };

/** A Fastify instance whose route generics infer from Zod schemas. */
export type ZodFastify = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Installs the compilers and hands back the same instance, re-typed. */
export function registerTypeProvider(app: FastifyInstance): ZodFastify {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app.withTypeProvider<ZodTypeProvider>();
}
