// Proxy serverless para leer pestañas del Google Sheet.
// Usa Sheets API con Service Account (igual que las escrituras en _lib.js) en
// vez de /export?format=csv — el endpoint público se sirve desde una CDN que
// cachea por minutos/horas y provocaba que filas nuevas no aparecieran en la
// web (ver caso 2026-04-20, filas 592+ de Numeros invisibles).
// Devuelve CSV para no tocar el parser del frontend (_parseCsv en app.js).

import { GoogleAuth } from "google-auth-library";

// gid → nombre EXACTO de la pestaña en el Sheet.
const ALLOWED_SHEETS = {
  "1574989954": "Numeros",
};

let _authClient = null;
async function getAccessToken() {
  if (!_authClient) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    let creds;
    try { creds = JSON.parse(raw); }
    catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY no es JSON válido"); }
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    _authClient = await auth.getClient();
  }
  const t = await _authClient.getAccessToken();
  return typeof t === "string" ? t : (t && t.token) || null;
}

function toCsv(rows) {
  if (!Array.isArray(rows)) return "";
  return rows.map((r) => (r || []).map(csvCell).join(",")).join("\n");
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export default async function handler(req, res) {
  const SHEET_ID = (process.env.SHEET_ID || "").trim();
  if (!SHEET_ID) {
    res.status(500).json({ error: "sheet_no_configurado" });
    return;
  }
  const gid = String(req.query.gid || "").trim();

  if (!gid || !/^\d+$/.test(gid)) {
    res.status(400).json({ error: "gid requerido" });
    return;
  }
  const sheetName = ALLOWED_SHEETS[gid];
  if (!sheetName) {
    res.status(403).json({ error: "gid no permitido" });
    return;
  }

  try {
    const token = await getAccessToken();
    if (!token) throw new Error("no_access_token");
    const range = encodeURIComponent(sheetName);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING&majorDimension=ROWS`;
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      res.status(upstream.status).json({ error: `upstream ${upstream.status}`, detail: txt.slice(0, 200) });
      return;
    }
    const data = await upstream.json();
    const csv = toCsv(data.values || []);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
