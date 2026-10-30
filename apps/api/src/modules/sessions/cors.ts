import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// CORS for routes browsers call from other origins (the widget on merchant sites, the portal, the
// demo store). Register inside the plugin that owns the routes, so it covers only those.

export function allowCors(
  app: FastifyInstance,
  options: { allowOrigin: (origin: string) => boolean; paths: string[]; headers: string },
): void {
  app.addHook("onRequest", (request, reply, next) => {
    const { origin } = request.headers;
    if (origin !== undefined && options.allowOrigin(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-expose-headers", "x-request-id");
      reply.header("vary", "Origin");
    }
    next();
  });
  const preflight = (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(204)
      .header("access-control-allow-methods", "GET, POST")
      .header("access-control-allow-headers", options.headers)
      .header("access-control-max-age", "600")
      .send();
  for (const path of options.paths) app.options(path, preflight);
}
