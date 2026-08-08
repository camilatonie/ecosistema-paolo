# Ecosistema Paolo · Netlify + Notion

La web se publica desde `public/` y usa la función privada `netlify/functions/notion.mjs` para guardar tareas, calificaciones y registros de recursos en Notion.

## Variables necesarias en Netlify

- `NOTION_TOKEN`
- `ADMIN_PASSWORD`
- `NOTION_TASKS_DATA_SOURCE_ID`
- `NOTION_GRADES_DATA_SOURCE_ID`
- `NOTION_RESOURCES_DATA_SOURCE_ID`
- `NOTION_SUBJECTS_DATA_SOURCE_ID`

`ADMIN_PASSWORD` protege las operaciones de escritura. Nunca se guarda en el repositorio ni aparece en el HTML.

## Límites actuales

Los archivos siguen almacenándose en el navegador para poder abrirlos y descargarlos desde la web. Su nombre y metadatos se registran en Notion. Una fase posterior puede subir los binarios a Notion o a almacenamiento dedicado.
