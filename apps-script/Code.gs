/**
 * Registro de descargas + envío automático de talonarios — Rifa Paola Soto.
 *
 * Qué hace:
 *   Recibe un POST desde la web (rifa-paolasoto.vercel.app) cuando alguien
 *   descarga un talonario en PDF y:
 *     1) Agrega una fila a la pestaña "Descargas" del Sheet.
 *     2) Envía el PDF por correo al participante con copia a Deny,
 *        Pato y Coni.
 *
 * Cómo instalar / actualizar:
 *   1. Abrir el Google Sheet:
 *      https://docs.google.com/spreadsheets/d/1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E/edit
 *   2. Crear una pestaña llamada EXACTAMENTE "Descargas" (si aún no existe).
 *   3. Extensiones → Apps Script.
 *   4. Reemplazar el contenido de Code.gs por este archivo.
 *   5. Revisar los VALORES CONFIGURABLES más abajo (SECRET + correos de Pato y
 *      Coni). El correo de Coni debe llenarse antes de re-desplegar.
 *   6. Deploy → Manage deployments → (el deployment existente) → editar →
 *      Version: "New version" → Deploy. Autorizar los permisos nuevos
 *      (Gmail/Drive) cuando lo pida.
 *   7. La URL /exec NO cambia; no hace falta tocar app.js salvo que sea la
 *      primera vez que se publica (ahí sí hay que pegarla en CONFIG.registryUrl).
 *
 * Cuotas de correo (informativo):
 *   - Cuenta Gmail gratuita: 100 destinatarios/día (por envío cuentan el To + CC).
 *     Cada descarga manda el mail a 4 direcciones, o sea ~25 descargas/día.
 *   - Si se pasa el límite, el script sigue registrando la descarga en la Sheet
 *     pero el mail falla. Las descargas quedan igual con registro local en el
 *     navegador del usuario.
 *
 * Seguridad:
 *   - SECRET filtra POSTs de gente random que adivine la URL /exec.
 *   - El PDF viaja en base64 dentro del body — no es sensible, pero usamos
 *     HTTPS igual.
 */

// ============================================================
// VALORES CONFIGURABLES
// ============================================================

// Debe coincidir con CONFIG.registrySecret en app.js
// (Nota: no es una medida de seguridad real — sólo filtra bots random.)
var SECRET = "rifa-paola-descargas-2026";

// Correo público de contacto de la rifa (visible en CC del correo al participante).
var EMAIL_DENY = "Denisse.psoto89@gmail.com";

// Correos privados internos que reciben alertas de cada descarga (BCC + alerta estructurada).
// ⚠️  NO se hardcodean acá porque este archivo está en un repo público.
//     Se guardan en Project Properties del Apps Script. Corré la función
//     `setupEmailPrivados()` UNA SOLA VEZ desde el editor de Apps Script
//     después de pegar tus correos privados reales dentro de esa función.
function _getEmailPato() {
  return PropertiesService.getScriptProperties().getProperty("EMAIL_PATO") || "";
}
function _getEmailConi() {
  return PropertiesService.getScriptProperties().getProperty("EMAIL_CONI") || "";
}

/**
 * Setup único: pega acá tus correos privados, ejecuta la función UNA VEZ
 * desde el editor (botón ▶ Ejecutar), autoriza los permisos, y listo.
 * Después podés borrar los correos de esta función (ya quedan guardados).
 */
function setupEmailPrivados() {
  PropertiesService.getScriptProperties().setProperties({
    EMAIL_PATO: "COMPLETAR_CORREO_PATO@example.com",
    EMAIL_CONI: "COMPLETAR_CORREO_CONI@example.com",
  });
  Logger.log("Correos privados guardados en Script Properties ✓");
}

// Nombre que aparece como remitente en el correo
var REMITENTE_NOMBRE = "Rifa Paola Soto";

// ============================================================
// INTERNOS — no editar salvo que sepas lo que haces
// ============================================================

var SHEET_NAME = "Descargas";
var HEADERS = ["fecha", "nombre", "correo", "telefono", "cantidad", "codigos", "desde", "hasta", "ua", "mail"];

var PREMIOS_SHEET = "PremiosDonaciones";
var PREMIOS_HEADERS = ["fecha", "nombre", "correo", "telefono", "descripcion", "ua", "mail"];

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || "{}";
    var data;
    try { data = JSON.parse(raw); } catch (_) { return _json({ ok: false, error: "bad_json" }); }

    if (!data || data.secret !== SECRET) {
      return _json({ ok: false, error: "unauthorized" });
    }

    if (data.type === "premio") {
      return _handlePremio(data);
    }
    return _handleDescarga(data);
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _handleDescarga(data) {
  var nombre   = _clean(data.nombre, 80);
  var correo   = _clean(data.correo, 120);
  var telefono = _clean(data.telefono, 30);
  var cantidad = Math.max(1, Math.min(100, Number(data.cantidad) || 1));
  var codigos  = _clean(data.codigos, 200);
  var desde    = _clean(data.talonarioDesde, 30);
  var hasta    = _clean(data.talonarioHasta, 30);
  var ua       = _clean(data.ua, 200);
  var ts       = data.timestamp ? new Date(data.timestamp) : new Date();

  if (!nombre || !correo || !telefono) {
    return _json({ ok: false, error: "missing_fields" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return _json({ ok: false, error: "bad_email" });
  }

  var mailStatus = "sin_pdf";
  if (data.pdfBase64) {
    try {
      mailStatus = _sendTalonarioEmail({
        correo: correo,
        nombre: nombre,
        cantidad: cantidad,
        desde: desde,
        hasta: hasta,
        pdfBase64: String(data.pdfBase64),
        filename: _clean(data.filename, 120) || ("Talonario_Rifa_Paola_" + nombre.replace(/\s+/g, "_") + ".pdf"),
      });
    } catch (mailErr) {
      mailStatus = "error: " + String(mailErr).slice(0, 120);
    }
  }

  var sheet = _getOrCreateSheet();
  sheet.appendRow([ts, nombre, correo, telefono, cantidad, codigos, desde, hasta, ua, mailStatus]);

  return _json({ ok: true, mail: mailStatus });
}

function _handlePremio(data) {
  var nombre      = _clean(data.nombre, 80);
  var correo      = _clean(data.correo, 120);
  var telefono    = _clean(data.telefono, 30);
  var descripcion = _clean(data.descripcion, 400);
  var ua          = _clean(data.ua, 200);
  var ts          = data.timestamp ? new Date(data.timestamp) : new Date();

  if (!nombre || !correo || !telefono || !descripcion) {
    return _json({ ok: false, error: "missing_fields" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return _json({ ok: false, error: "bad_email" });
  }
  if (descripcion.length < 5) {
    return _json({ ok: false, error: "short_description" });
  }

  var mailStatus = "sin_notificar";
  try {
    mailStatus = _sendPremioNotification({
      nombre: nombre,
      correo: correo,
      telefono: telefono,
      descripcion: descripcion,
    });
  } catch (mailErr) {
    mailStatus = "error: " + String(mailErr).slice(0, 120);
  }

  var sheet = _getOrCreatePremiosSheet();
  sheet.appendRow([ts, nombre, correo, telefono, descripcion, ua, mailStatus]);

  return _json({ ok: true, mail: mailStatus });
}

function _getOrCreatePremiosSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PREMIOS_SHEET);
  if (!sheet) sheet = ss.insertSheet(PREMIOS_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(PREMIOS_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _sendPremioNotification(p) {
  var tos = [EMAIL_DENY, _getEmailPato(), _getEmailConi()].filter(function (x) { return x && x.trim(); });
  if (!tos.length) throw new Error("sin_destinatarios_internos");
  var telDigits = p.telefono.replace(/[^+\d]/g, "");

  var subject = "Nueva donación de premio — " + p.nombre;

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.55;">' +
      '<h2 style="color:#7c3aed;margin:0 0 8px;">🎁 Nueva propuesta de premio</h2>' +
      '<p style="margin:0 0 10px;">Alguien quiere aportar un premio para la rifa de Paola.</p>' +
      '<table style="border-collapse:collapse;margin:10px 0 14px;font-size:14px;">' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Nombre:</td><td style="padding:4px 0;"><strong>' + _escHtml(p.nombre) + '</strong></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Correo:</td><td style="padding:4px 0;"><a href="mailto:' + _escHtml(p.correo) + '" style="color:#7c3aed;">' + _escHtml(p.correo) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Teléfono:</td><td style="padding:4px 0;"><a href="tel:' + _escHtml(telDigits) + '" style="color:#7c3aed;">' + _escHtml(p.telefono) + '</a></td></tr>' +
      '</table>' +
      '<div style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:12px 14px;margin:10px 0 16px;">' +
        '<strong>Lo que quiere donar:</strong><br>' + _escHtml(p.descripcion).replace(/\n/g, "<br>") +
      '</div>' +
      '<p style="font-size:13px;color:#64748b;">Contactalo para coordinar la entrega y sumarlo al listado de premios.</p>' +
    '</div>';

  var plain =
    "Nueva donación de premio — Rifa Paola Soto\n\n" +
    "Nombre: "   + p.nombre   + "\n" +
    "Correo: "   + p.correo   + "\n" +
    "Teléfono: " + p.telefono + "\n\n" +
    "Lo que quiere donar:\n" + p.descripcion + "\n\n" +
    "Contactalo para coordinar la entrega y sumarlo al listado de premios.";

  MailApp.sendEmail(tos.join(","), subject, plain, {
    htmlBody: html,
    name: REMITENTE_NOMBRE,
    replyTo: p.correo,
  });
  return "ok (to: " + tos.join(",") + ")";
}

// Test desde el navegador — útil para verificar que el deploy funciona.
function doGet(e) {
  return _json({ ok: true, service: "rifa-descargas", time: new Date().toISOString() });
}

function _sendTalonarioEmail(p) {
  var pdfBytes = Utilities.base64Decode(p.pdfBase64);
  var pdfBlob = Utilities.newBlob(pdfBytes, "application/pdf", p.filename);

  var rangoTxt = (p.desde && p.hasta && p.desde !== p.hasta)
    ? ("Talonario(s) N° " + p.desde + " al " + p.hasta)
    : (p.desde ? ("Talonario N° " + p.desde) : "");

  var correoLower = (p.correo || "").toLowerCase();

  // Deny va en CC (público: el participante ve a quién reportar).
  var cc = (EMAIL_DENY && EMAIL_DENY.toLowerCase() !== correoLower) ? EMAIL_DENY : "";

  // Pato y Coni en BCC (privado: reciben la info pero no son visibles al participante).
  var bccList = [_getEmailPato(), _getEmailConi()]
    .filter(function (x) { return x && x.trim(); })
    .filter(function (x) { return x.toLowerCase() !== correoLower; });

  var subject = "Tu talonario — Rifa Paola Soto";

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.55;">' +
      '<h2 style="color:#7c3aed;margin:0 0 8px;">¡Gracias por apoyar a Paola! 💜</h2>' +
      '<p>Hola <strong>' + _escHtml(p.nombre) + '</strong>,</p>' +
      '<p>Adjunto va tu talonario en PDF para que puedas imprimirlo y empezar a vender. ' +
      (rangoTxt ? ('<br><strong>' + _escHtml(rangoTxt) + '</strong> — ' + (p.cantidad * 15) + ' números en total.') : '') +
      '</p>' +
      '<p style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:10px 14px;margin:14px 0;">' +
        'Cuando termines de vender, envía una <strong>foto del talonario físico</strong> y el ' +
        '<strong>comprobante de transferencia</strong> a Deny: ' +
        '<a href="mailto:' + EMAIL_DENY + '" style="color:#7c3aed;">' + EMAIL_DENY + '</a>.' +
      '</p>' +
      '<p style="font-size:13px;color:#64748b;">' +
        'Datos para transferir: BancoEstado — CuentaRUT — 14.279.967-7 — Paola Soto — Denisse.psoto89@gmail.com' +
      '</p>' +
      '<p style="font-size:13px;color:#64748b;">' +
        'Cada comprador puede verificar su pago en la web: ' +
        '<a href="https://rifa-paolasoto.vercel.app/" style="color:#7c3aed;">rifa-paolasoto.vercel.app</a>' +
      '</p>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:20px;">Este correo fue generado automáticamente desde la web de la rifa.</p>' +
    '</div>';

  var plain =
    "Hola " + p.nombre + ",\n\n" +
    "Adjunto va tu talonario en PDF.\n" +
    (rangoTxt ? (rangoTxt + " — " + (p.cantidad * 15) + " números en total.\n\n") : "\n") +
    "Cuando termines de vender, envía una FOTO del talonario físico y el comprobante de transferencia a Deny: " + EMAIL_DENY + ".\n\n" +
    "Datos para transferir:\n" +
    "  BancoEstado — CuentaRUT\n" +
    "  RUT: 14.279.967-7\n" +
    "  Nombre: Paola Soto\n" +
    "  Email: Denisse.psoto89@gmail.com\n\n" +
    "Cada comprador puede verificar su pago en https://rifa-paolasoto.vercel.app/\n\n" +
    "¡Gracias por apoyar a Paola!";

  var opts = {
    htmlBody: html,
    name: REMITENTE_NOMBRE,
    attachments: [pdfBlob],
    replyTo: EMAIL_DENY,
  };
  if (cc) opts.cc = cc;
  if (bccList.length) opts.bcc = bccList.join(",");

  MailApp.sendEmail(p.correo, subject, plain, opts);

  // Además, enviar alerta interna estructurada a Pato y Coni (sin PDF, sin BCC al participante).
  // Esto asegura que tengan siempre un registro claro aunque el correo principal quede en spam.
  try {
    _sendAlertaInterna(p, rangoTxt);
  } catch (alertErr) {
    // No bloquea el flujo si la alerta falla
  }

  return "ok (cc: " + (cc || "—") + ", bcc: " + (bccList.join(",") || "—") + ")";
}

// Alerta interna privada: Pato + Coni reciben un resumen estructurado de la descarga.
// Separada del correo al participante para que no se pierda entre otros mensajes.
function _sendAlertaInterna(p, rangoTxt) {
  var tos = [_getEmailPato(), _getEmailConi()].filter(function (x) { return x && x.trim(); });
  if (!tos.length) return;

  var telDigits = (p.telefono || "").replace(/[^+\d]/g, "");
  var subject = "📥 Nueva descarga — " + p.nombre + " (" + p.cantidad + " talonario" + (p.cantidad === 1 ? "" : "s") + ")";

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.55;">' +
      '<h2 style="color:#7c3aed;margin:0 0 8px;">📥 Nueva descarga de talonario</h2>' +
      '<p style="margin:0 0 12px;color:#64748b;font-size:13px;">Alguien descargó un talonario desde la web.</p>' +
      '<table style="border-collapse:collapse;margin:8px 0 14px;font-size:14px;">' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Nombre:</td><td style="padding:4px 0;"><strong>' + _escHtml(p.nombre) + '</strong></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Correo:</td><td style="padding:4px 0;"><a href="mailto:' + _escHtml(p.correo) + '" style="color:#7c3aed;">' + _escHtml(p.correo) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Teléfono:</td><td style="padding:4px 0;"><a href="tel:' + _escHtml(telDigits) + '" style="color:#7c3aed;">' + _escHtml(p.telefono) + '</a></td></tr>' +
        '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Cantidad:</td><td style="padding:4px 0;"><strong>' + p.cantidad + '</strong> talonario' + (p.cantidad === 1 ? "" : "s") + ' (' + (p.cantidad * 15) + ' números)</td></tr>' +
        (rangoTxt ? '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Rango:</td><td style="padding:4px 0;">' + _escHtml(rangoTxt) + '</td></tr>' : '') +
        (p.codigos ? '<tr><td style="padding:4px 10px 4px 0;color:#64748b;">Códigos:</td><td style="padding:4px 0;font-family:monospace;">' + _escHtml(p.codigos) + '</td></tr>' : '') +
      '</table>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:16px;">El participante recibió el PDF por correo con Deny en CC. Este aviso es privado para registro interno.</p>' +
    '</div>';

  var plain =
    "📥 Nueva descarga de talonario\n\n" +
    "Nombre: "   + p.nombre   + "\n" +
    "Correo: "   + p.correo   + "\n" +
    "Teléfono: " + p.telefono + "\n" +
    "Cantidad: " + p.cantidad + " talonario(s) (" + (p.cantidad * 15) + " números)\n" +
    (rangoTxt ? ("Rango: " + rangoTxt + "\n") : "") +
    (p.codigos ? ("Códigos: " + p.codigos + "\n") : "") +
    "\nEl participante ya recibió el PDF por correo con Deny en CC.";

  MailApp.sendEmail(tos.join(","), subject, plain, {
    htmlBody: html,
    name: REMITENTE_NOMBRE,
    replyTo: p.correo,
  });
}

function _getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _clean(s, max) {
  if (s == null) return "";
  s = String(s).replace(/[\x00-\x1f\x7f]/g, "").trim();
  return s.length > max ? s.substring(0, max) : s;
}

function _escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
