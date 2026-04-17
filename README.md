# Gran Rifa — Web

Web estática de 1 archivo que muestra premios y números pagados, con auto-actualización desde Google Sheets y panel admin opcional. Lista para subir a Vercel.

---

## 1. Compartir el Sheet

Abre tu Google Sheet:
`https://docs.google.com/spreadsheets/d/1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E/edit`

1. Clic en **Compartir** (arriba a la derecha).
2. En "Acceso general" elige **Cualquier persona con el enlace → Lector**.
3. Guardar.

> Ya no necesitas "Publicar en la web". La app lee el CSV directo con la API `gviz`.

---

## 2. Estructura del Sheet

### Pestaña `Numeros` (gid=0, la primera por defecto)

| numero | comprador       | pagado | fecha      |
|--------|-----------------|--------|------------|
| 7      | Juan Pérez      | si     | 2026-04-10 |
| 23     | María González  | si     | 2026-04-12 |
| 45     | Pedro Soto      | reservado |         |

- **pagado** acepta: `si`, `sí`, `x`, `ok`, `true`, `1`, `pagado`
- También acepta `reservado` / `pendiente` (se muestra en naranjo).
- Cualquier otro valor (o vacío) = libre.

### Pestaña `Premios` (opcional)

| lugar  | nombre            | descripcion             | ganador |
|--------|-------------------|-------------------------|---------|
| 1°     | Televisor 50"     | Smart TV 4K             |         |
| 2°     | Canasta familiar  | Productos de almacén    |         |

- Los 3 primeros se destacan con medalla 🥇🥈🥉.
- La columna `ganador` se llena después del sorteo.

> Los encabezados deben ir en la **primera fila**, en minúsculas.

---

## 3. Configurar `index.html`

Abre `index.html` y edita el bloque `CONFIG` al inicio del `<script>`:

```js
const CONFIG = {
  titulo: "Gran Rifa",
  subtitulo: "Números pagados, premios y toda la info del sorteo — actualizado en vivo.",
  sheetId: "1vLJyh4aALhtmrYLhXpPcTvuamV8VLMzZtsoIgH0xH5E",
  numerosSheet: "Numeros",   // nombre exacto de la pestaña
  premiosSheet: "Premios",   // nombre exacto de la pestaña (o "" si no existe)
  totalNumeros: 100,         // total de números de la rifa
  adminKey: "rifa2026",      // ⚠️ cámbialo antes de subir a Vercel
  autoRefreshMs: 60000,      // refresco automático cada 60s
};
```

> Los nombres de pestaña son **case-sensitive**. Si la tuya se llama "Números" (con tilde) o "numeros" (minúsculas), cópialo tal cual.

---

## 4. Panel admin

Accede a `https://tu-dominio.com/?admin=rifa2026` (usando la `adminKey` que configuraste).

El panel muestra:
- Números libres listados
- Botón para copiarlos (útil para mandar por WhatsApp)
- Enlace directo al Google Sheet
- Tabla completa incluyendo libres

La sesión queda guardada hasta cerrar la pestaña. Botón **Salir** arriba a la derecha del panel.

> Es seguridad "suave" (la clave vive en el HTML). No uses datos sensibles aquí — el sheet mismo ya es público.

---

## 5. Probar local

Cualquier servidor estático sirve:

```bash
cd rifa-web
npx serve .
# o
python -m http.server 8080
```

Abre http://127.0.0.1:8080/

---

## 6. Subir a Vercel

### Opción A — Vercel CLI (rápido)
```bash
npm i -g vercel
cd rifa-web
vercel        # primera vez, preview
vercel --prod # producción
```

### Opción B — GitHub + Vercel (recomendada)
1. Sube la carpeta `rifa-web/` a un repositorio de GitHub.
2. En [vercel.com/new](https://vercel.com/new) importa el repo.
3. Framework: **Other**. Root directory: `rifa-web` (o raíz si ya lo pusiste ahí). Build command: *vacío*. Output directory: *vacío*.
4. Deploy.

`vercel.json` ya tiene configurados los headers de no-cache para que los cambios del sheet se vean de inmediato.

---

## Qué se actualiza solo
- Se recargan los datos cada **60 segundos** (configurable en `autoRefreshMs`).
- Botón de refresco manual (↻) siempre disponible.
- Cada carga añade `?_=timestamp` al URL del CSV para saltar cualquier caché.

## Stack
- 1 solo archivo `index.html` (HTML + CSS + JS vanilla). Sin build, sin dependencias.
- Fuente Plus Jakarta Sans desde Google Fonts.
- Modo claro/oscuro con persistencia.
