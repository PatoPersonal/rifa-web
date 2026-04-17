/* ============================================================
   CONFIGURACIÓN — editar sólo aquí
   ============================================================ */
const CONFIG = {
  titulo: "Gran Rifa",
  subtitulo: "Números pagados, premios y toda la info del sorteo — actualizado en vivo.",

  // ID de la Google Sheet (entre /d/ y /edit en la URL)
  sheetId: "1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E",

  // Nombres EXACTOS de las pestañas del Sheet (case-sensitive).
  numerosSheet: "Numeros",
  premiosSheet: "Premios",

  // Estructura en bloques: 7 rifas (talonarios) × 15 números cada uno = 105
  rifasCount: 7,
  numerosPorRifa: 15,

  // Hash SHA-256 de la clave admin (la clave real NUNCA va aquí en texto plano).
  // Para cambiarla: node -e "console.log(require('crypto').createHash('sha256').update('TU_CLAVE').digest('hex'))"
  adminKeyHash: "609b54cac6d4d1a541446402a4f244100b5244ff0065d17c7bcb6000437def79",

  // Refresco automático (ms). 0 para desactivar.
  autoRefreshMs: 60000,
};

/* ============================================================
   Sheet URLs (usan /gviz/tq para mejor compatibilidad)
   Requiere que el Sheet esté compartido como "Cualquiera con el enlace".
   ============================================================ */
const sheetCsvUrl = (sheetName) =>
  `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&_=${Date.now()}`;
const sheetWebUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/edit`;

/* ============================================================
   Parser CSV (soporta comillas y comas dentro de campos)
   ============================================================ */
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { q = false; }
      else { field += c; }
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") {}
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}
function toObjects(rows) {
  if (!rows.length) return [];
  const h = rows[0].map(s => s.trim().toLowerCase());
  return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] || "").trim()])));
}
async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Sheet ${res.status}`);
  return toObjects(parseCSV(await res.text()));
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
function renderPremios(list) {
  const el = document.getElementById("premios");
  if (!list || !list.length) {
    el.innerHTML = `<div class="state"><span class="emoji">🎁</span>Los premios se anunciarán pronto.</div>`;
    return;
  }
  el.innerHTML = list.map((p, i) => {
    const lugar = p.lugar || p.premio || `#${i + 1}`;
    const nombre = p.nombre || p.descripcion || p.premio || "Premio";
    const desc = (p.descripcion && p.nombre) ? p.descripcion : "";
    const ganador = p.ganador || "";
    const medalClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
    const medalEmoji = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🎁";
    return `
      <div class="premio ${i < 3 ? "top" : ""}">
        <span class="medal ${medalClass}">${medalEmoji} ${esc(lugar)}</span>
        <h3>${esc(nombre)}</h3>
        ${desc ? `<p>${esc(desc)}</p>` : ""}
        ${ganador ? `<div class="winner">🎉 Ganador: ${esc(ganador)}</div>` : ""}
      </div>`;
  }).join("");
}

/* ============================================================
   Render: Números (stats, hero ring, grid, table, admin)
   ============================================================ */
let lastNumeros = [];

function renderNumeros(list) {
  lastNumeros = list;

  const R = Math.max(1, Number(CONFIG.rifasCount) || 7);
  const N = Math.max(1, Number(CONFIG.numerosPorRifa) || 15);
  const total = R * N;

  // Normaliza cada fila a { rifa, local, comprador, status }
  function normalize(n) {
    const raw = Number((n.numero || n.número || "").toString().replace(/\D/g, ""));
    let rifa = Number((n.rifa || "").toString().replace(/\D/g, ""));
    let local = raw;
    if (!rifa && raw > 0) {
      rifa = Math.ceil(raw / N);
      local = ((raw - 1) % N) + 1;
    } else if (rifa && raw > N) {
      // fallback: si alguien puso número global también
      local = ((raw - 1) % N) + 1;
    }
    return {
      rifa, local,
      comprador: n.comprador || n.nombre || "",
      fecha: n.fecha || "",
      status: classify(n.pagado || n.estado || n.status),
      raw: n,
    };
  }
  const rows = list.map(normalize).filter(r => r.rifa > 0 && r.rifa <= R && r.local > 0 && r.local <= N);

  // Mapa (rifa, local) → row
  const key = (r, l) => `${r}-${l}`;
  const map = new Map();
  rows.forEach(r => map.set(key(r.rifa, r.local), r));

  const paidCount = rows.filter(r => r.status === "paid").length;
  const reservedCount = rows.filter(r => r.status === "reserved").length;
  const freeCount = Math.max(0, total - paidCount - reservedCount);
  const pct = Math.round((paidCount / total) * 100);

  // Hero chips + ring
  document.getElementById("chip-paid").textContent = `${paidCount} pagado${paidCount === 1 ? "" : "s"}`;
  document.getElementById("ring-pct").textContent = `${pct}%`;
  document.getElementById("ring-sub").textContent = `${paidCount} / ${total}`;
  const ring = document.getElementById("ring");
  const C = 2 * Math.PI * 52;
  ring.setAttribute("stroke-dasharray", C.toFixed(1));
  ring.setAttribute("stroke-dashoffset", (C * (1 - paidCount / total)).toFixed(1));

  // Stats
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-num">${paidCount}</div><div class="stat-label">Pagados</div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div></div>
    <div class="stat"><div class="stat-num">${reservedCount}</div><div class="stat-label">Reservados</div></div>
    <div class="stat"><div class="stat-num">${freeCount}</div><div class="stat-label">Libres</div></div>
    <div class="stat"><div class="stat-num">${R} × ${N}</div><div class="stat-label">Talonarios</div></div>
  `;

  const isAdmin = document.body.classList.contains("is-admin");

  // Render de bloques (talonarios)
  const blocks = [];
  for (let r = 1; r <= R; r++) {
    const cells = [];
    let blockPaid = 0;
    for (let i = 1; i <= N; i++) {
      const rec = map.get(key(r, i));
      const status = rec ? rec.status : "free";
      if (status === "paid") blockPaid++;
      const comprador = rec?.comprador || "";
      const pad = String(i).padStart(String(N).length, "0");
      const tip = status === "paid"
        ? `Rifa ${r} · N° ${pad} — ${comprador || "pagado"}`
        : status === "reserved"
          ? `Rifa ${r} · N° ${pad} — reservado${comprador ? " · " + comprador : ""}`
          : `Rifa ${r} · N° ${pad} — libre`;
      cells.push(`<div class="num-cell ${status}" data-search="${esc((r + "-" + i + " " + i + " " + comprador).toLowerCase())}" title="${esc(tip)}">${pad}</div>`);
    }
    blocks.push(`
      <div class="rifa-block" data-rifa="${r}">
        <div class="rifa-head">
          <div class="rifa-title"><span class="pill">${r}</span> Talonario</div>
          <div class="rifa-meta">${blockPaid}/${N} pagados</div>
        </div>
        <div class="rifa-cells">${cells.join("")}</div>
      </div>`);
  }
  document.getElementById("grid-view").innerHTML = `<div class="rifas-grid">${blocks.join("")}</div>`;

  // Tabla detalle (solo pagados + reservados — o todos si admin)
  const visible = rows
    .filter(r => isAdmin || r.status !== "free")
    .sort((a, b) => a.rifa - b.rifa || a.local - b.local);

  if (!visible.length) {
    document.getElementById("table-view").innerHTML = `<div class="state"><span class="emoji">🕒</span>Aún no hay números pagados.</div>`;
  } else {
    const trs = visible.map(r => {
      const cls = r.status === "paid" ? "" : "pending";
      const etiq = r.status === "paid" ? "Pagado" : r.status === "reserved" ? "Reservado" : "Libre";
      const pad = String(r.local).padStart(String(N).length, "0");
      const primerNombre = (r.comprador || "").trim().split(/\s+/)[0] || "";
      return `
        <tr data-search="${esc(((r.rifa + "-" + r.local + " " + r.local + " " + r.comprador)).toLowerCase())}" data-status="${r.status}">
          <td><strong>${r.rifa}</strong></td>
          <td><span class="num-badge ${cls}">${pad}</span></td>
          <td>${esc(primerNombre || "—")}</td>
          <td>${esc(r.fecha)}</td>
          <td>${etiq}</td>
        </tr>`;
    }).join("");
    document.getElementById("table-view").innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Rifa</th><th>Número</th><th>Comprador</th><th>Fecha</th><th>Estado</th></tr></thead>
        <tbody id="tbody">${trs}</tbody>
      </table></div>`;
  }

  // Admin panel
  if (isAdmin) {
    const recaudado = paidCount * 1000;
    document.getElementById("admin-stats").innerHTML = `
      <div class="stat"><div class="stat-num">${paidCount}</div><div class="stat-label">Pagados</div></div>
      <div class="stat"><div class="stat-num">${reservedCount}</div><div class="stat-label">Reservados</div></div>
      <div class="stat"><div class="stat-num">${freeCount}</div><div class="stat-label">Libres</div></div>
      <div class="stat"><div class="stat-num">$${recaudado.toLocaleString("es-CL")}</div><div class="stat-label">Recaudado</div></div>
    `;
    // Libres agrupados por rifa
    const libresPorRifa = [];
    for (let r = 1; r <= R; r++) {
      const libres = [];
      for (let i = 1; i <= N; i++) {
        const rec = map.get(key(r, i));
        if (!rec || rec.status === "free") libres.push(String(i).padStart(String(N).length, "0"));
      }
      if (libres.length) libresPorRifa.push(`<div style="margin-bottom:8px;"><strong>Rifa ${r}:</strong> ${libres.join(", ")}</div>`);
    }
    document.getElementById("admin-libres").innerHTML = libresPorRifa.length
      ? `<div style="padding:14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;font-size:14px;line-height:1.7;">${libresPorRifa.join("")}</div>`
      : `<div class="state"><span class="emoji">🎉</span>¡Todos los números vendidos!</div>`;
    document.getElementById("open-sheet").href = sheetWebUrl;
  }
}

/* ============================================================
   Búsqueda + toggles
   ============================================================ */
function wireSearch() {
  const input = document.getElementById("search");
  const handler = () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll("#tbody tr").forEach(tr => {
      tr.style.display = !q || tr.dataset.search.includes(q) ? "" : "none";
    });
    document.querySelectorAll(".num-cell").forEach(c => {
      const match = !q || c.dataset.search.includes(q);
      c.style.opacity = match ? "" : ".2";
      c.classList.toggle("hit", !!q && match && c.classList.contains("paid"));
    });
  };
  input.addEventListener("input", handler);
}

function wireViewToggle() {
  document.querySelectorAll("#view-toggle button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#view-toggle button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const view = b.dataset.view;
      document.getElementById("grid-view").style.display = view === "grid" ? "" : "none";
      document.getElementById("table-view").style.display = view === "table" ? "" : "none";
    });
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
   Init + auto-refresh
   ============================================================ */
async function load() {
  try {
    const tasks = [fetchCsv(sheetCsvUrl(CONFIG.numerosSheet))];
    if (CONFIG.premiosSheet) tasks.push(fetchCsv(sheetCsvUrl(CONFIG.premiosSheet)).catch(() => []));
    const [numeros, premios = []] = await Promise.all(tasks);
    renderNumeros(numeros);
    renderPremios(premios);
    const now = new Date();
    document.getElementById("updated").textContent = "Actualizado: " + now.toLocaleString("es-CL");
    document.getElementById("chip-date").textContent = now.toLocaleDateString("es-CL", { day:"2-digit", month:"short" });
  } catch (e) {
    document.getElementById("premios").innerHTML =
      `<div class="state error"><span class="emoji">⚠️</span>No se pudo leer el Sheet. Verifica que esté compartido como "Cualquiera con el enlace".<br><small>${esc(e.message)}</small></div>`;
    document.getElementById("grid-view").innerHTML =
      `<div class="state error"><span class="emoji">⚠️</span>Error al cargar los números.</div>`;
  }
}

function init() {
  document.getElementById("titulo").textContent = CONFIG.titulo;
  document.getElementById("brand-title").textContent = CONFIG.titulo;
  document.getElementById("subtitulo").textContent = CONFIG.subtitulo;
  initTheme();
  wireSearch();
  wireViewToggle();
  wireTransferCopy();
  document.getElementById("refresh-btn").addEventListener("click", () => {
    toast("Actualizando…"); load();
  });
  checkAdmin().then(load);
  if (CONFIG.autoRefreshMs > 0) setInterval(load, CONFIG.autoRefreshMs);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
