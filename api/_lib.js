// Helpers compartidos por /api/descarga y /api/premio.

import { GoogleAuth } from "google-auth-library";
import nodemailer from "nodemailer";

const REQUIRED_ENVS = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "GOOGLE_SERVICE_ACCOUNT_KEY", "SHEET_ID"];

export function checkEnv() {
  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length) {
    return { ok: false, missing };
  }
  return { ok: true };
}

export function clean(s, max) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
}

export function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 120;
}

export function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Lista internos: destinatarios CC/BCC para alertas administrativas.
export function internalRecipients() {
  return [process.env.EMAIL_DENY, process.env.EMAIL_PATO, process.env.EMAIL_CONI]
    .map((x) => (x || "").trim())
    .filter((x) => x && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
}

let _sheetsAuthClient = null;

async function getSheetsAccessToken() {
  if (!_sheetsAuthClient) {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    let creds;
    try { creds = JSON.parse(raw); }
    catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY no es JSON válido"); }
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    _sheetsAuthClient = await auth.getClient();
  }
  const t = await _sheetsAuthClient.getAccessToken();
  return typeof t === "string" ? t : (t && t.token) || null;
}

// Inserta una fila en la pestaña indicada usando Sheets API (values.append).
// Si la pestaña no existe, la crea y le pone headers.
export async function appendRow({ sheetName, headers, row }) {
  const sheetId = process.env.SHEET_ID;
  const token = await getSheetsAccessToken();
  if (!token) throw new Error("No se pudo obtener access_token de Google");

  // Asegurar que la pestaña existe
  await ensureSheet({ sheetId, sheetName, headers, token });

  const range = encodeURIComponent(`${sheetName}!A1`);
  // RAW (no USER_ENTERED) para evitar Google Sheets formula injection
  // vía campos controlados por el usuario (=IMPORTRANGE, =HYPERLINK, etc.).
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Sheets append ${res.status}: ${txt.slice(0, 200)}`);
  }
  return true;
}

async function ensureSheet({ sheetId, sheetName, headers, token }) {
  // Lee metadata para saber si la pestaña existe
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) {
    const txt = await metaRes.text().catch(() => "");
    throw new Error(`Sheets meta ${metaRes.status}: ${txt.slice(0, 200)}`);
  }
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some((s) => s?.properties?.title === sheetName);
  if (exists) return;

  // Crea la pestaña
  const addUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  const addRes = await fetch(addUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
  });
  if (!addRes.ok) {
    const txt = await addRes.text().catch(() => "");
    throw new Error(`Sheets addSheet ${addRes.status}: ${txt.slice(0, 200)}`);
  }

  // Inserta headers como primera fila
  if (headers && headers.length) {
    const range = encodeURIComponent(`${sheetName}!A1`);
    const valUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`;
    await fetch(valUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [headers] }),
    });
  }
}

// Envía un correo con Gmail SMTP (nodemailer). Acepta adjuntos en base64.
let _mailer = null;
function getMailer() {
  if (_mailer) return _mailer;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user) throw new Error("GMAIL_USER no configurada");
  if (!pass) throw new Error("GMAIL_APP_PASSWORD no configurada");
  _mailer = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: pass.replace(/\s+/g, "") },
  });
  return _mailer;
}

// Elimina CR/LF/NUL/TAB de cualquier valor que vaya a un header SMTP
// para prevenir header injection (Bcc:, Content-Type:, etc.).
function sanitizeHeader(s, max = 998) {
  return String(s == null ? "" : s).replace(/[\r\n\0\t]/g, " ").trim().slice(0, max);
}

export async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
  const user = process.env.GMAIL_USER;
  const fromName = sanitizeHeader(process.env.GMAIL_FROM_NAME || "Rifa Paola Soto", 80);
  const toArr = Array.isArray(to) ? to : [to];
  const mailer = getMailer();

  const info = await mailer.sendMail({
    from: `"${fromName}" <${user}>`,
    to: toArr.join(", "),
    subject: sanitizeHeader(subject, 200),
    html,
    text,
    replyTo: replyTo ? sanitizeHeader(replyTo, 120) : undefined,
    attachments: (attachments || []).map((a) => ({
      filename: sanitizeHeader(a.filename, 120).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, "_"),
      content: Buffer.from(a.contentBase64, "base64"),
    })),
  });
  return { id: info.messageId };
}

// Rate-limit por IP en memoria. Cada instancia Vercel tiene su propio Map —
// no bloquea ataque distribuido pero sí frena ráfagas desde una IP.
const _rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 5;

export function clientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").toString();
  const ip = xff.split(",")[0].trim() || req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
  return String(ip).slice(0, 64);
}

export function rateLimit(req, bucket) {
  const ip = clientIp(req);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const hits = (_rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_HITS) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000);
    return { ok: false, retryAfter };
  }
  hits.push(now);
  _rateBuckets.set(key, hits);
  if (_rateBuckets.size > 500) {
    // Limpia buckets cuyo hit más antiguo ya salió de la ventana — así un
    // bucket con timestamps mezclados (viejos + uno reciente) también
    // libera memoria en los viejos.
    for (const [k, ts] of _rateBuckets) {
      const fresh = ts.filter((t) => now - t < RATE_WINDOW_MS);
      if (!fresh.length) _rateBuckets.delete(k);
      else if (fresh.length !== ts.length) _rateBuckets.set(k, fresh);
    }
  }
  return { ok: true };
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let buf = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      buf += chunk;
      if (buf.length > 2_000_000) {
        aborted = true;
        try { req.destroy(); } catch {}
        resolve(null);
      }
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => { if (!aborted) resolve(null); });
  });
}

export function json(res, status, obj) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.status(status).send(JSON.stringify(obj));
}
