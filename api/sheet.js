// Proxy serverless para leer pestañas del Google Sheet como CSV.
// Evita el problema de CORS al llamar a docs.google.com/export desde el navegador
// Y evita la inferencia de tipos de gviz (que descarta texto en columnas numéricas).

const SHEET_ID = "1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E";
const ALLOWED_GIDS = new Set(["1574989954"]); // Numeros (agregar más si corresponde)

export default async function handler(req, res) {
  const gid = String(req.query.gid || "").trim();

  if (!gid || !/^\d+$/.test(gid)) {
    res.status(400).json({ error: "gid requerido" });
    return;
  }
  if (!ALLOWED_GIDS.has(gid)) {
    res.status(403).json({ error: "gid no permitido" });
    return;
  }

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

  try {
    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
      return;
    }
    const text = await upstream.text();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
