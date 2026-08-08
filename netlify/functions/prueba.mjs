export default async () => {
  return new Response(
    JSON.stringify({ ok: true, mensaje: "Funciones activas" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
};
