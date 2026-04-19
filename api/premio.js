// POST /api/premio — recibe donaciones de premio desde la web y las registra
// en el Sheet + envía alerta por correo al equipo (Deny + Pato + Coni).

import {
  checkEnv, clean, isEmail, escHtml, internalRecipients,
  appendRow, sendEmail, readJson, json, rateLimit,
} from "./_lib.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const SHEET_NAME = "PremiosDonaciones";
const HEADERS = ["fecha", "nombre", "correo", "telefono", "descripcion", "ua", "mail"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }
  const rl = rateLimit(req, "premio");
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return json(res, 429, { ok: false, error: "rate_limited", retryAfter: rl.retryAfter });
  }
  const env = checkEnv();
  if (!env.ok) {
    return json(res, 500, { ok: false, error: "missing_env" });
  }

  const body = await readJson(req);
  if (!body || typeof body !== "object") {
    return json(res, 400, { ok: false, error: "bad_json" });
  }

  const nombre      = clean(body.nombre, 80);
  const correo      = clean(body.correo, 120);
  const telefono    = clean(body.telefono, 30);
  const descripcion = clean(body.descripcion, 400);
  const ua          = clean(body.ua, 200) || clean(req.headers["user-agent"], 200);
  const ts          = new Date();

  if (!nombre || !correo || !telefono || !descripcion) {
    return json(res, 400, { ok: false, error: "missing_fields" });
  }
  if (!isEmail(correo)) {
    return json(res, 400, { ok: false, error: "bad_email" });
  }
  const telDigits = telefono.replace(/\D/g, "");
  if (telDigits.length < 7 || telDigits.length > 15) {
    return json(res, 400, { ok: false, error: "bad_phone" });
  }
  if (descripcion.length < 5) {
    return json(res, 400, { ok: false, error: "short_description" });
  }

  let mailStatus = "sin_notificar";
  try {
    await sendPremioAlert({ nombre, correo, telefono, descripcion });
    mailStatus = "ok";
  } catch (e) {
    mailStatus = "error: " + String(e?.message || e).slice(0, 120);
  }

  try {
    await appendRow({
      sheetName: SHEET_NAME,
      headers: HEADERS,
      row: [ts.toISOString(), nombre, correo, telefono, descripcion, ua, mailStatus],
    });
  } catch (e) {
    console.error("[SHEET_FAIL] premio sin registrar", { nombre, correo, telefono, mailStatus, err: String(e?.message || e).slice(0, 200) });
    return json(res, 500, { ok: false, error: "sheet_error", detail: String(e?.message || e).slice(0, 200), mail: mailStatus });
  }

  return json(res, 200, { ok: true, mail: mailStatus });
}

async function sendPremioAlert({ nombre, correo, telefono, descripcion }) {
  const tos = internalRecipients();
  if (!tos.length) throw new Error("sin_destinatarios_internos");
  const telDigits = (telefono || "").replace(/[^+\d]/g, "");
  const subject = "Nueva donación de premio — " + nombre;

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.55;">' +
      '<h2 style="color:#7c3aed;margin:0 0 8px;">Nueva propuesta de premio</h2>' +
      '<p style="margin:0 0 10px;">Alguien quiere aportar un premio para la rifa de Paola.</p>' +
      '<table style="border-collapse:collapse;margin:10px 0 14px;font-size:14px;">' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Nombre:</td><td style="padding:4px 0;"><strong>' + escHtml(nombre) + '</strong></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Correo:</td><td style="padding:4px 0;"><a href="mailto:' + escHtml(correo) + '" style="color:#7c3aed;">' + escHtml(correo) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Teléfono:</td><td style="padding:4px 0;"><a href="tel:' + escHtml(telDigits) + '" style="color:#7c3aed;">' + escHtml(telefono) + '</a></td></tr>' +
      '</table>' +
      '<div style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:12px 14px;margin:10px 0 16px;">' +
        '<strong>Lo que quiere donar:</strong><br>' + escHtml(descripcion).replace(/\n/g, "<br>") +
      '</div>' +
      '<p style="font-size:13px;color:#64748b;">Contactalo para coordinar la entrega y sumarlo al listado de premios.</p>' +
    '</div>';

  const text =
    "Nueva donación de premio — Rifa Paola Soto\n\n" +
    "Nombre: "   + nombre   + "\n" +
    "Correo: "   + correo   + "\n" +
    "Teléfono: " + telefono + "\n\n" +
    "Lo que quiere donar:\n" + descripcion + "\n\n" +
    "Contactalo para coordinar la entrega y sumarlo al listado de premios.";

  await sendEmail({
    to: tos,
    subject, html, text,
    replyTo: correo,
  });
}
