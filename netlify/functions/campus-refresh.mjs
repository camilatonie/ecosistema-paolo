import { syncCampus } from "./campus-sync.mjs";

const json = (status, body) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export default async request => {
  if (request.method !== "POST") {
    return json(405, { error: "Método no permitido." });
  }

  const supplied = request.headers.get("x-ecosystem-key");
  if (!process.env.ADMIN_PASSWORD || supplied !== process.env.ADMIN_PASSWORD) {
    return json(401, { error: "Introduce la clave de edición para actualizar el Campus." });
  }

  try {
    const result = await syncCampus();
    return json(200, { ok: true, ...result });
  } catch (error) {
    return json(500, {
      error: error.message || "No se pudo actualizar el Campus Virtual."
    });
  }
};

export const config = {
  path: "/api/campus/refresh",
  method: "POST",
  rateLimit: {
    windowLimit: 6,
    windowSize: 3600,
    aggregateBy: ["domain", "ip"]
  }
};
