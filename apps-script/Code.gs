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

// Correos internos que reciben alertas de cada descarga (BCC + alerta estructurada).
// Los defaults se usan si no hay override en Script Properties. Para cambiarlos
// sin redeploy, corre `setupEmailPrivados()` con los nuevos valores.
var EMAIL_PATO_DEFAULT = "pato.rojas.86@gmail.com";
var EMAIL_CONI_DEFAULT = "conisaldivia.s@gmail.com";

function _emailOrDefault(prop, fallback) {
  var v = (PropertiesService.getScriptProperties().getProperty(prop) || "").trim();
  // Si está vacío, placeholder o no tiene @ valido, caemos al default.
  if (!v || /COMPLETAR|example\.com|placeholder/i.test(v) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return fallback;
  }
  return v;
}
function _getEmailPato() { return _emailOrDefault("EMAIL_PATO", EMAIL_PATO_DEFAULT); }
function _getEmailConi() { return _emailOrDefault("EMAIL_CONI", EMAIL_CONI_DEFAULT); }

/**
 * Override opcional via Script Properties. Corré la función UNA VEZ desde el
 * editor de Apps Script si queres cambiar los correos internos sin redeploy.
 */
function setupEmailPrivados() {
  PropertiesService.getScriptProperties().setProperties({
    EMAIL_PATO: EMAIL_PATO_DEFAULT,
    EMAIL_CONI: EMAIL_CONI_DEFAULT,
  });
  Logger.log("Correos privados guardados en Script Properties ✓");
}

/**
 * Diagnostico: manda un correo de prueba a Deny, Pato y Coni con los datos
 * actualmente configurados. Util para verificar el deploy antes de que alguien
 * descargue un talonario real. Correr desde el editor → ▶ Ejecutar.
 */
function testEmails() {
  var tos = [EMAIL_DENY, _getEmailPato(), _getEmailConi()]
    .filter(function (x) { return x && x.trim(); });
  if (!tos.length) {
    Logger.log("❌ No hay destinatarios configurados");
    return;
  }
  Logger.log("Enviando prueba a: " + tos.join(", "));
  MailApp.sendEmail(tos.join(","), "✓ Prueba — Rifa Paola Soto (Apps Script)",
    "Este es un correo de prueba del Apps Script de la rifa.\n\n" +
    "Si lo recibiste, los avisos de descarga van a llegarte bien.\n\n" +
    "Destinatarios configurados:\n" +
    "  Deny: " + EMAIL_DENY + "\n" +
    "  Pato: " + _getEmailPato() + "\n" +
    "  Coni: " + _getEmailConi() + "\n\n" +
    "Cuota diaria restante (aprox): " + MailApp.getRemainingDailyQuota() + " envios.",
    { name: REMITENTE_NOMBRE });
  Logger.log("✓ Prueba enviada. Cuota diaria restante: " + MailApp.getRemainingDailyQuota());
}

// Nombre que aparece como remitente en el correo
var REMITENTE_NOMBRE = "Rifa Paola Soto";

// ============================================================
// INTERNOS — no editar salvo que sepas lo que haces
// ============================================================

// ID del Sheet (funciona tanto si el script es bound como standalone)
var SPREADSHEET_ID = "1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E";

function _openSheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

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
  var ss = _openSheet();
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

  // ====================================================================
  // 1) Correo al PARTICIPANTE — SOLO a él, sin CC ni BCC. Mensaje de
  //    agradecimiento + PDF adjunto. Un solo correo, limpio.
  // ====================================================================
  var subject = "¡Gracias por apoyar a Paola! — Tu talonario está listo 💜";

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:560px;line-height:1.6;">' +
      '<h2 style="color:#7c3aed;margin:0 0 12px;">¡Gracias por sumarte, ' + _escHtml(p.nombre) + '! 💜</h2>' +
      '<p style="margin:0 0 12px;">Cada número vendido es un paso más en la recuperación de <strong>Paola</strong>. Tu ayuda significa muchísimo para ella y su familia.</p>' +
      '<p style="margin:0 0 14px;">Adjunto va tu talonario en PDF, listo para imprimir y empezar a vender.' +
      (rangoTxt ? ('<br><strong>' + _escHtml(rangoTxt) + '</strong> — ' + (p.cantidad * 15) + ' números en total.') : '') +
      '</p>' +
      '<div style="background:#f5f3ff;border-left:3px solid #7c3aed;padding:12px 14px;margin:14px 0;">' +
        '<strong>Cuando termines de vender:</strong><br>' +
        'Envíale a Deny una <strong>foto del talonario físico</strong> y el ' +
        '<strong>comprobante de transferencia</strong> a ' +
        '<a href="mailto:' + EMAIL_DENY + '" style="color:#7c3aed;">' + EMAIL_DENY + '</a>.' +
      '</div>' +
      '<p style="font-size:13px;color:#64748b;margin:10px 0;">' +
        '<strong>Datos para transferir:</strong><br>' +
        'BancoEstado — CuentaRUT<br>' +
        'RUT: 14.279.967-7<br>' +
        'Nombre: Paola Soto<br>' +
        'Email: Denisse.psoto89@gmail.com' +
      '</p>' +
      '<p style="font-size:13px;color:#64748b;">' +
        'Cada comprador puede verificar su pago en la web: ' +
        '<a href="https://rifa-paolasoto.vercel.app/" style="color:#7c3aed;">rifa-paolasoto.vercel.app</a>' +
      '</p>' +
      '<p style="margin:18px 0 0;color:#7c3aed;font-weight:bold;">¡Gracias por ser parte de esto! 💜</p>' +
      '<p style="font-size:12px;color:#94a3b8;margin-top:16px;">Este correo fue generado automáticamente desde la web de la rifa.</p>' +
    '</div>';

  var plain =
    "¡Gracias por sumarte, " + p.nombre + "! 💜\n\n" +
    "Cada número vendido es un paso más en la recuperación de Paola. Tu ayuda significa muchísimo.\n\n" +
    "Adjunto va tu talonario en PDF, listo para imprimir y empezar a vender.\n" +
    (rangoTxt ? (rangoTxt + " — " + (p.cantidad * 15) + " números en total.\n\n") : "\n") +
    "Cuando termines de vender:\n" +
    "Envíale a Deny una FOTO del talonario físico y el comprobante de transferencia a " + EMAIL_DENY + ".\n\n" +
    "Datos para transferir:\n" +
    "  BancoEstado — CuentaRUT\n" +
    "  RUT: 14.279.967-7\n" +
    "  Nombre: Paola Soto\n" +
    "  Email: Denisse.psoto89@gmail.com\n\n" +
    "Cada comprador puede verificar su pago en https://rifa-paolasoto.vercel.app/\n\n" +
    "¡Gracias por ser parte de esto! 💜";

  MailApp.sendEmail(p.correo, subject, plain, {
    htmlBody: html,
    name: REMITENTE_NOMBRE,
    attachments: [pdfBlob],
    replyTo: EMAIL_DENY,
  });

  // ====================================================================
  // 2) Aviso interno — SEPARADO — a Deny + Pato + Coni, con PDF adjunto.
  // ====================================================================
  try {
    _sendAlertaInterna(p, rangoTxt, pdfBlob);
  } catch (alertErr) {
    // No bloquea el flujo si la alerta falla
  }

  return "ok (participante: " + p.correo + "; aviso: deny+pato+coni)";
}

// Alerta interna: Deny + Pato + Coni reciben un resumen estructurado de la
// descarga. Separada del correo al participante para que no se pierda entre
// otros mensajes. Deny recibe la alerta aunque ya esté en CC del mail al
// participante, para asegurar visibilidad del evento.
function _sendAlertaInterna(p, rangoTxt, pdfBlob) {
  var correoLower = (p.correo || "").toLowerCase();
  var tos = [EMAIL_DENY, _getEmailPato(), _getEmailConi()]
    .filter(function (x) { return x && x.trim(); })
    .filter(function (x) { return x.toLowerCase() !== correoLower; });
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
      '<p style="font-size:12px;color:#94a3b8;margin-top:16px;">El PDF del talonario va adjunto a este aviso. El participante también recibió su copia por correo.</p>' +
    '</div>';

  var plain =
    "📥 Nueva descarga de talonario\n\n" +
    "Nombre: "   + p.nombre   + "\n" +
    "Correo: "   + p.correo   + "\n" +
    "Teléfono: " + p.telefono + "\n" +
    "Cantidad: " + p.cantidad + " talonario(s) (" + (p.cantidad * 15) + " números)\n" +
    (rangoTxt ? ("Rango: " + rangoTxt + "\n") : "") +
    (p.codigos ? ("Códigos: " + p.codigos + "\n") : "") +
    "\nEl PDF del talonario va adjunto para tu registro.";

  var alertOpts = {
    htmlBody: html,
    name: REMITENTE_NOMBRE,
    replyTo: p.correo,
  };
  if (pdfBlob) alertOpts.attachments = [pdfBlob];

  MailApp.sendEmail(tos.join(","), subject, plain, alertOpts);
}

function _getOrCreateSheet() {
  var ss = _openSheet();
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
