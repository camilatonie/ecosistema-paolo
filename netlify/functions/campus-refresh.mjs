import { syncCampus } from "./campus-sync.mjs";

const json = (status, body) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(body)
});

export const handler = async event => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Método no permitido." });
  }

  const supplied = event.headers?.["x-ecosystem-key"];
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
