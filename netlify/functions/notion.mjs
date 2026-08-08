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

const subjectFromPage = Object.fromEntries(
  Object.entries(subjectPages).map(([subject, pageId]) => [
    pageId.replaceAll("-", "").toLowerCase(),
    subject
  ])
);
const SUBJECTS_DATA_SOURCE_ID = "8a04720a-3ccd-4497-a05c-01af1c59f3ea";

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

async function queryAll(dataSourceId) {
  const results = [];
  let cursor;

  do {
    const page = await notion(`/data_sources/${dataSourceId}/query`, "POST", {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    });
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return results;
}

const plainText = property => {
  const values = property?.title || property?.rich_text || [];
  return values
    .map(value => value.plain_text || value.text?.content || "")
    .join("");
};

const relatedSubject = property => {
  const id = property?.relation?.[0]?.id
    ?.replaceAll("-", "")
    .toLowerCase();
  return id ? subjectFromPage[id] || "" : "";
};

function taskFromPage(page) {
  const properties = page.properties || {};
  const subject = relatedSubject(properties["Asignatura"]);
  const date = properties["Fecha"]?.date?.start?.slice(0, 10) || "";
  if (!subject || !date) return null;

  return {
    id: page.id,
    notionId: page.id,
    title: plainText(properties["Título"]),
    date,
    type: properties["Tipo"]?.select?.name || "Tarea",
    subject,
    description: plainText(properties["Descripción"]),
    done:
      Boolean(properties["Completada"]?.checkbox) ||
      properties["Estado"]?.status?.name === "Listo",
    createdAt: page.created_time
  };
}

function gradeFromPage(page) {
  const properties = page.properties || {};
  const subject = relatedSubject(properties["Asignatura"]);
  if (!subject) return null;

  return {
    id: page.id,
    notionId: page.id,
    subject,
    name: plainText(properties["Evaluación"]),
    score: Number(properties["Nota"]?.number || 0),
    weight: Number(properties["Peso (%)"]?.number || 0)
  };
}

async function sharedState() {
  const [taskPages, gradePages, subjectPageList] = await Promise.all([
    queryAll(process.env.NOTION_TASKS_DATA_SOURCE_ID),
    queryAll(process.env.NOTION_GRADES_DATA_SOURCE_ID),
    queryAll(
      process.env.NOTION_SUBJECTS_DATA_SOURCE_ID || SUBJECTS_DATA_SOURCE_ID
    )
  ]);

  const subjectNotes = {};
  subjectPageList.forEach(page => {
    const subject =
      subjectFromPage[page.id.replaceAll("-", "").toLowerCase()];
    if (subject) {
      subjectNotes[subject] = plainText(page.properties?.["Notas web"]);
    }
  });

  return {
    tasks: taskPages.map(taskFromPage).filter(Boolean),
    grades: gradePages.map(gradeFromPage).filter(Boolean),
    subjectNotes,
    updatedAt: new Date().toISOString()
  };
}

function secure(event) {
  const supplied =
    event.headers?.["x-ecosystem-key"] ||
    event.headers?.["X-Ecosystem-Key"];

  return process.env.ADMIN_PASSWORD &&
    supplied === process.env.ADMIN_PASSWORD;
}

export const handler = async event => {
  if (!["GET", "POST"].includes(event.httpMethod)) {
    return json(405, { error: "Método no permitido" });
  }

  if (!process.env.NOTION_TOKEN) {
    return json(500, { error: "Falta configurar NOTION_TOKEN." });
  }

  if (event.httpMethod === "GET") {
    try {
      if (
        !process.env.NOTION_TASKS_DATA_SOURCE_ID ||
        !process.env.NOTION_GRADES_DATA_SOURCE_ID
      ) {
        return json(500, {
          error: "Faltan las bases compartidas de Notion."
        });
      }

      return json(200, { ok: true, ...(await sharedState()) });
    } catch (error) {
      return json(500, {
        error:
          error.message || "No se pudo leer la información compartida."
      });
    }
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
    } else if (action === "updateSubjectNotes") {
      const subjectPage = subjectPages[data.subject];

      if (!subjectPage) {
        return json(400, { error: "Asignatura no reconocida" });
      }

      page = await notion(`/pages/${subjectPage}`, "PATCH", {
        properties: {
          "Notas web": text(data.notes)
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
