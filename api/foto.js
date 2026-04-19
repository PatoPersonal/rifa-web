// GET /api/foto?id=FILE_ID — streamea una imagen de Drive.
// Valida que FILE_ID esté dentro de DRIVE_FOLDER_FOTOS antes de servir, para
// evitar que se exfiltren otros archivos a los que el service account pudiera
// tener acceso.

import { getDriveAccessToken } from "./_lib.js";

const ALLOWED_MIME_PREFIX = "image/";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB por imagen

function errJson(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const id = String(req.query?.id || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{10,120}$/.test(id)) {
    return errJson(res, 400, { ok: false, error: "id_invalido" });
  }

  const folderId = (process.env.DRIVE_FOLDER_FOTOS || "").trim();
  if (!folderId) {
    return errJson(res, 500, { ok: false, error: "drive_folder_no_configurado" });
  }

  let token;
  try {
    token = await getDriveAccessToken();
  } catch (e) {
    return errJson(res, 500, { ok: false, error: "auth_error" });
  }
  if (!token) return errJson(res, 500, { ok: false, error: "no_token" });

  // 1) Metadata: validar que el archivo vive en la carpeta permitida
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,parents`;
  let meta;
  try {
    const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (metaRes.status === 404) return errJson(res, 404, { ok: false, error: "no_encontrado" });
    if (!metaRes.ok) return errJson(res, metaRes.status, { ok: false, error: "meta_failed" });
    meta = await metaRes.json();
  } catch (e) {
    return errJson(res, 500, { ok: false, error: "meta_error" });
  }

  const parents = Array.isArray(meta?.parents) ? meta.parents : [];
  if (!parents.includes(folderId)) {
    return errJson(res, 403, { ok: false, error: "fuera_de_carpeta" });
  }

  const mimeType = String(meta.mimeType || "");
  if (!mimeType.startsWith(ALLOWED_MIME_PREFIX)) {
    return errJson(res, 415, { ok: false, error: "tipo_no_permitido" });
  }

  const size = parseInt(meta.size || "0", 10);
  if (size && size > MAX_BYTES) {
    return errJson(res, 413, { ok: false, error: "archivo_muy_grande" });
  }

  // 2) Descargar binario
  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
  try {
    const mediaRes = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!mediaRes.ok) {
      return errJson(res, mediaRes.status, { ok: false, error: "media_failed" });
    }
    const buf = Buffer.from(await mediaRes.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return errJson(res, 413, { ok: false, error: "archivo_muy_grande" });
    }

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", buf.length);
    // 1 hora en browser + CDN; si cambia el archivo en Drive el nuevo mtime genera nueva vista via /api/fotos
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(buf);
  } catch (e) {
    return errJson(res, 500, { ok: false, error: "media_error" });
  }
}
