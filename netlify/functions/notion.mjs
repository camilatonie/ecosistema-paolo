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
const MAX_PUBLIC_PDF_BYTES = 4 * 1024 * 1024;

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

const longText = value => ({
  rich_text: String(value || "")
    .slice(0, 190000)
    .match(/[\s\S]{1,1900}/g)
    ?.map(content => ({ type: "text", text: { content } })) || []
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

async function sendFileToNotion(uploadId, bytes, filename) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/pdf" }),
    filename
  );

  const response = await fetch(
    `${NOTION_API}/file_uploads/${uploadId}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION
      },
      body: form
    }
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message || "Notion no pudo recibir el PDF.");
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

function academicNoteFromPage(page) {
  const properties = page.properties || {};
  const description = plainText(properties["Descripción"]);
  if (!description.startsWith("[[ECOSISTEMA_NOTA]]")) return null;
  const subject = relatedSubject(properties["Asignatura"]);
  const date = properties["Fecha"]?.date?.start?.slice(0, 10) || "";
  if (!subject || !date) return null;
  const kind = description.match(/\nTipo: (.+?)(?:\n|$)/)?.[1] || "sesion";
  const content = description.replace(/^\[\[ECOSISTEMA_NOTA\]\]\nTipo: .+?\n/s, "");
  return {
    id: page.id,
    notionId: page.id,
    subject,
    date,
    kind,
    title: plainText(properties["Título"]) || "Nota",
    content,
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

function resourceFromPage(page) {
  const properties = page.properties || {};
  const subject = relatedSubject(properties["Asignatura"]);
  const file = properties["Archivo"]?.files?.[0];
  const url = file?.file?.url || file?.external?.url || "";
  if (!subject || !url) return null;

  return {
    id: page.id,
    notionId: page.id,
    subject,
    name: file.name || plainText(properties["Recurso"]) || "Documento.pdf",
    url,
    addedAt: page.created_time,
    category: properties["Categoría"]?.select?.name || "Otro",
    order: Number(plainText(properties["Notas"]).match(/\[\[orden:(\d+)\]\]/)?.[1] || 9999),
    notes: plainText(properties["Notas"]).replace(/\[\[orden:\d+\]\]\s*/g, "")
  };
}

async function uploadSharedPdf(data) {
  if (!process.env.NOTION_RESOURCES_DATA_SOURCE_ID) {
    throw new Error("Falta configurar la biblioteca compartida.");
  }
  if (!subjectPages[data.subject]) {
    throw new Error("Asignatura no reconocida.");
  }

  const filename = String(data.name || "documento.pdf")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 180);
  if (!filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("Solo se permiten archivos PDF.");
  }

  const match = String(data.content || "").match(
    /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/
  );
  if (!match) {
    throw new Error("El archivo no es un PDF válido.");
  }
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > MAX_PUBLIC_PDF_BYTES) {
    throw new Error("El PDF debe pesar como máximo 4 MB.");
  }
  if (bytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("El contenido no corresponde a un PDF válido.");
  }

  const upload = await notion("/file_uploads", "POST", {
    mode: "single_part",
    filename,
    content_type: "application/pdf"
  });
  await sendFileToNotion(upload.id, bytes, filename);

  return notion("/pages", "POST", {
    parent: {
      type: "data_source_id",
      data_source_id: process.env.NOTION_RESOURCES_DATA_SOURCE_ID
    },
    properties: {
      "Recurso": title(filename),
      "Asignatura": relation(data.subject),
      "Categoría": { select: { name: data.category || "Apuntes" } },
      "Estado": { select: { name: "En uso" } },
      "Notas": text("PDF compartido desde Ecosistema Paolo"),
      "Archivo": {
        files: [
          {
            type: "file_upload",
            file_upload: { id: upload.id },
            name: filename
          }
        ]
      }
    }
  });
}

async function sharedState() {
  const [taskPages, gradePages, subjectPageList, resourcePages] = await Promise.all([
    queryAll(process.env.NOTION_TASKS_DATA_SOURCE_ID),
    queryAll(process.env.NOTION_GRADES_DATA_SOURCE_ID),
    queryAll(
      process.env.NOTION_SUBJECTS_DATA_SOURCE_ID || SUBJECTS_DATA_SOURCE_ID
    ),
    queryAll(process.env.NOTION_RESOURCES_DATA_SOURCE_ID)
  ]);

  const subjectNotes = {};
  subjectPageList.forEach(page => {
    const subject =
      subjectFromPage[page.id.replaceAll("-", "").toLowerCase()];
    if (subject) {
      subjectNotes[subject] = plainText(page.properties?.["Notas web"]);
    }
  });

  const notes = taskPages.map(academicNoteFromPage).filter(Boolean);
  const tasks = taskPages
    .map(taskFromPage)
    .filter(task => task && !task.description.startsWith("[[ECOSISTEMA_NOTA]]"));

  return {
    tasks,
    notes,
    grades: gradePages.map(gradeFromPage).filter(Boolean),
    resources: resourcePages.map(resourceFromPage).filter(Boolean),
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
        !process.env.NOTION_GRADES_DATA_SOURCE_ID ||
        !process.env.NOTION_RESOURCES_DATA_SOURCE_ID
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

  let request;
  try {
    request = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Solicitud no válida." });
  }

  if (request.action === "uploadPdf") {
    try {
      const page = await uploadSharedPdf(request.data || {});
      return json(200, {
        ok: true,
        notionId: page.id,
        url: page.url
      });
    } catch (error) {
      return json(400, {
        error: error.message || "No se pudo compartir el PDF."
      });
    }
  }

  if (!secure(event)) {
    return json(401, {
      error: "Introduce la clave de edición para sincronizar."
    });
  }

  try {
    const { action, data = {} } = request;
    let page;

    if (action === "createTask") {
      const type = [
        "Tarea",
        "Práctica",
        "Parcial",
        "Examen",
        "Entrega",
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
    } else if (
      action === "archiveTask" ||
      action === "archiveGrade" ||
      action === "archiveAcademicNote"
    ) {
      page = await notion(`/pages/${data.notionId}`, "PATCH", {
        in_trash: true
      });
    } else if (action === "createAcademicNote") {
      const kind = data.kind === "general" ? "general" : "sesion";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(data.date || "")
        ? data.date
        : new Date().toISOString().slice(0, 10);
      page = await notion("/pages", "POST", {
        parent: {
          type: "data_source_id",
          data_source_id: process.env.NOTION_TASKS_DATA_SOURCE_ID
        },
        properties: {
          "Título": title(data.title || "Nota"),
          "Asignatura": relation(data.subject),
          "Tipo": { select: { name: "Recordatorio" } },
          "Fecha": { date: { start: date } },
          "Estado": { status: { name: "Listo" } },
          "Prioridad": { select: { name: "Media" } },
          "Descripción": longText(
            `[[ECOSISTEMA_NOTA]]\nTipo: ${kind}\n${data.content || ""}`
          ),
          "Completada": { checkbox: true }
        }
      });
    } else if (action === "updateAcademicNote") {
      if (!data.notionId) {
        return json(400, { error: "No se encontró la nota que quieres editar." });
      }
      const kind = data.kind === "general" ? "general" : "sesion";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(data.date || "")
        ? data.date
        : new Date().toISOString().slice(0, 10);
      page = await notion(`/pages/${data.notionId}`, "PATCH", {
        properties: {
          "Título": title(data.title || "Nota"),
          "Fecha": { date: { start: date } },
          "Descripción": longText(
            `[[ECOSISTEMA_NOTA]]\nTipo: ${kind}\n${data.content || ""}`
          )
        }
      });
    } else if (action === "updateResource") {
      page = await notion(`/pages/${data.notionId}`, "PATCH", {
        properties: {
          "Categoría": { select: { name: data.category || "Otro" } },
          "Notas": text(`[[orden:${Number(data.order) || 9999}]] ${data.notes || ""}`)
        }
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
