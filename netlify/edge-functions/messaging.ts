import type { Config, Context } from "@netlify/edge-functions";
import contracts from "../../messaging/contracts.json" with { type: "json" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export default async (request: Request, _context: Context): Promise<Response> => {
  if (!new Set(["GET", "HEAD"]).has(request.method)) {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/gateway/messaging";
  let body: unknown;

  if (path === "/gateway/messaging") {
    body = {
      service: contracts.service,
      counts: {
        platforms: contracts.platforms.length,
        operations: contracts.operations.length,
      },
      routes: [
        "/gateway/messaging/platforms",
        "/gateway/messaging/platforms/:id",
        "/gateway/messaging/operations",
        "/gateway/messaging/policy",
        "/gateway/messaging/surfaces",
      ],
      publicExecution: false,
    };
  } else if (path === "/gateway/messaging/platforms") {
    body = { platforms: contracts.platforms };
  } else if (path.startsWith("/gateway/messaging/platforms/")) {
    const id = decodeURIComponent(path.slice("/gateway/messaging/platforms/".length));
    const platform = contracts.platforms.find((entry) => entry.id === id);
    if (!platform) return json({ error: "platform_not_found", id }, 404);
    body = platform;
  } else if (path === "/gateway/messaging/operations") {
    body = { operations: contracts.operations };
  } else if (path === "/gateway/messaging/policy") {
    body = contracts.policy;
  } else if (path === "/gateway/messaging/surfaces") {
    body = { observations: contracts.observedSurfaces };
  } else {
    return json({ error: "not_found", path }, 404);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }
  return json(body);
};

export const config: Config = {
  path: ["/gateway/messaging", "/gateway/messaging/*"],
  method: ["GET", "HEAD"],
};
