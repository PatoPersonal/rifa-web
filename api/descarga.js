// POST /api/descarga — reemplazo del doPost de Apps Script.
// Envía el PDF del talonario por correo (Resend) y registra la descarga en el
// Google Sheet (Sheets API con service account).

import {
  checkEnv, clean, isEmail, escHtml, internalRecipients,
  appendRow, sendEmail, readJson, json, rateLimit,
} from "./_lib.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const SHEET_NAME = "Descargas";
const HEADERS = ["fecha", "nombre", "correo", "telefono", "cantidad", "codigos", "desde", "hasta", "ua", "mail"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method_not_allowed" });
  }
  const rl = rateLimit(req, "descarga");
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

  const nombre   = clean(body.nombre, 80);
  const correo   = clean(body.correo, 120);
  const telefono = clean(body.telefono, 30);
  const cantidad = Math.max(1, Math.min(100, Number(body.cantidad) || 1));
  const codigos  = clean(body.codigos, 200);
  const desde    = clean(body.talonarioDesde, 30);
  const hasta    = clean(body.talonarioHasta, 30);
  const ua       = clean(body.ua, 200) || clean(req.headers["user-agent"], 200);
  const ts       = new Date();

  if (!nombre || !correo || !telefono) {
    return json(res, 400, { ok: false, error: "missing_fields" });
  }
  if (!isEmail(correo)) {
    return json(res, 400, { ok: false, error: "bad_email" });
  }
  const telDigits = telefono.replace(/\D/g, "");
  if (telDigits.length < 7 || telDigits.length > 15) {
    return json(res, 400, { ok: false, error: "bad_phone" });
  }

  const pdfBase64 = typeof body.pdfBase64 === "string" ? body.pdfBase64 : "";
  // Un PDF real de talonario pesa ~200-400KB. 1.4MB base64 ≈ 1MB real, holgura suficiente.
  if (pdfBase64.length > 1_400_000) {
    return json(res, 400, { ok: false, error: "pdf_too_large" });
  }
  if (pdfBase64 && !/^[A-Za-z0-9+/]+=*$/.test(pdfBase64)) {
    return json(res, 400, { ok: false, error: "bad_pdf_encoding" });
  }
  const safeName = nombre.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]/g, "_").replace(/\s+/g, "_").slice(0, 40);
  const filename = (clean(body.filename, 120).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, "_").replace(/\.{2,}/g, "_"))
    || ("Talonario_Rifa_Paola_" + safeName + ".pdf");

  const rangoTxt = (desde && hasta && desde !== hasta)
    ? ("Talonario(s) N° " + desde + " al " + hasta)
    : (desde ? ("Talonario N° " + desde) : "");
  const totalNumeros = cantidad * 15;

  let mailStatus = "sin_pdf";
  if (pdfBase64) {
    try {
      await sendParticipantEmail({ correo, nombre, filename, pdfBase64, rangoTxt, totalNumeros });
      try { await sendInternalAlert({ nombre, correo, telefono, cantidad, codigos, rangoTxt, filename, pdfBase64 }); }
      catch (_) { /* alerta no bloquea */ }
      mailStatus = "ok";
    } catch (e) {
      mailStatus = "error: " + String(e?.message || e).slice(0, 120);
    }
  }

  try {
    await appendRow({
      sheetName: SHEET_NAME,
      headers: HEADERS,
      row: [ts.toISOString(), nombre, correo, telefono, cantidad, codigos, desde, hasta, ua, mailStatus],
    });
  } catch (e) {
    // Participante ya recibió el PDF pero no quedó en el Sheet —
    // log explícito para recuperar el registro desde Vercel Logs.
    console.error("[SHEET_FAIL] descarga sin registrar", { correo, nombre, cantidad, desde, hasta, mailStatus, err: String(e?.message || e).slice(0, 200) });
    return json(res, 500, { ok: false, error: "sheet_error", detail: String(e?.message || e).slice(0, 200), mail: mailStatus });
  }

  return json(res, 200, { ok: true, mail: mailStatus });
}

async function sendParticipantEmail({ correo, nombre, filename, pdfBase64, rangoTxt, totalNumeros }) {
  const EMAIL_DENY = (process.env.EMAIL_DENY || "").trim();
  const subject = rangoTxt
    ? ("Tu talonario de la Rifa Paola Soto (" + rangoTxt.replace(/^Talonario(\(s\))? /, "") + ")")
    : "Tu talonario de la Rifa Paola Soto";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.6;">' +
      '<p style="margin:0 0 12px;">Hola ' + escHtml(nombre) + ',</p>' +
      '<p style="margin:0 0 12px;">Adjunto encontrarás tu talonario en PDF, listo para imprimir.' +
      (rangoTxt ? (' Corresponde al <strong>' + escHtml(rangoTxt) + '</strong> (' + totalNumeros + ' números).') : '') + '</p>' +
      (EMAIL_DENY ? ('<p style="margin:0 0 12px;">Cuando termines de vender, envía una foto del talonario físico y el comprobante de transferencia a <a href="mailto:' + escHtml(EMAIL_DENY) + '" style="color:#7c3aed;">' + escHtml(EMAIL_DENY) + '</a>.</p>') : '') +
      '<p style="margin:0 0 6px;"><strong>Datos para transferir</strong></p>' +
      '<p style="margin:0 0 12px;">' +
        'BancoEstado, CuentaRUT<br>' +
        'RUT: 14.279.967-7<br>' +
        'Nombre: Paola Soto' +
        (EMAIL_DENY ? ('<br>Email: ' + escHtml(EMAIL_DENY)) : '') +
      '</p>' +
      '<p style="margin:0 0 12px;">Cada comprador puede verificar su pago en <a href="https://rifa-paolasoto.vercel.app/" style="color:#7c3aed;">rifa-paolasoto.vercel.app</a>.</p>' +
      '<p style="margin:14px 0 0;">Gracias por sumarte.</p>' +
      '<p style="margin:2px 0 0;">Equipo Rifa Paola Soto</p>' +
    '</div>';

  const text =
    "Hola " + nombre + ",\n\n" +
    "Adjunto encontrarás tu talonario en PDF, listo para imprimir." +
    (rangoTxt ? (" Corresponde al " + rangoTxt + " (" + totalNumeros + " números).") : "") + "\n\n" +
    (EMAIL_DENY ? ("Cuando termines de vender, envía una foto del talonario físico y el comprobante de transferencia a " + EMAIL_DENY + ".\n\n") : "") +
    "Datos para transferir\n" +
    "BancoEstado, CuentaRUT\n" +
    "RUT: 14.279.967-7\n" +
    "Nombre: Paola Soto\n" +
    (EMAIL_DENY ? ("Email: " + EMAIL_DENY + "\n\n") : "\n") +
    "Cada comprador puede verificar su pago en https://rifa-paolasoto.vercel.app/\n\n" +
    "Gracias por sumarte.\n" +
    "Equipo Rifa Paola Soto";

  await sendEmail({
    to: correo,
    subject, html, text,
    replyTo: EMAIL_DENY || undefined,
    attachments: [{ filename, contentBase64: pdfBase64 }],
  });
}

async function sendInternalAlert({ nombre, correo, telefono, cantidad, codigos, rangoTxt, filename, pdfBase64 }) {
  const correoLower = (correo || "").toLowerCase();
  const tos = internalRecipients().filter((x) => x.toLowerCase() !== correoLower);
  if (!tos.length) return;
  const telDigits = (telefono || "").replace(/[^+\d]/g, "");
  const subject = "Nueva descarga: " + nombre + " (" + cantidad + " talonario" + (cantidad === 1 ? "" : "s") + ")";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.55;">' +
      '<h2 style="color:#7c3aed;margin:0 0 8px;">Nueva descarga de talonario</h2>' +
      '<p style="margin:0 0 12px;color:#64748b;font-size:13px;">Alguien descargó un talonario desde la web.</p>' +
      '<table style="border-collapse:collapse;margin:8px 0 14px;font-size:14px;">' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Nombre:</td><td style="padding:4px 0;"><strong>' + escHtml(nombre) + '</strong></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Correo:</td><td style="padding:4px 0;"><a href="mailto:' + escHtml(correo) + '" style="color:#7c3aed;">' + escHtml(correo) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Teléfono:</td><td style="padding:4px 0;"><a href="tel:' + escHtml(telDigits) + '" style="color:#7c3aed;">' + escHtml(telefono) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Cantidad:</td><td style="padding:4px 0;"><strong>' + cantidad + '</strong> talonario' + (cantidad === 1 ? "" : "s") + ' (' + (cantidad * 15) + ' números)</td></tr>' +
        (rangoTxt ? '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Rango:</td><td style="padding:4px 0;">' + escHtml(rangoTxt) + '</td></tr>' : '') +
        (codigos ? '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Códigos:</td><td style="padding:4px 0;font-family:monospace;">' + escHtml(codigos) + '</td></tr>' : '') +
      '</table>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:16px;">El PDF del talonario va adjunto a este aviso. El participante también recibió su copia.</p>' +
    '</div>';

  const text =
    "Nueva descarga de talonario\n\n" +
    "Nombre: "   + nombre   + "\n" +
    "Correo: "   + correo   + "\n" +
    "Teléfono: " + telefono + "\n" +
    "Cantidad: " + cantidad + " talonario(s) (" + (cantidad * 15) + " números)\n" +
    (rangoTxt ? ("Rango: " + rangoTxt + "\n") : "") +
    (codigos ? ("Códigos: " + codigos + "\n") : "") +
    "\nEl PDF del talonario va adjunto.";

  await sendEmail({
    to: tos,
    subject, html, text,
    replyTo: correo,
    attachments: pdfBase64 ? [{ filename, contentBase64: pdfBase64 }] : [],
  });
}
