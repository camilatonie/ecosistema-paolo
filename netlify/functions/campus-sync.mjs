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

const subjectMatchers = [
  ["af", /ampliaci[oó]n de f[ií]sica/i],
  ["eb", /electr[oó]nica b[aá]sica/i],
  ["fi", /fundamentos? de internet/i],
  ["ss", /se[nñ]ales? y sistemas?/i],
  ["fp1", /fundamentos? de programaci[oó]n\s*i(?:\b|[^i])/i],
  ["fc", /fundamentos? de computadores?/i],
  ["m2", /matem[aá]ticas?\s*ii\b/i],
  ["m1", /matem[aá]ticas?\s*i\b/i],
  ["fis", /(?:^|\W)f[ií]sica(?:\W|$)/i]
];

const title = value => ({
  title: [{ type: "text", text: { content: String(value).slice(0, 2000) } }]
});

const text = value => ({
  rich_text: value
    ? [{ type: "text", text: { content: String(value).slice(0, 2000) } }]
    : []
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
    throw new Error(body.message || "Notion no pudo guardar el evento del campus.");
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

const plainText = property =>
  (property?.title || property?.rich_text || [])
    .map(value => value.plain_text || value.text?.content || "")
    .join("");

function unescapeIcs(value = "") {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsDate(value) {
  if (!value) return null;
  const compact = value.replace(/[^0-9TZ]/g, "");
  if (/^\d{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${utc || ""}`;
}

function parseCalendar(source) {
  const lines = source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let event;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      event = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (event?.UID && event?.DTSTART && event?.SUMMARY) events.push(event);
      event = undefined;
      continue;
    }
    if (!event) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).split(";")[0].toUpperCase();
    if (!["UID", "SUMMARY", "DESCRIPTION", "DTSTART", "DTEND", "LOCATION", "URL"].includes(key)) {
      continue;
    }
    event[key] = unescapeIcs(line.slice(separator + 1));
  }
  return events;
}

function subjectFor(event) {
  const haystack = [event.SUMMARY, event.DESCRIPTION, event.LOCATION].filter(Boolean).join(" ");
  return subjectMatchers.find(([, matcher]) => matcher.test(haystack))?.[0] || "";
}

function typeFor(summary) {
  if (/parcial/i.test(summary)) return "Parcial";
  if (/examen|prueba|test|quiz/i.test(summary)) return "Examen";
  if (/pr[aá]ctica|laboratorio/i.test(summary)) return "Práctica";
  if (/entrega|tarea|actividad/i.test(summary)) return "Tarea";
  return "Recordatorio";
}

function markerFor(uid) {
  return `Campus UID: ${uid}`;
}

function checksumFor(event) {
  const source = [
    event.SUMMARY,
    event.DTSTART,
    event.DTEND,
    event.DESCRIPTION,
    event.LOCATION,
    event.URL
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function descriptionFor(event) {
  const details = [
    event.DESCRIPTION,
    event.LOCATION ? `Lugar: ${event.LOCATION}` : "",
    event.URL ? `Enlace: ${event.URL}` : ""
  ].filter(Boolean).join("\n").slice(0, 1500);

  return [
    details,
    "Fuente: Campus Virtual · Blackboard",
    markerFor(event.UID),
    `Campus Checksum: ${checksumFor(event)}`
  ].filter(Boolean).join("\n");
}

function propertiesFor(event, subject, isNew = false) {
  const start = parseIcsDate(event.DTSTART);
  const end = parseIcsDate(event.DTEND);
  return {
    "Título": title(event.SUMMARY),
    "Asignatura": { relation: [{ id: subjectPages[subject] }] },
    "Tipo": { select: { name: typeFor(event.SUMMARY) } },
    "Fecha": { date: { start, ...(end ? { end } : {}) } },
    "Prioridad": { select: { name: /examen|parcial/i.test(event.SUMMARY) ? "Alta" : "Media" } },
    "Descripción": text(descriptionFor(event)),
    ...(isNew
      ? {
          "Estado": { status: { name: "Sin empezar" } },
          "Completada": { checkbox: false }
        }
      : {})
  };
}

function isRelevant(event, today = new Date()) {
  const start = parseIcsDate(event.DTSTART);
  if (!start) return false;
  const date = new Date(start.length === 10 ? `${start}T12:00:00Z` : start);
  if (Number.isNaN(date.getTime())) return false;
  const earliest = new Date(today);
  earliest.setUTCDate(earliest.getUTCDate() - 30);
  const latest = new Date(today);
  latest.setUTCDate(latest.getUTCDate() + 400);
  return date >= earliest && date <= latest;
}

export async function syncCampus() {
  const calendarUrl = process.env.BLACKBOARD_ICS_URL;
  const tasksId = process.env.NOTION_TASKS_DATA_SOURCE_ID;
  if (!calendarUrl || !tasksId || !process.env.NOTION_TOKEN) {
    throw new Error("Faltan las variables privadas de Campus Virtual o Notion.");
  }

  const calendarResponse = await fetch(calendarUrl, {
    headers: { "User-Agent": "Ecosistema-Paolo-Campus-Sync/1.0" }
  });
  if (!calendarResponse.ok) {
    throw new Error(`Blackboard no respondió correctamente (${calendarResponse.status}).`);
  }
  const calendarText = await calendarResponse.text();
  if (!calendarText.includes("BEGIN:VCALENDAR")) {
    throw new Error("Blackboard no devolvió un calendario válido.");
  }

  const existingPages = await queryAll(tasksId);
  const campusPages = new Map();
  for (const page of existingPages) {
    const description = plainText(page.properties?.["Descripción"]);
    const uid = description.match(/(?:^|\n)Campus UID: (.+?)(?:\n|$)/)?.[1];
    const checksum = description.match(/(?:^|\n)Campus Checksum: (.+?)(?:\n|$)/)?.[1];
    if (uid) campusPages.set(uid, { page, checksum });
  }

  const events = parseCalendar(calendarText).filter(event => isRelevant(event));
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const event of events) {
    const subject = subjectFor(event);
    if (!subject) {
      skipped += 1;
      continue;
    }
    const existing = campusPages.get(event.UID);
    if (existing) {
      if (existing.checksum === checksumFor(event)) {
        skipped += 1;
      } else {
        await notion(`/pages/${existing.page.id}`, "PATCH", {
          properties: propertiesFor(event, subject)
        });
        updated += 1;
      }
    } else {
      await notion("/pages", "POST", {
        parent: { type: "data_source_id", data_source_id: tasksId },
        properties: propertiesFor(event, subject, true)
      });
      created += 1;
    }
  }

  return { scanned: events.length, created, updated, skipped };
}

export default async () => {
  try {
    const result = await syncCampus();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error("Campus sync failed:", error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
};

// Se ejecuta diariamente a las 05:30 UTC (07:30 en Sevilla durante el horario de verano).
export const config = { schedule: "30 5 * * *" };
