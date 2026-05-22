/**
 * Response-class fixtures for prober tests (CAPABILITY_PROBES.md "Test fixtures").
 *
 * One factory per response class so individual tests can compose them. Each
 * factory returns a fresh `Response` because consuming the body once
 * invalidates it for further reads.
 */

export function ok(body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function partial(body: unknown = [], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 206,
    headers: {
      "content-type": "application/json",
      "content-range": "id 0..0; max=1, total=1; order=asc",
      ...headers,
    },
  });
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ id: "unauthorized", message: "Bad token." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export function delinquent(): Response {
  return new Response(JSON.stringify({ id: "delinquent", message: "Account past due." }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

export function forbidden(): Response {
  return new Response(JSON.stringify({ id: "forbidden", message: "No access." }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

export function suspended(): Response {
  return new Response(JSON.stringify({ id: "suspended", message: "Suspended." }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

export function notFound(): Response {
  return new Response(JSON.stringify({ id: "not_found", message: "No resource." }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

export function rateLimited(): Response {
  return new Response(JSON.stringify({ id: "rate_limit", message: "Slow down." }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

export function serverError(): Response {
  return new Response(JSON.stringify({ id: "internal_error", message: "Boom." }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

export function timeout(): Error {
  const err = new Error("timeout");
  err.name = "AbortError";
  return err;
}

export function networkFail(): Error {
  return new Error("ECONNREFUSED");
}
