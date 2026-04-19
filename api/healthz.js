// GET /api/healthz — diagnóstico rápido: qué env vars están configuradas.
// Protegido con token (header X-Healthz-Token o query ?t=...). Nunca imprime
// valores, solo presencia. Útil para verificar setup sin exponer secretos.

import { timingSafeEqual as cryptoTSE } from "node:crypto";
import { json } from "./_lib.js";

const CHECK_KEYS = [
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "GOOGLE_SERVICE_ACCOUNT_KEY",
  "SHEET_ID",
  "EMAIL_DENY",
  "EMAIL_PATO",
  "EMAIL_CONI",
];

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Rellenar al máximo de ambos para evitar que la diferencia de longitud
  // se note en el timing; al final se exige mismo largo vía AND lógico.
  const maxLen = Math.max(ba.length, bb.length, 1);
  const pa = Buffer.concat([ba, Buffer.alloc(maxLen - ba.length)], maxLen);
  const pb = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)], maxLen);
  const equalBuf = cryptoTSE(pa, pb);
  return equalBuf && ba.length === bb.length;
}

export default function handler(req, res) {
  const expected = (process.env.HEALTHZ_TOKEN || "").trim();
  if (!expected) {
    return json(res, 503, { ok: false, error: "healthz_disabled" });
  }
  const headerToken = (req.headers["x-healthz-token"] || "").toString().trim();
  const urlToken = (() => {
    try {
      const u = new URL(req.url, "http://x");
      return (u.searchParams.get("t") || "").trim();
    } catch { return ""; }
  })();
  const provided = headerToken || urlToken;
  if (!provided || !timingSafeEqual(provided, expected)) {
    return json(res, 404, { ok: false, error: "not_found" });
  }

  const status = {};
  let ready = true;
  for (const k of CHECK_KEYS) {
    const v = process.env[k];
    const present = Boolean(v && String(v).trim());
    status[k] = present;
    if (!present && ["GMAIL_USER", "GMAIL_APP_PASSWORD", "GOOGLE_SERVICE_ACCOUNT_KEY", "SHEET_ID"].includes(k)) {
      ready = false;
    }
  }
  return json(res, 200, {
    ok: ready,
    ready,
    env: status,
    time: new Date().toISOString(),
  });
}
