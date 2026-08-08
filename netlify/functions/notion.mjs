const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

const subjectPages = {
  fis: "3b6882dc-d26d-817e-a021-d40b2d205593",
  fc: "3b6882dc-d26d-81ca-9b34-df9c734dc44d",
  fp1: "3b6882dc-d26d-814a-bd4e-e7b498b102af",
  m1: "3b6882dc-d26d-8166-9889-ccfd428b9c9d",
  m2: "3b6882dc-d26d-8144-8c63-d3d27669aeeb",
  af: "3b6882dc-d26d-81b7-a18e-d125668675da",
  eb: "3b6882dc-d26d-8189-851c-f1cead1d317c",
  fi: "3b6882dc-d26d-81cc-81c2-e795df5f5970",
  ss: "3b6882dc-d26d-811a-939a-ce3e80717123"
};

const json = (status, body) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  },
  body: JSON.stringify(body)
});

const title = value => ({
  title: [{ type: "text", text: { content: String(value).slice(0, 2000) } }]
});

const text = value => ({
  rich_text: value
    ? [{ type: "text", text: { content: String(value).slice(0, 2000) } }]
    : []
});

const relation = subject => ({
  relation: subjectPages[subject] ? [{ id: subjectPages[subject] }] : []
});

async function notion(path, method, payload) {
  const response = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.message || "Notion no pudo guardar el cambio.");
  }

  return body;
}

function secure(event) {
  const supplied =
    event.headers?.["x-ecosystem-key"] ||
    event.headers?.["X-Ecosystem-Key"];

  return process.env.ADMIN_PASSWORD &&
    supplied === process.env.ADMIN_PASSWORD;
}

export const handler = async event => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Método no permitido" });
  }

  if (!process.env.NOTION_TOKEN) {
    return json(500, { error: "Falta configurar NOTION_TOKEN." });
  }

  if (!secure(event)) {
    return json(401, {
      error: "Introduce la clave de edición para sincronizar."
    });
  }

  try {
    const { action, data = {} } = JSON.parse(event.body || "{}");
    let page;

    if (action === "createTask") {
      const type = [
        "Tarea",
        "Práctica",
        "Parcial",
        "Examen",
        "Recordatorio"
      ].includes(data.type) ? data.type : "Tarea";

      page = await notion("/pages", "POST", {
        parent: {
          type: "data_source_id",
          data_source_id: process.env.NOTION_TASKS_DATA_SOURCE_ID
        },
        properties: {
          "Título": title(data.title),
          "Asignatura": relation(data.subject),
          "Tipo": { select: { name: type } },
          "Fecha": { date: { start: data.date } },
          "Estado": {
            status: { name: data.done ? "Listo" : "Sin empezar" }
          },
          "Prioridad": { select: { name: "Media" } },
          "Descripción": text(data.description),
          "Completada": { checkbox: Boolean(data.done) }
        }
      });
    } else if (action === "updateTask") {
      page = await notion(`/pages/${data.notionId}`, "PATCH", {
        properties: {
          "Completada": { checkbox: Boolean(data.done) },
          "Estado": {
            status: { name: data.done ? "Listo" : "Sin empezar" }
          }
        }
      });
    } else if (action === "archiveTask" || action === "archiveGrade") {
      page = await notion(`/pages/${data.notionId}`, "PATCH", {
        in_trash: true
      });
    } else if (action === "createGrade") {
      page = await notion("/pages", "POST", {
        parent: {
          type: "data_source_id",
          data_source_id: process.env.NOTION_GRADES_DATA_SOURCE_ID
        },
        properties: {
          "Evaluación": title(data.name),
          "Asignatura": relation(data.subject),
          "Tipo": { select: { name: "Práctica" } },
          "Nota": { number: Number(data.score) },
          "Sobre": { number: 10 },
          "Peso (%)": { number: Number(data.weight) }
        }
      });
    } else if (action === "createResource") {
      page = await notion("/pages", "POST", {
        parent: {
          type: "data_source_id",
          data_source_id: process.env.NOTION_RESOURCES_DATA_SOURCE_ID
        },
        properties: {
          "Recurso": title(data.name),
          "Asignatura": relation(data.subject),
          "Categoría": { select: { name: "Otro" } },
          "Estado": { select: { name: "En uso" } },
          "Notas": text(data.notes)
        }
      });
    } else {
      return json(400, { error: "Acción no reconocida" });
    }

    return json(200, {
      ok: true,
      notionId: page.id,
      url: page.url
    });
  } catch (error) {
    return json(500, {
      error: error.message || "No se pudo sincronizar con Notion."
    });
  }
};
