// GET /api/fotos — lista archivos en la carpeta Drive DRIVE_FOLDER_FOTOS.
// Usa el service account (scope drive.readonly). Extrae el número de
// talonario del nombre del archivo (regex \d+). Devuelve { ok, fotos }.
// Cada foto apunta a /api/foto?id=FILE_ID (proxy que streamea el contenido).

import { getDriveAccessToken, json } from "./_lib.js";

const ALLOWED_MIME_PREFIX = "image/";

function extractTalonarioFromName(name) {
  if (!name) return "";
  const cleaned = String(name).replace(/\.[a-z0-9]+$/i, "");
  const m = cleaned.match(/(\d{1,4})/);
  return m ? m[1] : "";
}

function naturalCmp(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export default async function handler(req, res) {
  const folderId = (process.env.DRIVE_FOLDER_FOTOS || "").trim();
  if (!folderId) {
    return json(res, 500, { ok: false, error: "drive_folder_no_configurado" });
  }

  let token;
  try {
    token = await getDriveAccessToken();
  } catch (e) {
    return json(res, 500, { ok: false, error: "auth_error", detail: String(e && e.message || e) });
  }
  if (!token) return json(res, 500, { ok: false, error: "no_token" });

  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and mimeType contains 'image/'`);
  const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime,size)");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=modifiedTime%20desc&pageSize=200`;

  try {
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      return json(res, upstream.status, { ok: false, error: "drive_list_failed", status: upstream.status, detail: txt.slice(0, 300) });
    }
    const data = await upstream.json();
    const files = Array.isArray(data.files) ? data.files : [];

    const fotos = files
      .filter((f) => f && f.id && typeof f.mimeType === "string" && f.mimeType.startsWith(ALLOWED_MIME_PREFIX))
      .map((f) => ({
        id: f.id,
        name: f.name || "",
        talonario: extractTalonarioFromName(f.name),
        fecha: f.modifiedTime || "",
        url: `/api/foto?id=${encodeURIComponent(f.id)}`,
      }))
      .sort((a, b) => naturalCmp(a.talonario, b.talonario));

    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, must-revalidate");
    return json(res, 200, { ok: true, count: fotos.length, fotos });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}
