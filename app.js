/* ============================================================
   CONFIGURACIÓN — editar sólo aquí
   ============================================================ */
const CONFIG = {
  titulo: "Gran Rifa",
  subtitulo: "Rifa 100% benéfica — actualizada en vivo.",

  // ID de la Google Sheet (entre /d/ y /edit en la URL)
  sheetId: "1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E",

  // Nombres EXACTOS de las pestañas del Sheet (case-sensitive).
  numerosSheet: "Numeros",
  premiosSheet: "Premios",
  descargasSheet: "Descargas",
  fotosSheet: "FotosTalonarios",

  // GIDs de pestañas para usar /export?format=csv en vez de gviz
  // (gviz infiere tipos y descarta texto en columnas numéricas).
  // Obtener GID: abrir la pestaña en Sheets → ver &gid=XXXX en la URL.
  numerosSheetGid: "1574989954",
  descargasSheetGid: "",   // llenar si se necesita leer Descargas por export

  // Estructura en bloques: mínimo 15 talonarios; se expande automáticamente
  // en cuanto se agregue una fila con rifa=16, 17, etc. en el Sheet.
  rifasCount: 15,
  numerosPorRifa: 15,

  // Hash SHA-256 de la clave admin (la clave real NUNCA va aquí en texto plano).
  // Para cambiarla: node -e "console.log(require('crypto').createHash('sha256').update('TU_CLAVE').digest('hex'))"
  adminKeyHash: "609b54cac6d4d1a541446402a4f244100b5244ff0065d17c7bcb6000437def79",

  // Endpoints backend en Vercel Functions.
  apiDescargaUrl: "/api/descarga",
  apiPremioUrl: "/api/premio",

  // Refresco automático (ms). 0 para desactivar.
  autoRefreshMs: 60000,
};

// Precarga de la foto de portada de Paola como data URL para incrustar en el PDF.
// En iOS Safari el pipeline canvas → toDataURL a veces produce JPEGs que jsPDF
// renderiza como rectángulo NEGRO (JPEG progresivo + bug de re-encode). Por eso
// leemos el archivo binario directo con fetch + FileReader y dejamos jsPDF
// incrustar el JPEG original sin tocarlo. Si falla, hay fallback con Image+canvas.
let paolaImgDataUrl = null;
let paolaImgReady = null; // Promise que resuelve cuando el preload termina (ok o falló)
paolaImgReady = (async function preloadPaolaImg() {
  // 1. Intento principal: fetch del JPEG original → data URL sin re-encode.
  try {
    const resp = await fetch("paola.jpg", { cache: "force-cache" });
    if (resp.ok) {
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      if (dataUrl && dataUrl.startsWith("data:image/")) {
        paolaImgDataUrl = dataUrl;
        return;
      }
    }
  } catch (_) { /* cae al fallback */ }

  // 2. Fallback: Image → canvas → toDataURL (solo si el fetch falló).
  try {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const maxSide = 400;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          paolaImgDataUrl = canvas.toDataURL("image/jpeg", 0.9);
        } catch (_) { paolaImgDataUrl = null; }
        resolve();
      };
      img.onerror = () => { paolaImgDataUrl = null; resolve(); };
      img.src = "paola.jpg";
    });
  } catch (_) { /* no-op */ }
})();

/* ============================================================
   Sheet fetch
   Requiere que el Sheet esté compartido como "Cualquiera con el enlace".
   Usamos /export?format=csv cuando tenemos el GID de la pestaña —
   esto preserva el texto literal sin inferencia de tipos (gviz descarta
   texto en columnas mayormente numéricas, ej. "DENY", "deny11", "1DE").
   Para pestañas sin GID configurado, caemos a gviz JSON.
   ============================================================ */
const sheetWebUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/edit`;

// Proxy serverless propio (/api/sheet?gid=X) que pide el CSV a Google
// desde el servidor. Así evitamos CORS Y la inferencia de tipos de gviz.
const sheetExportUrl = (gid) => `/api/sheet?gid=${gid}&_=${Date.now()}`;

// URL gviz JSON (fallback para pestañas sin GID)
const sheetJsonUrl = (sheetName) =>
  `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&_=${Date.now()}`;

// Parsea un CSV respetando comillas RFC 4180
function _parseCsv(text) {
  const lines = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { cur.push(field); field = ""; }
      else if (ch === '\n') { cur.push(field); lines.push(cur); cur = []; field = ""; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field || cur.length) { cur.push(field); lines.push(cur); }
  return lines;
}

async function _fetchByExport(gid) {
  const res = await fetch(sheetExportUrl(gid), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Export ${res.status}`);
  const text = await res.text();
  const lines = _parseCsv(text);
  if (lines.length < 2) return [];
  const headers = lines[0].map(h => h.trim().toLowerCase());
  return lines.slice(1)
    .map(row => Object.fromEntries(headers.map((h, i) => [h, (row[i] || "").trim()])))
    .filter(r => Object.values(r).some(v => v !== ""));
}

// Convierte una celda gviz JSON a string (fallback path)
function _gvizCell(cell) {
  if (!cell) return "";
  const v = cell.v, f = cell.f;
  if (v == null) return f != null ? String(f).trim() : "";
  if (typeof v === "string" && v.startsWith("Date(")) return f != null ? String(f).trim() : "";
  if (typeof v === "number") return String(Number.isInteger(v) ? v : v).trim();
  return String(v).trim();
}

async function _fetchByGviz(sheetName) {
  const res = await fetch(sheetJsonUrl(sheetName), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Sheet ${res.status}`);
  const text = await res.text();
  const json = JSON.parse(text.replace(/^[^{]*\{/, "{").replace(/\}\s*\)\s*;?\s*$/, "}"));
  if (!json.table) return [];
  const { cols, rows } = json.table;
  const headers = cols.map(c => (c.label || c.id || "").trim().toLowerCase());
  return (rows || [])
    .map(r => Object.fromEntries(headers.map((h, i) => [h, _gvizCell(r.c ? r.c[i] : null)])))
    .filter(r => Object.values(r).some(v => v !== ""));
}

// GID map: sheetName → gid (only sheets where we know the GID)
function _gidFor(sheetName) {
  const map = {
    [CONFIG.numerosSheet]: CONFIG.numerosSheetGid,
    [CONFIG.descargasSheet]: CONFIG.descargasSheetGid,
  };
  return (map[sheetName] || "").trim();
}

async function fetchSheet(sheetName) {
  const gid = _gidFor(sheetName);
  if (gid) return _fetchByExport(gid);
  return _fetchByGviz(sheetName);
}

const STATUS = {
  paid: ["si","sí","true","1","x","pagado","ok","pago"],
  reserved: ["reservado","apartado","pendiente","pending","reservada"],
};
function classify(v) {
  const s = (v || "").toString().trim().toLowerCase();
  if (STATUS.paid.includes(s)) return "paid";
  if (STATUS.reserved.includes(s)) return "reserved";
  return "free";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"'`=\/]/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","`":"&#96;","=":"&#61;","/":"&#47;" }[c]));
}

/* ============================================================
   Render: Premios
   ============================================================ */
const MAX_PREMIOS_VISIBLES = 24;

function _extractPremioLinks(text) {
  if (!text) return { text: "", links: [] };
  const urlRe = /(https?:\/\/[^\s<]+)/gi;
  const links = [];
  const cleaned = String(text).replace(urlRe, (match) => {
    let clean = match;
    while (/[.,;:!?)\]]$/.test(clean)) clean = clean.slice(0, -1);
    if (clean) links.push(clean);
    return "";
  }).replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return { text: cleaned, links };
}

function _premioLinkLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    if (/instagram\.com$/i.test(host)) {
      const handle = u.pathname.split("/").filter(Boolean)[0];
      if (handle) return "@" + handle;
    }
    if (/facebook\.com$/i.test(host)) {
      const handle = u.pathname.split("/").filter(Boolean)[0];
      if (handle) return "Facebook: " + handle;
    }
    if (/(tiktok\.com)$/i.test(host)) {
      const handle = u.pathname.split("/").filter(Boolean)[0];
      if (handle) return handle.startsWith("@") ? handle : "@" + handle;
    }
    if (/(wa\.me|whatsapp\.com)$/i.test(host)) return "WhatsApp";
    return host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }
}

function _buildPremioCard(p, i, isExtra) {
  const lugar = p.lugar || p.premio || `#${i + 1}`;
  const nombre = p.nombre || p.descripcion || p.premio || "Premio";
  const descRaw = (p.descripcion && p.nombre) ? p.descripcion : "";
  const ganador = p.ganador || "";
  const medalClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
  const medalEmoji = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🎁";
  const { text: descText, links } = _extractPremioLinks(descRaw);
  const linksHtml = links.length
    ? `<div class="premio-links">${links.map(u =>
        `<a class="premio-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">🔗 ${esc(_premioLinkLabel(u))}</a>`
      ).join("")}</div>`
    : "";
  const extraClass = isExtra ? " premio--extra" : "";
  return `
      <div class="premio${i < 3 ? " top" : ""}${extraClass}">
        <span class="medal ${medalClass}">${medalEmoji} ${esc(lugar)}</span>
        <h3>${esc(nombre)}</h3>
        ${descText ? `<p>${esc(descText)}</p>` : ""}
        ${linksHtml}
        ${ganador ? `<div class="winner">🎉 Ganador: ${esc(ganador)}</div>` : ""}
      </div>`;
}

function renderPremios(list) {
  lastPremios = Array.isArray(list) ? list : [];
  const el = document.getElementById("premios");
  if (!list || !list.length) {
    el.innerHTML = `<div class="state"><span class="emoji">🎁</span>Los premios se anunciarán pronto.</div>`;
    el.classList.remove("show-extras");
    return;
  }
  const cards = list.map((p, i) => _buildPremioCard(p, i, i >= MAX_PREMIOS_VISIBLES)).join("");
  const extrasCount = Math.max(0, list.length - MAX_PREMIOS_VISIBLES);
  const toggleHtml = extrasCount > 0
    ? `<button type="button" class="premios-extras-toggle" id="premios-extras-toggle" aria-expanded="false" aria-controls="premios">
        <span class="premios-extras-label">🎁 Ver ${extrasCount} premio${extrasCount === 1 ? "" : "s"} adicional${extrasCount === 1 ? "" : "es"}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="m6 9 6 6 6-6"/></svg>
      </button>`
    : "";
  el.classList.remove("show-extras");
  el.innerHTML = cards + toggleHtml;
  if (extrasCount > 0) {
    const btn = document.getElementById("premios-extras-toggle");
    const label = btn?.querySelector(".premios-extras-label");
    btn?.addEventListener("click", () => {
      const open = el.classList.toggle("show-extras");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (label) label.textContent = open
        ? `Ocultar premios adicionales`
        : `🎁 Ver ${extrasCount} premio${extrasCount === 1 ? "" : "s"} adicional${extrasCount === 1 ? "" : "es"}`;
    });
  }
}

/* ============================================================
   Render: Números (stats, hero ring, grid, table, admin)
   ============================================================ */
let lastNumeros = [];
let lastPremios = [];
let lastDescargas = [];
let lastRifasCount = 15;

// Paginación grid de talonarios
const TALONARIOS_GRID_PAGE_SIZE = 3;
let talonariosGridPage = 1;
let _tgSorted = [];
let _tgByCell = new Map();
let _tgVendedor = new Map();
let _tgN = 15;

// Paginación de participantes
const PARTICIPANTS_PAGE_SIZE = 15;
let participantsRows = [];
let participantsPage = 1;
let participantsQuery = "";

function renderFotosTalonarios(rows) {
  const host = document.getElementById("fotos-talonarios");
  if (!host) return;
  const list = (Array.isArray(rows) ? rows : [])
    .map(r => ({
      url:       (r.url || r.foto || r.link || r.imagen || "").trim(),
      talonario: (r.talonario || r.rifa || r.n || "").toString().trim(),
      fecha:     (r.fecha || r.timestamp || "").trim(),
    }))
    .filter(r => /^(https?:\/\/|\/)/i.test(r.url));

  if (!list.length) return; // deja el estado vacío que ya está en el HTML

  host.innerHTML = `<div class="fotos-grid">` + list.map(f => {
    const label = f.talonario ? `Talonario ${esc(f.talonario)}` : "Talonario";
    return `
      <a class="foto-talonario" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">
        <img src="${esc(f.url)}" alt="${esc(label)}" loading="lazy" referrerpolicy="no-referrer">
        <div class="foto-label">${esc(label)}</div>
      </a>`;
  }).join("") + `</div>`;
}

async function loadFotosTalonarios() {
  // Preferido: /api/fotos lee directo de la carpeta Drive compartida con el service account.
  try {
    const res = await fetch("/api/fotos", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.fotos) && data.fotos.length) {
        renderFotosTalonarios(data.fotos);
        return;
      }
    }
  } catch { /* cae al fallback */ }

  // Fallback: pestaña FotosTalonarios del Sheet (si alguien la mantiene manualmente).
  if (!CONFIG.fotosSheet) return;
  try {
    const rows = await fetchSheet(CONFIG.fotosSheet);
    renderFotosTalonarios(rows);
  } catch { /* sheet no creado aún — queda el estado vacío */ }
}

// Extrae las primeras 2 letras del nombre, sin tildes, en mayúsculas.
// Si no hay letras, usa "XX".
function prefijoDeNombre(nombre) {
  const norm = String(nombre || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
  return (norm.slice(0, 2) || "XX").padEnd(2, "X");
}

// Orden natural para códigos tipo "MA1", "MA2", "MA10"
function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// Parsea un código de talonario en {prefix, index}.
// Soporta: "1DE" (nuevo, número primero), "DE1" (legacy), "1" / "3" (solo número).
function parseTalCode(s) {
  const clean = String(s || "").trim().toUpperCase();
  let m;
  // Formato principal: {N}{letras} — "1DE", "7AC", "12MA"
  m = clean.match(/^(\d+)([A-ZÑ]{2,3})$/);
  if (m) return { prefix: m[2], index: Number(m[1]) };
  // Formato legacy: {letras}{N} — "DE1", "MA12"
  m = clean.match(/^([A-ZÑ]{2,3})(\d+)$/);
  if (m) return { prefix: m[1], index: Number(m[2]) };
  // Solo número: "1", "3", "4"
  m = clean.match(/^(\d+)$/);
  if (m) return { prefix: "", index: Number(m[1]) };
  return null;
}

function renderNumeros(list) {
  lastNumeros = list;

  const N = Math.max(1, Number(CONFIG.numerosPorRifa) || 15);

  // Parse: el talonario es un STRING (código tipo "MA1" o número simple "1").
  // Cada fila: { talCode, local (1..N), comprador, vendedor, fecha, status }.
  const rows = list.map(n => {
    const raw = Number((n.numero || n.número || "").toString().replace(/\D/g, ""));
    let talCode = String(n.talonario || n.rifa || "").trim();
    let local = raw;
    if (talCode && raw > N) local = ((raw - 1) % N) + 1;
    return {
      talCode,
      local,
      comprador: (n.comprador || n.nombre || "").trim(),
      vendedor: (n.vendedor || n.seller || n["a_cargo"] || "").trim(),
      fecha: (n.fecha || "").trim(),
      status: classify(n.pagado || n.estado || n.status),
    };
  }).filter(r => r.talCode && r.local > 0 && r.local <= N);

  // Lista de códigos distintos presentes en el Sheet, en orden natural.
  const talCodes = [...new Set(rows.map(r => r.talCode))].sort(naturalCmp);

  // Mapa por talCode → vendedor (primer vendedor no vacío observado).
  const vendedorByTal = new Map();
  for (const r of rows) {
    if (r.vendedor && !vendedorByTal.has(r.talCode)) vendedorByTal.set(r.talCode, r.vendedor);
  }

  // Mapa (talCode, local) → row — sin duplicados (primera entrada gana)
  const mapKey = (code, l) => `${code}-${l}`;
  const byCell = new Map();
  rows.forEach(r => { if (!byCell.has(mapKey(r.talCode, r.local))) byCell.set(mapKey(r.talCode, r.local), r); });

  // Contar desde byCell (sin duplicados)
  const allCells = [...byCell.values()];
  const paidCount = allCells.filter(r => r.status === "paid").length;
  const reservedCount = allCells.filter(r => r.status === "reserved").length;
  const totalRegistrados = talCodes.length * N;
  const freeCount = Math.max(0, totalRegistrados - paidCount - reservedCount);
  lastRifasCount = talCodes.length;

  document.getElementById("stats").innerHTML = `
    <div class="stat stat-paid">
      <div class="stat-num">${paidCount}</div>
      <div class="stat-label">Pagados</div>
      <div class="stat-sub">💚 comprobante recibido</div>
    </div>
    <div class="stat stat-reserved">
      <div class="stat-num">${reservedCount}</div>
      <div class="stat-label">Reservados</div>
      <div class="stat-sub">⏳ en espera de pago</div>
    </div>
    <div class="stat stat-free">
      <div class="stat-num">✅</div>
      <div class="stat-label">Disponibles</div>
      <div class="stat-sub">Aún quedan números — se suman talonarios a medida que crece la demanda</div>
    </div>
    <a class="stat cta-stat" href="#pedir-talonario">
      <div class="stat-num">💜</div>
      <div class="stat-label">Pide tu talonario o compra un número</div>
    </a>
  `;

  const isAdmin = document.body.classList.contains("is-admin");

  // Grid por talonario (15 celdas con estado de cada número)
  renderTalonariosGrid(talCodes, byCell, vendedorByTal, N);

  // Orden por estado (consistente con la grilla superior):
  //   con libres (disponibles) → mixtos → completos pagados → reservados.
  //   Dentro del mismo rank, índice global DESC.
  const countsOf = (code) => {
    let paid = 0, reserved = 0, free = 0;
    for (let i = 1; i <= N; i++) {
      const rec = byCell.get(mapKey(code, i));
      if (!rec || rec.status === "free") free++;
      else if (rec.status === "paid") paid++;
      else if (rec.status === "reserved") reserved++;
    }
    return { paid, reserved, free };
  };
  const rankOf = (code) => {
    const { paid, reserved, free } = countsOf(code);
    if (free > 0) return 0;
    if (paid > 0 && reserved > 0) return 1;
    if (paid > 0 && reserved === 0) return 2;
    return 3;
  };
  const sortedTalCodes = [...talCodes].sort((a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const fa = countsOf(a).free;
      const fb = countsOf(b).free;
      if (fa !== fb) return fb - fa;
    }
    const pa = parseTalCode(a) || { prefix: a, index: -1 };
    const pb = parseTalCode(b) || { prefix: b, index: -1 };
    if (pa.index !== pb.index) return pb.index - pa.index;
    return pb.prefix.localeCompare(pa.prefix);
  });

  // Tabla detalle — agrupada por talonario en el orden anterior
  participantsRows = [];
  for (const code of sortedTalCodes) {
    for (let i = 1; i <= N; i++) {
      const rec = byCell.get(mapKey(code, i));
      if (!rec || (!isAdmin && rec.status === "free")) continue;
      participantsRows.push({
        rifa: code,
        local: i,
        pad: String(i).padStart(2, "0"),
        nombre: rec.comprador,
        vendedor: rec.vendedor,
        fecha: rec.fecha,
        status: rec.status,
        searchKey: normSearch(code + " " + i + " " + String(i).padStart(2, "0") + " " + rec.comprador + " " + rec.vendedor),
      });
    }
  }
  if (participantsPage < 1) participantsPage = 1;
  renderParticipantsPage();

  if (isAdmin) {
    const recaudado = paidCount * 1000;
    document.getElementById("admin-stats").innerHTML = `
      <div class="stat"><div class="stat-num">${paidCount}</div><div class="stat-label">Pagados</div></div>
      <div class="stat"><div class="stat-num">${reservedCount}</div><div class="stat-label">Reservados</div></div>
      <div class="stat"><div class="stat-num">${freeCount}</div><div class="stat-label">Libres</div></div>
      <div class="stat"><div class="stat-num">$${recaudado.toLocaleString("es-CL")}</div><div class="stat-label">Recaudado</div></div>
    `;
    const libresPorTal = [];
    for (const code of talCodes) {
      const libres = [];
      for (let i = 1; i <= N; i++) {
        const rec = byCell.get(mapKey(code, i));
        if (!rec || rec.status === "free") libres.push(String(i).padStart(2, "0"));
      }
      if (libres.length) libresPorTal.push(`<div style="margin-bottom:8px;"><strong>Talonario ${esc(code)}:</strong> ${libres.join(", ")}</div>`);
    }
    document.getElementById("admin-libres").innerHTML = libresPorTal.length
      ? `<div style="padding:14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;font-size:14px;line-height:1.7;">${libresPorTal.join("")}</div>`
      : `<div class="state"><span class="emoji">🎉</span>¡Todos los números vendidos!</div>`;
    document.getElementById("open-sheet").href = sheetWebUrl;
  }
}

function _tgFreeCount(code) {
  let f = 0;
  for (let i = 1; i <= _tgN; i++) {
    const r = _tgByCell.get(`${code}-${i}`);
    if (!r || r.status === "free") f++;
  }
  return f;
}

// Cuenta por estado (paid/reserved/free) dentro de un talonario
function _tgCounts(code) {
  let paid = 0, reserved = 0, free = 0;
  for (let i = 1; i <= _tgN; i++) {
    const r = _tgByCell.get(`${code}-${i}`);
    if (!r || r.status === "free") free++;
    else if (r.status === "paid") paid++;
    else if (r.status === "reserved") reserved++;
  }
  return { paid, reserved, free };
}

// Rank de orden (menor = se muestra primero):
//   0 = tiene cupos libres (DISPONIBLES para comprar)
//   1 = completo con mezcla de pagados y reservados
//   2 = completo pagado (sin libres ni reservados)
//   3 = completo reservado (sin pagados ni libres)
function _tgRank(code) {
  const { paid, reserved, free } = _tgCounts(code);
  if (free > 0) return 0;
  if (paid > 0 && reserved > 0) return 1;
  if (paid > 0 && reserved === 0) return 2;
  return 3;
}

function renderTalonariosGrid(codes, byCell, vendedorByTal, N) {
  const host = document.getElementById("talonarios-grid");
  if (!host) return;
  if (!codes.length) {
    host.innerHTML = `<div class="state"><span class="emoji">📭</span>Aún no hay talonarios registrados en el Sheet.<br><small>A medida que Deny los suba, aparecerán aquí con su grilla 1-15.</small></div>`;
    return;
  }
  // Guardar para re-renders de paginación
  _tgByCell = byCell; _tgVendedor = vendedorByTal; _tgN = N;

  // Orden: con libres (más libres primero) → mixtos → completos pagados → reservados.
  // Dentro del mismo rank, índice DESC (los más nuevos arriba).
  _tgSorted = [...codes].sort((a, b) => {
    const ra = _tgRank(a), rb = _tgRank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const fa = _tgCounts(a).free;
      const fb = _tgCounts(b).free;
      if (fa !== fb) return fb - fa;
    }
    const pa = parseTalCode(a) || { index: -1 };
    const pb = parseTalCode(b) || { index: -1 };
    return pb.index - pa.index;
  });

  talonariosGridPage = 1;
  _renderTalonariosGridPage();
}

function _renderTalonariosGridPage() {
  const host = document.getElementById("talonarios-grid");
  if (!host) return;
  const N = _tgN;
  const total = _tgSorted.length;
  const totalPages = Math.max(1, Math.ceil(total / TALONARIOS_GRID_PAGE_SIZE));
  if (talonariosGridPage > totalPages) talonariosGridPage = totalPages;
  if (talonariosGridPage < 1) talonariosGridPage = 1;

  const start = (talonariosGridPage - 1) * TALONARIOS_GRID_PAGE_SIZE;
  const end = Math.min(start + TALONARIOS_GRID_PAGE_SIZE, total);

  const cards = _tgSorted.slice(start, end).map(code => {
    const vendedor = _tgVendedor.get(code) || "";
    let paid = 0, reserved = 0;
    const cells = [];
    for (let i = 1; i <= N; i++) {
      const rec = _tgByCell.get(`${code}-${i}`);
      const status = rec ? rec.status : "free";
      const pad = String(i).padStart(2, "0");
      if (status === "paid") paid++;
      else if (status === "reserved") reserved++;
      const tip = rec
        ? `${pad} — ${rec.comprador || (status === "reserved" ? "Reservado" : "Libre")}`
        : `${pad} — Libre`;
      cells.push(`<div class="tg-cell ${status}" title="${esc(tip)}">${pad}</div>`);
    }
    return `
      <div class="tg-card">
        <div class="tg-header">
          <div class="tg-code">Talonario <strong>${esc(code)}</strong></div>
          ${vendedor ? `<div class="tg-vendedor">${esc(vendedor)}</div>` : ""}
          <div class="tg-counts">
            <span class="tg-count free">${N - paid - reserved} libre${(N - paid - reserved) === 1 ? "" : "s"}</span>
            · <span class="tg-count reserved">${reserved} reservado${reserved === 1 ? "" : "s"}</span>
            · <span class="tg-count paid">${paid} pagado${paid === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="tg-grid">${cells.join("")}</div>
      </div>`;
  }).join("");

  const pager = totalPages > 1 ? `
    <div class="pager">
      <button class="pager-btn" data-page="prev" ${talonariosGridPage === 1 ? "disabled" : ""} aria-label="Anterior">← Anterior</button>
      <span class="pager-info">
        <strong>${start + 1}–${end}</strong> de <strong>${total}</strong> talonarios
        · Página <strong>${talonariosGridPage}</strong> de <strong>${totalPages}</strong>
      </span>
      <button class="pager-btn" data-page="next" ${talonariosGridPage === totalPages ? "disabled" : ""} aria-label="Siguiente">Siguiente →</button>
    </div>`
    : `<div class="pager-summary">${total} talonario${total === 1 ? "" : "s"}</div>`;

  host.innerHTML = `<div class="tg-cards-wrap">${cards}</div>${pager}`;

  host.querySelectorAll(".pager-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page === "prev") talonariosGridPage--;
      else talonariosGridPage++;
      _renderTalonariosGridPage();
      host.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// Mayor índice global visto en Numeros + Descargas.
// El siguiente talonario descargado tendrá ese número + 1.
function _recomputeMaxGlobalIndex() {
  let max = 0;
  const check = (raw) => {
    const p = parseTalCode(String(raw || "").trim());
    if (p && p.index > max) max = p.index;
  };
  for (const n of (lastNumeros || [])) check(n.talonario || n.rifa);
  for (const d of (lastDescargas || [])) {
    String(d.codigos || "").split(/[\s,;]+/).forEach(check);
    check(d.desde || d.talonariodesde);
    check(d.hasta || d.talonariohasta);
  }
  return max;
}

// Genera los próximos `cantidad` códigos: formato {N}{2letras} — ej. "1DE", "2DE".
// El número es global (cuenta todos los talonarios ya asignados en el Sheet).
function generarCodigosTalonarios(nombre, cantidad) {
  const prefix = prefijoDeNombre(nombre);
  const base = _recomputeMaxGlobalIndex();
  return Array.from({ length: cantidad }, (_, i) => (base + i + 1) + prefix);
}

/* ============================================================
   Participantes: render paginado + búsqueda
   ============================================================ */
function _buildSearchSummary(filtered, rawQuery) {
  const paidN = filtered.filter(r => r.status === "paid").length;
  const reservedN = filtered.filter(r => r.status === "reserved").length;
  const names = filtered.map(r => (r.nombre || "").trim()).filter(Boolean);
  const uniq = [...new Set(names.map(n => n.toLowerCase()))];
  const countWord = (n) => `${n} número${n === 1 ? "" : "s"}`;
  if (uniq.length === 1 && names.length) {
    const nombre = names.find(n => n.toLowerCase() === uniq[0]) || names[0];
    return `<div class="search-summary">
      <span class="ss-icon">👤</span>
      <div class="ss-body">
        <div><strong>${esc(nombre)}</strong> tiene <strong>${countWord(filtered.length)}</strong> registrado${filtered.length === 1 ? "" : "s"}</div>
        <div class="ss-breakdown">
          <span class="ss-chip paid">${paidN} pagado${paidN === 1 ? "" : "s"}</span>
          <span class="ss-chip reserved">${reservedN} reservado${reservedN === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>`;
  }
  if (uniq.length > 1) {
    return `<div class="search-summary">
      <span class="ss-icon">🔎</span>
      <div class="ss-body">
        <div><strong>${countWord(filtered.length)}</strong> · <strong>${uniq.length}</strong> personas coinciden con "${esc(rawQuery)}"</div>
        <div class="ss-breakdown">
          <span class="ss-chip paid">${paidN} pagado${paidN === 1 ? "" : "s"}</span>
          <span class="ss-chip reserved">${reservedN} reservado${reservedN === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>`;
  }
  return `<div class="search-summary">
    <span class="ss-icon">🔎</span>
    <div class="ss-body">
      <div><strong>${countWord(filtered.length)}</strong> coincide${filtered.length === 1 ? "" : "n"} con "${esc(rawQuery)}"</div>
    </div>
  </div>`;
}

function renderParticipantsPage() {
  const host = document.getElementById("table-view");
  if (!host) return;

  const rawQuery = participantsQuery.trim();
  const q = normSearch(rawQuery);
  const filtered = q
    ? participantsRows.filter(r => r.searchKey.includes(q))
    : participantsRows;

  if (!filtered.length) {
    host.innerHTML = q
      ? `<div class="state"><span class="emoji">🔍</span>Ningún participante coincide con "<strong>${esc(rawQuery)}</strong>".</div>`
      : `<div class="state"><span class="emoji">🕒</span>Aún no hay participantes confirmados.<br><small>Cuando alguien envíe su comprobante, aparecerá acá con su nombre y número.</small></div>`;
    return;
  }

  const summaryHtml = q ? _buildSearchSummary(filtered, rawQuery) : "";

  const totalPages = Math.max(1, Math.ceil(filtered.length / PARTICIPANTS_PAGE_SIZE));
  if (participantsPage > totalPages) participantsPage = totalPages;
  if (participantsPage < 1) participantsPage = 1;

  const start = (participantsPage - 1) * PARTICIPANTS_PAGE_SIZE;
  const end = Math.min(start + PARTICIPANTS_PAGE_SIZE, filtered.length);
  const pageRows = filtered.slice(start, end);

  const trs = pageRows.map(r => {
    const cls = r.status === "paid" ? "" : "pending";
    const etiq = r.status === "paid" ? "Pagado" : r.status === "reserved" ? "Reservado" : "Libre";
    return `
      <tr data-status="${esc(r.status)}">
        <td><strong>${esc(r.rifa)}</strong></td>
        <td><span class="num-badge ${cls}">${esc(r.pad)}</span></td>
        <td>${esc(r.nombre || "—")}</td>
        <td>${esc(r.fecha)}</td>
        <td>${etiq}</td>
      </tr>`;
  }).join("");

  const pager = totalPages > 1 ? `
    <div class="pager">
      <button class="pager-btn" data-page="prev" ${participantsPage === 1 ? "disabled" : ""} aria-label="Página anterior">← Anterior</button>
      <span class="pager-info">
        <strong>${start + 1}–${end}</strong> de <strong>${filtered.length}</strong>
        · Página <strong>${participantsPage}</strong> de <strong>${totalPages}</strong>
      </span>
      <button class="pager-btn" data-page="next" ${participantsPage === totalPages ? "disabled" : ""} aria-label="Página siguiente">Siguiente →</button>
    </div>` : `<div class="pager-summary">${filtered.length} participante${filtered.length === 1 ? "" : "s"}</div>`;

  host.innerHTML = `
    ${summaryHtml}
    <div class="table-wrap"><table>
      <thead><tr><th>Talonario</th><th>Número</th><th>Nombre completo</th><th>Fecha</th><th>Estado</th></tr></thead>
      <tbody id="tbody">${trs}</tbody>
    </table></div>
    ${pager}`;

  host.querySelectorAll("[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.page === "prev") participantsPage--;
      else if (btn.dataset.page === "next") participantsPage++;
      renderParticipantsPage();
      host.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function normSearch(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function wireSearch() {
  const input = document.getElementById("search");
  if (!input) return;
  input.addEventListener("input", () => {
    participantsQuery = input.value || "";
    participantsPage = 1; // cualquier búsqueda vuelve a la primera página
    renderParticipantsPage();
  });
}

/* ============================================================
   Tema claro/oscuro
   ============================================================ */
function setThemeIcon(t) {
  const icon = document.getElementById("theme-icon");
  if (!icon) return;
  // Limpiar
  while (icon.firstChild) icon.removeChild(icon.firstChild);
  const NS = "http://www.w3.org/2000/svg";
  if (t === "dark") {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z");
    icon.appendChild(p);
  } else {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "4");
    icon.appendChild(c);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41");
    icon.appendChild(p);
  }
}
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("rifa-theme", t); } catch {}
  setThemeIcon(t);
}
function initTheme() {
  let t;
  try { t = localStorage.getItem("rifa-theme"); } catch {}
  if (!t) t = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(t);
  document.getElementById("theme-btn").addEventListener("click", () => {
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
}

/* ============================================================
   Toast
   ============================================================ */
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2400);
}

function initFotoLightbox() {
  const box = document.getElementById("foto-lightbox");
  const img = document.getElementById("foto-lightbox-img");
  if (!box || !img) return;
  document.querySelectorAll('img[data-zoom]').forEach((el) => {
    el.addEventListener("click", () => {
      img.src = el.src;
      img.alt = el.alt || "";
      box.classList.add("show");
    });
  });
  const close = () => { box.classList.remove("show"); img.src = ""; };
  box.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}
document.addEventListener("DOMContentLoaded", initFotoLightbox);

function showInfoModal(title, msg) {
  const modal = document.getElementById("info-modal");
  if (!modal) return;
  const t = document.getElementById("info-modal-title");
  const m = document.getElementById("info-modal-msg");
  const ok = document.getElementById("info-modal-ok");
  if (t) t.textContent = title;
  if (m) m.textContent = msg;
  modal.classList.add("show");
  const close = () => {
    modal.classList.remove("show");
    modal.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onEsc);
    ok?.removeEventListener("click", close);
  };
  const onBackdrop = (e) => { if (e.target === modal) close(); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  ok?.addEventListener("click", close);
  modal.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onEsc);
  setTimeout(() => ok?.focus(), 50);
}

/* ============================================================
   Admin
   ============================================================ */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Comparación constante en tiempo para evitar timing attacks en el hash.
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function checkAdmin() {
  const p = new URLSearchParams(location.search);
  const key = p.get("admin");
  if (key) {
    try {
      const h = await sha256Hex(key);
      if (timingSafeEqualHex(h, CONFIG.adminKeyHash)) {
        document.body.classList.add("is-admin");
        try { sessionStorage.setItem("rifa-admin", "1"); } catch {}
      }
    } catch {}
    // Siempre limpiar la query para no dejar la clave en el historial, match o no.
    history.replaceState(null, "", location.pathname);
  } else if (sessionStorage.getItem("rifa-admin") === "1") {
    document.body.classList.add("is-admin");
  }
  document.getElementById("exit-admin")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.body.classList.remove("is-admin");
    try { sessionStorage.removeItem("rifa-admin"); } catch {}
    location.replace(location.pathname);
  });
  document.getElementById("copy-libres")?.addEventListener("click", () => {
    const el = document.getElementById("admin-libres");
    const txt = el?.innerText || "";
    const libres = txt.replace(/^.*libres:\s*/i, "").trim();
    navigator.clipboard?.writeText(libres).then(
      () => toast("Libres copiados"),
      () => toast("No se pudo copiar")
    );
  });
}

/* ============================================================
   Copiar datos de transferencia
   ============================================================ */
function wireTransferCopy() {
  document.querySelectorAll("[data-copy]").forEach(el => {
    el.addEventListener("click", () => {
      const v = el.dataset.copy;
      navigator.clipboard?.writeText(v).then(
        () => toast(`Copiado: ${v}`),
        () => toast("No se pudo copiar")
      );
    });
  });
  const btn = document.getElementById("copy-all");
  if (btn) btn.addEventListener("click", () => {
    const txt = [
      "Datos de transferencia — Rifa Paola Soto",
      "Valor por número: $1.000",
      "Banco: BancoEstado",
      "Tipo de cuenta: CuentaRUT",
      "Nº de cuenta: 14279967",
      "RUT: 14.279.967-7",
      "Nombre: Paola Soto",
      "Email: Denisse.psoto89@gmail.com",
    ].join("\n");
    navigator.clipboard?.writeText(txt).then(
      () => toast("Datos copiados al portapapeles"),
      () => toast("No se pudo copiar")
    );
  });
}

/* ============================================================
   Solicitar talonario — PDF + email
   ============================================================ */
async function buildTalonarioPDF({ nombre, correo, telefono, cantidad, codigos }) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    toast("No se pudo cargar el generador de PDF. Intenta de nuevo.");
    return false;
  }
  // Esperar el preload de la foto (máx ~4s) antes de generar el PDF, así evitamos
  // talonarios sin foto o con foto negra en iPhone por preload incompleto.
  if (paolaImgReady) {
    try {
      await Promise.race([
        paolaImgReady,
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    } catch (_) { /* seguimos sin foto si falla */ }
  }
  const N = Math.max(1, Number(CONFIG.numerosPorRifa) || 15);
  const codes = Array.isArray(codigos) && codigos.length ? codigos : [];
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const PW = 612, PH = 792, ML = 40, MR = 40, CW = PW - ML - MR;
  const PURPLE = [124, 58, 237];
  const PURPLE_SOFT = [236, 232, 250];
  const TEXT = [15, 23, 42];
  const MUTED = [100, 116, 139];
  const BORDER = [210, 205, 230];

  const fixText = (s) => (s == null ? "" : String(s)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim());

  const wrap = (s, maxChars) => {
    s = fixText(s);
    if (s.length <= maxChars) return [s];
    const words = s.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length <= maxChars) {
        line = (line + " " + w).trim();
      } else {
        if (line) lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  for (let k = 0; k < cantidad; k++) {
    if (k > 0) doc.addPage();
    const codigo = codes[k] || `TAL${k + 1}`;

    // Banda superior
    doc.setFillColor(...PURPLE);
    doc.rect(0, 0, PW, 76, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(22);
    doc.text("RIFA PAOLA SOTO", ML, 34);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10.5);
    doc.text("Por su recuperacion - gracias por apoyarla", ML, 54);
    doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text(`Talonario ${fixText(codigo)}`, PW - MR, 34, { align: "right" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text(`Numeros 01 - ${String(N).padStart(2, "0")}`, PW - MR, 52, { align: "right" });
    doc.setFontSize(9); doc.setFont("helvetica", "normal");
    doc.text(`Hoja ${k + 1} de ${cantidad}`, PW - MR, 64, { align: "right" });

    // ========================================================
    // Top section: info vendedor (izq) + card con foto Paola (der)
    // ========================================================
    const PURPLE_DARK = [76, 29, 149];  // violet-800
    doc.setTextColor(...TEXT);
    let y = 96;
    const topH = 72;
    const photoCardW = 132;
    const topGap = 14;
    const vendedorW = CW - photoCardW - topGap;

    // -- Caja vendedor (izq) --
    doc.setFillColor(250, 248, 255);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(ML, y, vendedorW, topH, 6, 6, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text("A CARGO DE", ML + 12, y + 16);
    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.setTextColor(...TEXT);
    doc.text(fixText(nombre), ML + 12, y + 34);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    doc.setTextColor(...MUTED);
    doc.text(fixText(correo) + "   |   Tel: " + fixText(telefono || "—"), ML + 12, y + 50);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setTextColor(...PURPLE);
    doc.text(`${cantidad} talonario(s)  -  ${cantidad * N} numeros  -  $1.000 c/u`, ML + 12, y + 64);

    // -- Card foto Paola (der) --
    const photoCardX = ML + vendedorW + topGap;
    doc.setFillColor(...PURPLE_DARK);
    doc.roundedRect(photoCardX, y, photoCardW, topH, 8, 8, "F");
    const photoSize = 46;
    const photoX = photoCardX + (photoCardW - photoSize) / 2;
    const photoY = y + 6;
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(photoX - 2.5, photoY - 2.5, photoSize + 5, photoSize + 5, 5, 5, "F");
    if (paolaImgDataUrl) {
      try {
        doc.addImage(paolaImgDataUrl, "JPEG", photoX, photoY, photoSize, photoSize);
      } catch (_) { /* si falla queda el marco */ }
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text("PAOLA SOTO", photoCardX + photoCardW / 2, photoY + photoSize + 12, { align: "center" });
    doc.setTextColor(...TEXT);

    // ========================================================
    // Premios: lista (1 hoja máx — se limita a los primeros MAX_PREMIOS)
    // ========================================================
    y += topH + 12;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.setTextColor(...TEXT);
    doc.text("PREMIOS", ML, y);
    doc.setDrawColor(...PURPLE);
    doc.setLineWidth(1.2);
    doc.line(ML, y + 3, ML + 60, y + 3);
    doc.setLineWidth(0.5);
    y += 16;

    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    doc.setTextColor(...TEXT);
    const MAX_PREMIOS = 20;
    const totalPremios = Array.isArray(lastPremios) ? lastPremios.length : 0;
    const premiosAListar = (Array.isArray(lastPremios) ? lastPremios : []).slice(0, MAX_PREMIOS);
    const hayMasDeCap = totalPremios > MAX_PREMIOS;
    // Normalizamos cada premio a {lugar, texto} y limpiamos puntuación colgante.
    const premiosNorm = premiosAListar.map((p, i) => {
      const lugar = fixText(p.lugar || `${i + 1}\u00B0`);
      let nombrePremio = fixText(p.nombre || p.descripcion || p.premio || "Premio");
      const tieneDesc = p.descripcion && p.nombre;
      // Quita ":" colgante al final si no hay descripcion detras.
      if (!tieneDesc) nombrePremio = nombrePremio.replace(/[:\s-]+$/, "");
      const desc = tieneDesc ? ` - ${fixText(p.descripcion)}` : "";
      return { lugar, texto: `${nombrePremio}${desc}` };
    });

    // Truncado a 1 línea con "…" si supera el ancho — garantiza altura predecible.
    const truncateToLine = (s, maxChars) => {
      const lineas = wrap(s, maxChars);
      if (lineas.length <= 1) return lineas[0] || "";
      return (lineas[0] || "").slice(0, Math.max(0, maxChars - 1)).trimEnd() + "\u2026";
    };

    if (premiosNorm.length) {
      const dosCols = premiosNorm.length > 8;
      if (dosCols) {
        // 2 columnas — SIEMPRE 1 línea por premio para caber en una hoja.
        const lineH = 11;
        const colGap = 16;
        const colW = (CW - colGap) / 2;
        const mitad = Math.ceil(premiosNorm.length / 2);
        const wrapChars = 46; // ~46 chars a 8.5pt helvetica en colW=258
        doc.setFontSize(8.5);
        let yL = y, yR = y;
        premiosNorm.forEach((p, i) => {
          const col = i < mitad ? 0 : 1;
          const xBase = col === 0 ? ML : ML + colW + colGap;
          const yCol = col === 0 ? yL : yR;
          doc.setFont("helvetica", "bold");
          doc.text(p.lugar, xBase + 4, yCol);
          doc.setFont("helvetica", "normal");
          doc.text(truncateToLine(p.texto, wrapChars), xBase + 26, yCol);
          if (col === 0) yL = yCol + lineH; else yR = yCol + lineH;
        });
        y = Math.max(yL, yR);
        doc.setFontSize(9.5);
      } else {
        // 1 columna full-width — también 1 línea por premio.
        const lineH = 12;
        const wrapChars = 95;
        premiosNorm.forEach((p) => {
          doc.setFont("helvetica", "bold");
          doc.text(p.lugar, ML + 4, y);
          doc.setFont("helvetica", "normal");
          doc.text(truncateToLine(p.texto, wrapChars), ML + 34, y);
          y += lineH;
        });
      }
    } else {
      doc.setTextColor(...MUTED);
      doc.text("Los premios se anunciaran pronto en la web de la rifa.", ML + 4, y);
      y += 12;
    }

    // Callout final morado al pie del listado
    y += 4;
    const calloutH = 22;
    doc.setFillColor(...PURPLE);
    doc.roundedRect(ML, y, CW, calloutH, 11, 11, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
    doc.setTextColor(255, 255, 255);
    const calloutMsg = hayMasDeCap
      ? "\u00A1Y MUCHOS PREMIOS M\u00C1S!  \u2022  Lista completa en rifa-paolasoto.vercel.app"
      : "Lista completa de premios tambien en rifa-paolasoto.vercel.app";
    doc.text(calloutMsg, ML + CW / 2, y + 14.5, { align: "center" });
    doc.setTextColor(...TEXT);
    y += calloutH + 10;

    // ========================================================
    // Tabla de números — SIEMPRE 1 a 15
    // ========================================================
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.setTextColor(...TEXT);
    doc.text(`TUS NUMEROS (01 al ${String(N).padStart(2, "0")})`, ML, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("Completa el nombre y telefono de cada comprador", ML + 230, y);
    y += 8;

    // Altura uniforme; con 2 columnas de premios la lista queda compacta y el pie siempre cabe.
    const rowH = 18;
    const colX = [ML, ML + 40, ML + 250, ML + 450];
    const colW = [40, 210, 200, CW - 450];

    // header
    doc.setFillColor(...PURPLE_SOFT);
    doc.setDrawColor(...PURPLE);
    doc.rect(ML, y, CW, rowH, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
    doc.setTextColor(...PURPLE);
    doc.text("N°", colX[0] + 12, y + 14);
    doc.text("NOMBRE DEL COMPRADOR", colX[1] + 6, y + 14);
    doc.text("TELEFONO", colX[2] + 6, y + 14);
    doc.text("PAGO", colX[3] + 6, y + 14);
    y += rowH;

    // rows — LOCALES 1..15, siempre. El talonario se distingue por su CODIGO.
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.5);
    for (let i = 1; i <= N; i++) {
      if (i % 2 === 0) {
        doc.setFillColor(250, 248, 255);
        doc.rect(ML, y, CW, rowH, "F");
      }
      doc.setDrawColor(...BORDER);
      doc.rect(ML, y, CW, rowH);
      doc.line(colX[1], y, colX[1], y + rowH);
      doc.line(colX[2], y, colX[2], y + rowH);
      doc.line(colX[3], y, colX[3], y + rowH);
      doc.setTextColor(...PURPLE);
      doc.setFont("helvetica", "bold");
      doc.text(String(i).padStart(2, "0"), colX[0] + 12, y + 14);
      y += rowH;
    }

    // Transferencia + instrucciones en 2 columnas
    y += 8;
    const boxH = 78;
    const colBoxW = (CW - 12) / 2;

    // Columna 1: datos de transferencia
    doc.setFillColor(250, 248, 255);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(ML, y, colBoxW, boxH, 6, 6, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setTextColor(...PURPLE);
    doc.text("DATOS DE TRANSFERENCIA", ML + 10, y + 16);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.setTextColor(...TEXT);
    let ty = y + 32;
    const lineasTransfer = [
      ["Banco:", "BancoEstado - CuentaRUT"],
      ["RUT:", "14.279.967-7"],
      ["Nombre:", "Paola Soto"],
      ["Email:", "Denisse.psoto89@gmail.com"],
    ];
    lineasTransfer.forEach(([k, v]) => {
      doc.setFont("helvetica", "bold");
      doc.text(k, ML + 10, ty);
      doc.setFont("helvetica", "normal");
      doc.text(v, ML + 48, ty);
      ty += 13;
    });

    // Columna 2: instrucciones
    const c2x = ML + colBoxW + 12;
    doc.setFillColor(245, 243, 255);
    doc.setDrawColor(...PURPLE);
    doc.roundedRect(c2x, y, colBoxW, boxH, 6, 6, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.setTextColor(...PURPLE);
    doc.text("CUANDO TERMINES DE VENDER", c2x + 10, y + 16);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.setTextColor(...TEXT);
    const instrucciones = [
      "Envia FOTO del talonario completo +",
      "comprobante a Denisse.psoto89@gmail.com",
      "Cada comprador verifica en la web:",
      "su nombre/numero debe aparecer pagado.",
    ];
    let iy = y + 32;
    instrucciones.forEach((ln) => {
      doc.text(ln, c2x + 10, iy);
      iy += 12;
    });

    y += boxH + 8;

    // Aviso anti-fraude
    doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.setTextColor(...PURPLE);
    doc.text("VERIFICACION ANTI-FRAUDE", PW / 2, y, { align: "center" });
    y += 10;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    doc.setTextColor(...TEXT);
    doc.text("Cada comprador puede confirmar su pago en la web: buscando su nombre o numero en la", PW / 2, y, { align: "center" });
    y += 10;
    doc.text("lista de participantes debe aparecer pagado y a cargo de " + fixText(nombre) + ".", PW / 2, y, { align: "center" });
    y += 12;

    // Footer contacto
    doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text("Dudas: Deny - Denisse.psoto89@gmail.com   \u2022   WhatsApp: +56 9 4596 1962", PW / 2, y, { align: "center" });
  }

  const safeNombre = nombre.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s-]/g, "").trim().replace(/\s+/g, "_");
  const filename = `Talonario_Rifa_Paola_${safeNombre || "vendedor"}.pdf`;

  // Extrae base64 ANTES de guardar. Algunos navegadores (iOS Safari) invalidan
  // el doc o devuelven un datauristring truncado. Probamos 2 rutas:
  //   1) output("datauristring") → split.
  //   2) fallback: output("blob") → FileReader.readAsDataURL.
  let pdfBase64 = "";
  try {
    const datauri = doc.output("datauristring");
    pdfBase64 = (datauri.split(",")[1] || "").trim();
  } catch (_) { pdfBase64 = ""; }

  if (!pdfBase64) {
    try {
      const blob = doc.output("blob");
      pdfBase64 = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => {
          const s = String(fr.result || "");
          resolve((s.split(",")[1] || "").trim());
        };
        fr.onerror = () => resolve("");
        fr.readAsDataURL(blob);
      });
    } catch (_) { /* queda vacío */ }
  }

  doc.save(filename);
  return { ok: true, pdfBase64, filename };
}

function buildMailtoTalonario({ nombre, correo, telefono, cantidad, codigos }) {
  const codes = Array.isArray(codigos) && codigos.length
    ? codigos
    : generarCodigosTalonarios(nombre, cantidad);
  const codigosStr = codes.join(", ");
  const subject = `Solicitud de talonario(s) — ${nombre}`;
  const body =
`Hola Deny,

Quiero hacerme cargo de ${cantidad} talonario(s) para vender en la rifa de Paola.

Mis datos:
- Nombre: ${nombre}
- Correo: ${correo}
- Teléfono: ${telefono}
- Cantidad: ${cantidad} talonario(s) (${cantidad * 15} números)

Talonario(s): ${codigosStr}.

Ya descargué mi talonario desde la web. Cuando termine de vender, te enviaré una foto del talonario y el comprobante de transferencia.

¡Gracias!`;
  return `mailto:Denisse.psoto89@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* Registrar la descarga + enviar PDF por correo.
   Estrategia dual-mode:
     1) Intenta POST same-origin a /api/descarga (Vercel Function). Respuesta JSON real.
     2) Si #1 falla con missing_env o de red, cae a Apps Script (legacy).
   Siempre guarda copia local por si ambas fallan. */
async function registrarDescarga(payload) {
  const entry = {
    ...payload,
    ua: navigator.userAgent.slice(0, 160),
  };

  try {
    const key = "rifa-descargas-local";
    const prev = JSON.parse(localStorage.getItem(key) || "[]");
    prev.push({ ...entry, timestamp: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(prev.slice(-50)));
  } catch {}

  if (!CONFIG.apiDescargaUrl) return { ok: false, reason: "no-endpoint" };
  try {
    const r = await fetch(CONFIG.apiDescargaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) return { ok: true, via: "vercel", mail: data.mail };
    return { ok: false, reason: data.error || `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

// Rate-limit simple: máximo 1 descarga cada 15s por navegador
function _rateLimitOk() {
  try {
    const last = Number(sessionStorage.getItem("rifa-tal-last") || 0);
    if (Date.now() - last < 15000) return false;
    sessionStorage.setItem("rifa-tal-last", String(Date.now()));
  } catch {}
  return true;
}

// Rate-limit independiente para el form de donación de premio
function _rateLimitOkPremio() {
  try {
    const last = Number(sessionStorage.getItem("rifa-pr-last") || 0);
    if (Date.now() - last < 15000) return false;
    sessionStorage.setItem("rifa-pr-last", String(Date.now()));
  } catch {}
  return true;
}

async function registrarPremio(payload) {
  const entry = {
    ...payload,
    type: "premio",
    ua: navigator.userAgent.slice(0, 160),
  };
  try {
    const key = "rifa-premios-local";
    const prev = JSON.parse(localStorage.getItem(key) || "[]");
    prev.push({ ...entry, timestamp: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(prev.slice(-50)));
  } catch {}

  if (!CONFIG.apiPremioUrl) return { ok: false, reason: "no-endpoint" };
  try {
    const r = await fetch(CONFIG.apiPremioUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) return { ok: true, via: "vercel" };
    return { ok: false, reason: data.error || `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

function wirePremioForm() {
  // Toggle desplegable de la sección
  const toggle = document.getElementById("donar-premio-toggle");
  const body   = document.getElementById("donar-premio-body");
  const chev   = document.getElementById("donar-premio-chevron");
  if (toggle && body) {
    toggle.addEventListener("click", () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      toggle.setAttribute("aria-expanded", String(!open));
      if (chev) chev.style.transform = open ? "" : "rotate(180deg)";
    });
  }

  const form = document.getElementById("premio-form");
  if (!form) return;
  const btn = document.getElementById("pr-submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn?.disabled) return;

    const nombre      = (document.getElementById("pr-nombre").value      || "").trim().slice(0, 80);
    const correo      = (document.getElementById("pr-correo").value      || "").trim().slice(0, 120);
    const telefono    = (document.getElementById("pr-telefono").value    || "").trim().slice(0, 30);
    const descripcion = (document.getElementById("pr-descripcion").value || "").trim().slice(0, 400);

    if (!nombre || nombre.length < 2 || !/^[\p{L}\s'.\-]{2,80}$/u.test(nombre)) {
      toast("Ingresa un nombre válido"); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 120) {
      toast("Correo no válido"); return;
    }
    const soloDigitos = telefono.replace(/\D/g, "");
    if (soloDigitos.length < 7 || soloDigitos.length > 15 || !/^[+\d\s().-]{7,30}$/.test(telefono)) {
      toast("Teléfono no válido (incluye código de país)"); return;
    }
    if (descripcion.length < 5) {
      toast("Describe brevemente el premio que quieres donar"); return;
    }
    if (!_rateLimitOkPremio()) { toast("Espera unos segundos antes de enviar otra propuesta"); return; }

    btn.disabled = true;
    const originalBtn = btn.innerHTML;
    btn.innerHTML = "Enviando…";

    try {
      const r = await registrarPremio({ nombre, correo, telefono, descripcion });
      if (r.ok) {
        toast("¡Gracias! Deny te va a contactar para coordinar 💜");
        form.reset();
      } else if (r.reason === "no-endpoint") {
        toast("Propuesta guardada localmente — falta configurar el endpoint.");
      } else {
        toast("No se pudo enviar. Escríbele directo a Deny.");
      }
    } finally {
      setTimeout(() => { btn.disabled = false; btn.innerHTML = originalBtn; }, 1500);
    }
  });
}

function wireTalonarioForm() {
  // Toggle desplegable de la sección "¿Te animas a vender un talonario?"
  const tToggle = document.getElementById("pedir-talonario-toggle");
  const tBody   = document.getElementById("pedir-talonario-body");
  const tChev   = document.getElementById("pedir-talonario-chevron");
  if (tToggle && tBody) {
    tToggle.addEventListener("click", () => {
      const open = tBody.style.display !== "none";
      tBody.style.display = open ? "none" : "block";
      tToggle.setAttribute("aria-expanded", String(!open));
      if (tChev) tChev.style.transform = open ? "" : "rotate(180deg)";
    });
  }

  const form = document.getElementById("talonario-form");
  if (!form) return;
  const btn = document.getElementById("tal-submit");
  const inputCant = document.getElementById("tal-cantidad");
  const hint = document.getElementById("tal-hint");
  const N = Math.max(1, Number(CONFIG.numerosPorRifa) || 15);

  // Persistencia local: los datos no se borran si recargás o cerrás la pestaña.
  const PERSIST_KEY = "rifa-talonario-form";
  const persistFields = ["tal-nombre", "tal-correo", "tal-telefono", "tal-cantidad"];
  try {
    const saved = JSON.parse(localStorage.getItem(PERSIST_KEY) || "{}");
    persistFields.forEach(id => {
      const el = document.getElementById(id);
      if (el && typeof saved[id] === "string" && saved[id].length) el.value = saved[id];
    });
  } catch (_) { /* ignore */ }
  const savePersist = () => {
    try {
      const data = {};
      persistFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) data[id] = el.value || "";
      });
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch (_) { /* ignore */ }
  };
  persistFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", savePersist);
  });

  const updateHint = () => {
    if (!hint || !inputCant) return;
    const n = Math.max(1, Math.min(100, Number(inputCant.value) || 1));
    const nums = n * N;
    const total = (nums * 1000).toLocaleString("es-CL");
    hint.textContent = `${n} talonario${n === 1 ? "" : "s"} = ${nums} números ($${total}) — números del 01 al ${String(N).padStart(2, "0")} en cada talonario`;
  };
  inputCant?.addEventListener("input", updateHint);
  updateHint();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn?.disabled) return;

    const nombre   = (document.getElementById("tal-nombre").value || "").trim().slice(0, 80);
    const correo   = (document.getElementById("tal-correo").value || "").trim().slice(0, 120);
    const telefono = (document.getElementById("tal-telefono").value || "").trim().slice(0, 30);
    const cantidadRaw = Number(document.getElementById("tal-cantidad").value) || 1;
    const cantidad = Math.max(1, Math.min(100, Math.floor(cantidadRaw)));

    if (!nombre || nombre.length < 2 || !/^[\p{L}\s'.\-]{2,80}$/u.test(nombre)) {
      toast("Ingresa un nombre válido"); return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 120) {
      toast("Correo no válido"); return;
    }
    // Teléfono: al menos 7 dígitos; permite +, espacios, guiones y paréntesis.
    const soloDigitos = telefono.replace(/\D/g, "");
    if (soloDigitos.length < 7 || soloDigitos.length > 15 || !/^[+\d\s().-]{7,30}$/.test(telefono)) {
      toast("Teléfono no válido (incluye código de país)"); return;
    }
    if (!_rateLimitOk()) { toast("Espera unos segundos antes de solicitar otro talonario"); return; }

    btn.disabled = true;
    const originalBtn = btn.innerHTML;
    btn.innerHTML = "Generando…";

    try {
      const codes = generarCodigosTalonarios(nombre, cantidad);

      const result = await buildTalonarioPDF({ nombre, correo, telefono, cantidad, codigos: codes });
      if (!result || !result.ok) { btn.disabled = false; btn.innerHTML = originalBtn; return; }

      // Registrar + mandar PDF por correo (vía Apps Script) — no bloqueante si falla
      registrarDescarga({
        nombre, correo, telefono, cantidad,
        codigos: codes.join(","),
        talonarioDesde: codes[0] || "",
        talonarioHasta: codes[codes.length - 1] || "",
        pdfBase64: result.pdfBase64,
        filename:  result.filename,
      }).then(r => {
        if (!r.ok && r.reason === "no-endpoint") {
          console.info("Registro/envío por correo: endpoint no configurado (guardado local).");
        }
      });

      if (result.pdfBase64) {
        showInfoModal(
          "¡Listo! Tu talonario fue enviado",
          "Enviamos el talonario a " + correo + ". Recuerda revisar tu bandeja de SPAM o correos no deseados si no lo ves en tu bandeja de entrada. ¡Gracias por ayudar!"
        );
      } else {
        showInfoModal(
          "Talonario descargado",
          "Tu talonario se descargó correctamente. El envío por correo puede demorar — recuerda revisar tu bandeja de SPAM o correos no deseados. ¡Gracias por ayudar!"
        );
      }
    } finally {
      setTimeout(() => { btn.disabled = false; btn.innerHTML = originalBtn; }, 1500);
    }
  });
}

/* ============================================================
   Admin: Descargas de talonarios (registro interno)
   ============================================================ */
function renderDescargas(rows) {
  const host = document.getElementById("descargas-view");
  const stats = document.getElementById("descargas-stats");
  if (!host) return;

  const list = Array.isArray(rows) ? rows : [];
  // Normaliza: acepta distintos nombres de columnas por si Apps Script difiere
  const norm = list.map(r => ({
    fecha:    r.fecha || r.timestamp || r.ts || "",
    nombre:   r.nombre || r.name || "",
    correo:   r.correo || r.email || "",
    telefono: r.telefono || r.teléfono || r.phone || "",
    cantidad: r.cantidad || r.qty || "",
    codigos:  r.codigos || "",
    desde:    r.desde || r.talonariodesde || "",
    hasta:    r.hasta || r.talonariohasta || "",
  }))
  .filter(r => r.nombre || r.correo || r.telefono)
  .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  const totalDescargas = norm.length;
  const totalTalonarios = norm.reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
  const totalNumeros = totalTalonarios * (Number(CONFIG.numerosPorRifa) || 15);

  if (stats) {
    stats.innerHTML = `
      <div class="stat"><div class="stat-num">${totalDescargas}</div><div class="stat-label">Descargas</div></div>
      <div class="stat"><div class="stat-num">${totalTalonarios}</div><div class="stat-label">Talonarios a cargo</div></div>
      <div class="stat"><div class="stat-num">${totalNumeros}</div><div class="stat-label">Números en venta</div></div>
    `;
  }

  if (!norm.length) {
    host.innerHTML = `<div class="descargas-empty">
      Aún no hay descargas registradas.<br>
      <small>Cuando alguien solicite un talonario desde la web, aparecerá aquí automáticamente.</small>
    </div>`;
    return;
  }

  const trs = norm.map(r => {
    const fechaStr = r.fecha ? new Date(r.fecha).toLocaleString("es-CL", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    }) : "—";
    const rango = r.codigos
      ? r.codigos
      : (r.desde && r.hasta && r.desde !== r.hasta ? `${r.desde} – ${r.hasta}` : (r.desde || "—"));
    return `<tr>
      <td>${esc(fechaStr)}</td>
      <td><strong>${esc(r.nombre)}</strong></td>
      <td><a href="mailto:${esc(r.correo)}" style="color:var(--brand);text-decoration:none;">${esc(r.correo)}</a></td>
      <td><a href="tel:${esc(String(r.telefono).replace(/[^+\d]/g, ""))}" style="color:var(--brand);text-decoration:none;">${esc(r.telefono)}</a></td>
      <td style="text-align:center;">${esc(r.cantidad)}</td>
      <td>${esc(rango)}</td>
    </tr>`;
  }).join("");

  host.innerHTML = `
    <div class="table-wrap">
      <table class="descargas-table">
        <thead><tr>
          <th>Fecha</th><th>Nombre</th><th>Correo</th><th>Teléfono</th><th>Cant.</th><th>Talonarios</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
}

async function loadDescargas() {
  if (!CONFIG.descargasSheet) return;
  try {
    const rows = await fetchSheet(CONFIG.descargasSheet);
    lastDescargas = rows;
    if (document.body.classList.contains("is-admin")) renderDescargas(rows);
    // Re-render del strip público con datos frescos
    renderNumeros(lastNumeros);
  } catch (e) {
    const host = document.getElementById("descargas-view");
    if (host) {
      host.innerHTML = `<div class="descargas-empty">
        No se pudo leer la pestaña <strong>"${esc(CONFIG.descargasSheet)}"</strong>.<br>
        <small>Asegúrate de que exista en el Google Sheet y que el Apps Script esté configurado.<br>
        Error: ${esc(e.message)}</small>
      </div>`;
    }
  }
}

/* ============================================================
   Init + auto-refresh
   ============================================================ */
async function load() {
  try {
    const tasks = [fetchSheet(CONFIG.numerosSheet)];
    if (CONFIG.premiosSheet) tasks.push(fetchSheet(CONFIG.premiosSheet).catch(() => []));
    if (CONFIG.descargasSheet) tasks.push(fetchSheet(CONFIG.descargasSheet).catch(() => []));
    const [numeros, premios = [], descargas = []] = await Promise.all(tasks);
    lastDescargas = descargas;
    renderPremios(premios);
    renderNumeros(numeros);
    if (document.body.classList.contains("is-admin")) renderDescargas(descargas);
    loadFotosTalonarios();
    const now = new Date();
    document.getElementById("updated").textContent = "Actualizado: " + now.toLocaleString("es-CL");
  } catch (e) {
    document.getElementById("premios").innerHTML =
      `<div class="state error"><span class="emoji">⚠️</span>No se pudo leer el Sheet. Verifica que esté compartido como "Cualquiera con el enlace".<br><small>${esc(e.message)}</small></div>`;
    const tv = document.getElementById("table-view");
    if (tv) tv.innerHTML =
      `<div class="state error"><span class="emoji">⚠️</span>Error al cargar los participantes.</div>`;
  }
}

function wireVerificarShortcut() {
  const link = document.querySelector(".verificar-go");
  if (!link) return;
  link.addEventListener("click", (e) => {
    const target = document.getElementById("participantes");
    const input = document.getElementById("search");
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => { input?.focus({ preventScroll: true }); }, 450);
  });
}

function init() {
  document.getElementById("titulo").textContent = CONFIG.titulo;
  document.getElementById("brand-title").textContent = CONFIG.titulo;
  document.getElementById("subtitulo").textContent = CONFIG.subtitulo;
  initTheme();
  wireSearch();
  wireTransferCopy();
  wireTalonarioForm();
  wirePremioForm();
  wireVerificarShortcut();
  document.getElementById("refresh-btn").addEventListener("click", () => {
    toast("Actualizando…"); load();
  });
  document.getElementById("refresh-descargas")?.addEventListener("click", () => {
    toast("Actualizando descargas…"); loadDescargas();
  });
  checkAdmin().then(load);
  if (CONFIG.autoRefreshMs > 0) setInterval(load, CONFIG.autoRefreshMs);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
