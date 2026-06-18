import { useState, useMemo, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import html2canvas from "html2canvas";
import { loadAll, saveAll } from "./sync";

/* ═══════════════════════════════════════════════════════════════
   REPARTO DE VIAJES · FÁBRICA · MEJILLÓN
   Modelo: cada batea = 1 posición = 1 viaje. Lista única (sin
   calidades). Las bateas se organizan por POLÍGONO. Los cierres
   administrativos se aplican a un polígono completo.
   ═══════════════════════════════════════════════════════════════ */

const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=DM+Mono:wght@400;500&family=Barlow:wght@400;500;600&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Barlow', sans-serif; background: #0f1923; }
    .mono { font-family: 'DM Mono', monospace; }
    .cond { font-family: 'Barlow Condensed', sans-serif; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #1a2a3a; }
    ::-webkit-scrollbar-thumb { background: #2d4a6a; border-radius: 3px; }
    .fade-in { animation: fadeIn .25s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    input, select { color-scheme: dark; }
    @media print {
      body { background: white !important; }
      .no-print { display: none !important; }
    }
  `}</style>
);

/* ── LÓGICA DE NEGOCIO ─────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9);
const hoy = () => new Date().toISOString().slice(0, 10);
const recalc = (arr) => arr.map((b, i) => ({ ...b, posicion: i + 1 }));

// ¿El polígono tiene un cierre activo?
const poligonoCerrado = (poligonoId, cierres) =>
  cierres.some((c) => c.poligonoId === poligonoId && !c.fechaFin);

// ¿El barco está excluido (sin producto)?
const barcoExcluido = (barcoId, exclusiones) =>
  exclusiones.some((e) => e.barcoId === barcoId && !e.fechaFin);

// ¿La batea participa en el reparto ahora mismo?
function bateaActiva(batea, barcos, cierres, exclusiones) {
  const b = barcos.find((x) => x.id === batea.barcoId);
  if (!b || !b.activo) return false;
  if (barcoExcluido(batea.barcoId, exclusiones)) return false;
  if (poligonoCerrado(batea.poligonoId, cierres)) return false;
  return true;
}

// Viajes que tienen que salir antes de que le toque a esta batea/posición.
// reales = solo bateas activas por delante · posibles = todas (incluye inactivas
// por si se reactivan barcos sin producto o se reabren polígonos).
function viajesParaQueLeToque(batea, bateas, barcos, cierres, exclusiones) {
  let reales = 0, posibles = 0;
  bateas
    .filter((x) => x.posicion < batea.posicion)
    .forEach((x) => {
      posibles += 1;
      if (bateaActiva(x, barcos, cierres, exclusiones)) reales += 1;
    });
  return { reales, posibles };
}

// Cálculo automático de viajes acumulados al reabrir un polígono.
// Mientras el polígono estuvo cerrado, los demás siguieron sacando viajes;
// se compensa a cada batea cerrada con su parte proporcional.
// (Σ viajes servidos en la ventana ÷ bateas que quedaron abiertas)
function calcViajesAcumulados(cierre, fechaFin, cierres, bateas, historial) {
  if (!cierre || !fechaFin) return { totalViajes: 0, abiertas: 0, rate: 0, porBatea: 0, nBateas: 0, total: 0 };
  const cierreTs = cierre.createdTs || 0;
  const finTs = new Date(fechaFin + "T23:59:59").getTime();

  const totalViajes = historial
    .filter((p) => (p.ts || 0) > cierreTs && (p.ts || 0) <= finTs)
    .reduce((s, p) => s + p.lineas.reduce((ss, l) => ss + (l.viajes || 0), 0), 0);

  const totalBateas = bateas.length;
  // Bateas que estuvieron cerradas durante la ventana (polígonos con cierre solapado)
  const poligonosCerradosVentana = new Set(
    cierres
      .filter((c) => {
        const cFin = c.fechaFin ? new Date(c.fechaFin + "T23:59:59").getTime() : finTs;
        return (c.createdTs || 0) <= finTs && cFin >= cierreTs;
      })
      .map((c) => c.poligonoId)
  );
  const cerradas = bateas.filter((b) => poligonosCerradosVentana.has(b.poligonoId)).length;
  const abiertas = Math.max(0.5, totalBateas - cerradas);
  const rate = totalViajes > 0 ? totalViajes / abiertas : 0;
  const porBatea = Math.round(rate);
  const nBateas = bateas.filter((b) => b.poligonoId === cierre.poligonoId).length;
  return { totalViajes, abiertas, rate: Math.round(rate * 10) / 10, porBatea, nBateas, total: porBatea * nBateas };
}

/* ── DATOS DEMO ────────────────────────────────────────────── */
const DEMO_POLIGONOS = [
  { id: "pA", nombre: "Polígono A — Vilagarcía" },
  { id: "pB", nombre: "Polígono B — O Grove" },
  { id: "pC", nombre: "Polígono C — Cambados" },
];
const DEMO_BARCOS = [
  { id: "b1", nombre: "Rías Baixas", pin: "1111", activo: true },
  { id: "b2", nombre: "A Marola", pin: "2222", activo: true },
  { id: "b3", nombre: "Corrubedo", pin: "3333", activo: true },
  { id: "b4", nombre: "Ondina", pin: "4444", activo: true },
  { id: "b5", nombre: "Sálvora", pin: "5555", activo: true },
];
// Bateas iniciales (cada una = una posición/viaje). Mezcladas en round-robin.
const DEMO_BATEAS_DEF = [
  { barcoId: "b1", poligonoId: "pA" },
  { barcoId: "b2", poligonoId: "pA" },
  { barcoId: "b3", poligonoId: "pB" },
  { barcoId: "b4", poligonoId: "pC" },
  { barcoId: "b5", poligonoId: "pA" },
  { barcoId: "b1", poligonoId: "pA" },
  { barcoId: "b2", poligonoId: "pC" },
  { barcoId: "b3", poligonoId: "pB" },
  { barcoId: "b5", poligonoId: "pB" },
  { barcoId: "b1", poligonoId: "pB" },
  { barcoId: "b3", poligonoId: "pC" },
];
function initBateas() {
  return recalc(
    DEMO_BATEAS_DEF.map((d) => ({
      id: uid(), barcoId: d.barcoId, poligonoId: d.poligonoId,
      posicion: 0, viajesAcum: 0, rechazosAcum: 0,
      media: false, mediaSalta: false,
    }))
  );
}

/* ── DESIGN TOKENS ─────────────────────────────────────────── */
const C = {
  bg: "#0f1923", surface: "#111e2b", border: "#1e3348", border2: "#2d4a6a",
  navy: "#1a2f45", accent: "#f59e0b", accentL: "#fbbf24",
  blue: "#3b82f6", green: "#10b981", red: "#ef4444", violet: "#8b5cf6",
  orange: "#f97316", text: "#e2eaf4", textMid: "#7a99b8", textDim: "#4a6882",
};

/* ── COMPONENTES BASE ──────────────────────────────────────── */
function Btn({ children, onClick, color = C.blue, outline = false, small = false, disabled = false, style = {}, className }) {
  return (
    <button onClick={disabled ? undefined : onClick} className={className} style={{
      background: outline ? "transparent" : disabled ? "#1e3348" : color,
      color: disabled ? C.textDim : outline ? C.textMid : "#fff",
      border: outline ? `1px solid ${C.border2}` : disabled ? `1px solid ${C.border}` : "none",
      padding: small ? "5px 12px" : "8px 18px", borderRadius: 8,
      fontSize: small ? 12 : 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontFamily: "'Barlow', sans-serif", opacity: disabled ? 0.5 : 1, ...style,
    }}>{children}</button>
  );
}
function Input({ value, onChange, type = "text", placeholder, style = {}, ...rest }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ background: C.navy, border: `1px solid ${C.border2}`, color: C.text,
        padding: "8px 12px", borderRadius: 8, fontSize: 13,
        fontFamily: "'Barlow', sans-serif", outline: "none", width: "100%", ...style }}
      {...rest} />
  );
}
function Sel({ value, onChange, children, style = {} }) {
  return (
    <select value={value} onChange={onChange}
      style={{ background: C.navy, border: `1px solid ${C.border2}`, color: C.text,
        padding: "8px 12px", borderRadius: 8, fontSize: 13,
        fontFamily: "'Barlow', sans-serif", outline: "none", width: "100%", ...style }}>
      {children}
    </select>
  );
}
function Card({ children, style = {} }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>
      {children}
    </div>
  );
}
function SectionTitle({ children, style = {} }) {
  return (
    <div className="cond" style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: "0.02em", marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}
function Label({ children }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
      {children}
    </div>
  );
}
function EstadoBadge({ tipo }) {
  const cfg = {
    le_toca:   { bg: "#2d1f00", text: C.accentL, dot: C.accent, label: "¡Le toca!" },
    en_espera: { bg: "#1a2f45", text: C.textMid, dot: C.blue,   label: "En espera" },
    cierre:    { bg: "#1a0505", text: C.red,     dot: C.red,    label: "🔒 En cierre" },
    excluido:  { bg: "#1e1040", text: C.violet,  dot: C.violet, label: "🚫 Sin producto" },
  }[tipo] || { bg: "#1a2f45", text: C.textMid, dot: C.blue, label: "En espera" };
  return (
    <span style={{ background: cfg.bg, color: cfg.text, padding: "2px 10px", borderRadius: 20,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
      display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${cfg.dot}30` }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: cfg.dot, display: "inline-block" }} />
      {cfg.label}
    </span>
  );
}
function DataTable({ cols, rows, empty = "Sin datos" }) {
  return (
    <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ background: "#0a1520", color: C.textDim, padding: "10px 14px",
                textAlign: c.right ? "right" : c.center ? "center" : "left",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} style={{ padding: 40, textAlign: "center", color: C.textDim, fontSize: 13 }}>{empty}</td></tr>
          ) : rows.map((row, i) => (
            <tr key={row._key ?? i} style={{ background: i % 2 === 0 ? C.surface : C.bg, borderBottom: `1px solid ${C.border}` }}>
              {cols.map((c) => (
                <td key={c.key} style={{ padding: "10px 14px", textAlign: c.right ? "right" : c.center ? "center" : "left", fontSize: 13, color: C.text }}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const AnchorLogo = ({ size = 32, op = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48">
    <rect x="8" y="14" width="32" height="5" rx="1.5" fill="#f59e0b" opacity={op}/>
    <line x1="13" y1="19" x2="13" y2="40" stroke="#3b82f6" strokeWidth="1.6" opacity={op}/>
    <line x1="19" y1="19" x2="19" y2="44" stroke="#3b82f6" strokeWidth="1.6" opacity={op}/>
    <line x1="24" y1="19" x2="24" y2="42" stroke="#3b82f6" strokeWidth="1.6" opacity={op}/>
    <line x1="29" y1="19" x2="29" y2="44" stroke="#3b82f6" strokeWidth="1.6" opacity={op}/>
    <line x1="35" y1="19" x2="35" y2="40" stroke="#3b82f6" strokeWidth="1.6" opacity={op}/>
    <path d="M4 44 Q12 40 20 44 T36 44 T52 44" fill="none" stroke="#7a99b8" strokeWidth="1.5" opacity={0.6 * op}/>
  </svg>
);

/* ── EXPORTAR LISTA: HTML compartido para Imprimir/PDF e Imagen ── */
function buildListaHTML(bateas, barcos, poligonos, cierres, exclusiones, forImage) {
  const filas = bateas.map((bt, i) => {
    const b = barcos.find((x) => x.id === bt.barcoId);
    const pol = poligonos.find((p) => p.id === bt.poligonoId);
    const enCierre = poligonoCerrado(bt.poligonoId, cierres);
    const excl = barcoExcluido(bt.barcoId, exclusiones);
    const { reales, posibles } = viajesParaQueLeToque(bt, bateas, barcos, cierres, exclusiones);
    const estado = enCierre ? "EN CIERRE" : excl ? "SIN PRODUCTO" : reales === 0 ? "¡LE TOCA!" : "En espera";
    const acum = bt.viajesAcum > 0 ? ` <small style="color:#a05a00">★ ${bt.viajesAcum} acum.</small>` : "";
    const faltanTxt = posibles !== reales
      ? `${reales} <small style="color:#888">(${posibles} pos.)</small>`
      : `${reales}`;
    const bg = excl || enCierre ? "background:#efe9f7" : i % 2 === 1 ? "background:#f5f5f5" : "";
    return `<tr style="${bg}">
      <td style="text-align:center;font-weight:700;font-size:15px">${bt.posicion}</td>
      <td><strong>${b?.nombre ?? "—"}</strong>${acum}</td>
      <td>${pol?.nombre ?? "—"}</td>
      <td style="text-align:right;font-weight:700">${faltanTxt}</td>
      <td>${estado}</td>
    </tr>`;
  }).join("");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
    <title>Lista de Reparto de Viajes — ${hoy()}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; color:#000; margin:${forImage ? "0" : "20px"}; ${forImage ? "width:720px;padding:24px;background:#fff;" : ""} }
      h1 { font-size:18px; margin-bottom:2px; color:#1a3a5c; }
      p { font-size:12px; color:#555; margin:0 0 16px; }
      table { width:100%; border-collapse:collapse; }
      th { background:#1a3a5c; color:#fff; padding:8px 10px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
      th.r { text-align:right; } th.c { text-align:center; }
      td { padding:8px 10px; border-bottom:1px solid #ddd; vertical-align:middle; }
      .leyenda { font-size:10px; color:#777; margin-top:12px; }
    </style></head><body id="cap">
    <h1>Lista de Reparto de Viajes</h1>
    <p>Asociación de Productores de Mejillón &nbsp;·&nbsp; Fábrica &nbsp;·&nbsp; ${hoy()} &nbsp;·&nbsp; ${bateas.length} posiciones (1 batea = 1 viaje)</p>
    <table>
      <thead><tr><th class="c">#</th><th>Barco</th><th>Polígono</th><th class="r">Viajes para que le toque</th><th>Estado</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="leyenda">Viajes para que le toque = nº de viajes que tienen que salir de las posiciones por delante. La cifra principal cuenta solo posiciones activas; (pos.) incluye polígonos cerrados y barcos sin producto por si se reactivan.</div>
  </body></html>`;
}

function imprimirLista(...args) {
  const html = buildListaHTML(...args, false).replace("</body>", "<scr" + "ipt>window.onload=()=>window.print();</scr" + "ipt></body>");
  const win = window.open("", "_blank", "width=900,height=700");
  if (win) { win.document.write(html); win.document.close(); }
  else alert("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para imprimir/guardar PDF.");
}

async function descargarImagen(...args) {
  const html = buildListaHTML(...args, true);
  const cont = document.createElement("div");
  cont.style.cssText = "position:fixed;left:-9999px;top:0;";
  cont.innerHTML = html.replace(/<!DOCTYPE[\s\S]*?<body id="cap">/, '<div id="cap" style="width:720px;padding:24px;background:#fff;font-family:Arial,sans-serif;font-size:13px;color:#000">').replace("</body></html>", "</div>");
  document.body.appendChild(cont);
  try {
    const node = cont.querySelector("#cap");
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#fff" });
    const link = document.createElement("a");
    link.download = `lista_reparto_viajes_${hoy()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    alert("No se pudo generar la imagen. Usa el botón Imprimir y guarda como PDF.");
  } finally {
    document.body.removeChild(cont);
  }
}

/* ── PANTALLA DE LOGIN ─────────────────────────────────────── */
function LoginScreen({ barcos, onLoginOficinista, onLoginPatron, oficinistaPass }) {
  const [modo, setModo] = useState(null);
  const [pass, setPass] = useState("");
  const [barcoId, setBarcoId] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const loginOficinista = () => {
    if (pass === oficinistaPass) { setError(""); onLoginOficinista(); }
    else setError("Contraseña incorrecta");
  };
  const loginPatron = () => {
    const b = barcos.find((x) => x.id === barcoId);
    if (!b) { setError("Selecciona un barco"); return; }
    if (pin === b.pin) { setError(""); onLoginPatron(barcoId); }
    else setError("PIN incorrecto");
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ marginBottom: 12 }}><AnchorLogo size={64} /></div>
        <div className="cond" style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: "0.02em" }}>Reparto de Viajes · Fábrica</div>
        <div style={{ fontSize: 12, color: C.textDim, letterSpacing: "0.1em", marginTop: 4 }}>ASOCIACIÓN DE PRODUCTORES DE MEJILLÓN</div>
      </div>

      {!modo && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
          {[
            { id: "oficinista", label: "Oficinista", icon: "🗂️", desc: "Gestión de pedidos, flota e informes" },
            { id: "patron", label: "Socio / Patrón", icon: "⚓", desc: "Consulta tu posición en lista" },
          ].map((m) => (
            <button key={m.id} onClick={() => { setModo(m.id); setError(""); setPass(""); setPin(""); }}
              style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 16, padding: "28px 36px",
                cursor: "pointer", textAlign: "center", width: 220 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>{m.icon}</div>
              <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 6 }}>{m.label}</div>
              <div style={{ fontSize: 12, color: C.textDim }}>{m.desc}</div>
            </button>
          ))}
        </div>
      )}

      {modo === "oficinista" && (
        <Card style={{ width: "100%", maxWidth: 360 }}>
          <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16 }}>🗂️ Acceso Oficinista</div>
          {error && <div style={{ fontSize: 12, color: C.red, background: "#1f0808", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{error}</div>}
          <Label>Contraseña</Label>
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="••••••" style={{ marginBottom: 16 }} onKeyDown={(e) => e.key === "Enter" && loginOficinista()} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={loginOficinista} color={C.blue} style={{ flex: 1 }}>Entrar</Btn>
            <Btn outline onClick={() => { setModo(null); setError(""); }}>Volver</Btn>
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 12, textAlign: "center" }}>Demo: contraseña <span className="mono">admin</span></div>
        </Card>
      )}

      {modo === "patron" && (
        <Card style={{ width: "100%", maxWidth: 360 }}>
          <div className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 16 }}>⚓ Acceso Socio / Patrón</div>
          {error && <div style={{ fontSize: 12, color: C.red, background: "#1f0808", borderRadius: 8, padding: "8px 12px", marginBottom: 12 }}>{error}</div>}
          <Label>Tu barco</Label>
          <Sel value={barcoId} onChange={(e) => setBarcoId(e.target.value)} style={{ marginBottom: 12 }}>
            <option value="">Seleccionar barco...</option>
            {barcos.filter((b) => b.activo).map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </Sel>
          <Label>PIN (4 dígitos)</Label>
          <Input type="password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" style={{ marginBottom: 16 }} onKeyDown={(e) => e.key === "Enter" && loginPatron()} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={loginPatron} color={C.accent} style={{ flex: 1, color: "#000" }}>Entrar</Btn>
            <Btn outline onClick={() => { setModo(null); setError(""); }}>Volver</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ── TAB LISTA ─────────────────────────────────────────────── */
function TabLista({ bateas, barcos, poligonos, cierres, exclusiones }) {
  const rows = bateas.map((bt) => {
    const b = barcos.find((x) => x.id === bt.barcoId);
    const pol = poligonos.find((p) => p.id === bt.poligonoId);
    const enCierre = poligonoCerrado(bt.poligonoId, cierres);
    const excl = barcoExcluido(bt.barcoId, exclusiones);
    const { reales, posibles } = viajesParaQueLeToque(bt, bateas, barcos, cierres, exclusiones);
    const tipo = enCierre ? "cierre" : excl ? "excluido" : reales === 0 ? "le_toca" : "en_espera";
    return {
      _key: bt.id,
      pos: <span className="mono cond" style={{ fontSize: 18, fontWeight: 800, color: enCierre ? C.red : excl ? C.textDim : reales === 0 ? C.accentL : C.blue }}>{bt.posicion}</span>,
      barco: (
        <div>
          <div style={{ fontWeight: 600, color: excl || enCierre ? C.textMid : C.text }}>
            {b?.nombre}
            {bt.media && <span style={{ marginLeft: 6, fontSize: 10, color: C.violet, fontWeight: 800 }} title="Media batea: sirve una vez de cada dos">½{bt.mediaSalta ? " salta" : ""}</span>}
          </div>
          {bt.viajesAcum > 0 && <span style={{ fontSize: 10, color: C.accent, fontWeight: 700 }}>★ {bt.viajesAcum} viaje(s) acumulado(s)</span>}
        </div>
      ),
      poligono: <span style={{ fontSize: 12, color: C.textMid }}>{pol?.nombre}</span>,
      faltan: (
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: excl || enCierre ? C.textDim : reales === 0 ? C.green : C.text }}>
            {reales === 0 ? "—" : reales.toLocaleString()}
          </div>
          {posibles !== reales && (
            <div className="mono" style={{ fontSize: 10, color: C.violet }}>({posibles.toLocaleString()} posibles)</div>
          )}
        </div>
      ),
      estado: <EstadoBadge tipo={tipo} />,
    };
  });

  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <SectionTitle style={{ marginBottom: 0 }}>📋 Lista de Reparto</SectionTitle>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }} className="no-print">
          <span className="mono" style={{ fontSize: 12, color: C.textDim, background: C.navy, padding: "4px 12px", borderRadius: 20, border: `1px solid ${C.border}` }}>
            {bateas.length} posiciones · 1 batea = 1 viaje
          </span>
          <Btn small outline onClick={() => imprimirLista(bateas, barcos, poligonos, cierres, exclusiones)} color={C.navy}>🖨️ Imprimir / PDF</Btn>
          <Btn small onClick={() => descargarImagen(bateas, barcos, poligonos, cierres, exclusiones)} color={C.green}>📷 Imagen</Btn>
        </div>
      </div>
      <DataTable
        cols={[
          { key: "pos", label: "#", center: true },
          { key: "barco", label: "Barco" },
          { key: "poligono", label: "Polígono" },
          { key: "faltan", label: "Viajes para que le toque", right: true },
          { key: "estado", label: "Estado" },
        ]}
        rows={rows}
        empty="Sin bateas en lista"
      />
      <div style={{ fontSize: 11, color: C.textDim, marginTop: 10, lineHeight: 1.5 }}>
        <strong style={{ color: C.textMid }}>Viajes para que le toque:</strong> nº de viajes que tienen que salir de las posiciones por delante antes de que le toque.
        La cifra principal cuenta solo posiciones activas; <span style={{ color: C.violet }}>(posibles)</span> incluye polígonos cerrados y barcos sin producto por si se reactivan.
      </div>
    </div>
  );
}

/* ── TAB PEDIDO ────────────────────────────────────────────── */
function TabPedido({ bateas, barcos, poligonos, cierres, exclusiones, setBateas, setHistorial, historial, pedidoActivo, setPedidoActivo, pushUndo, undoStack, onUndo }) {
  const [fecha, setFecha] = useState(hoy());
  const [desc, setDesc] = useState("");

  const candidatos = useMemo(
    () => bateas.filter((bt) => bateaActiva(bt, barcos, cierres, exclusiones)),
    [bateas, barcos, cierres, exclusiones]
  );

  const iniciar = () => {
    setPedidoActivo({
      fecha, desc,
      asigs: candidatos.map((bt) => {
        const b = barcos.find((x) => x.id === bt.barcoId);
        const pol = poligonos.find((p) => p.id === bt.poligonoId);
        const { reales } = viajesParaQueLeToque(bt, bateas, barcos, cierres, exclusiones);
        return {
          bateaId: bt.id, barcoId: bt.barcoId, barcoNombre: b?.nombre, poligonoNombre: pol?.nombre,
          posicion: bt.posicion, viajesAcum: bt.viajesAcum, faltan: reales,
          media: !!bt.media, mediaSalta: !!bt.mediaSalta,
          // Una media batea en turno de salto no sirve: por defecto "salta".
          resultado: bt.media && bt.mediaSalta ? "salta" : "rechaza",
        };
      }),
    });
  };

  const upd = (bateaId, resultado) =>
    setPedidoActivo((p) => ({ ...p, asigs: p.asigs.map((a) => (a.bateaId === bateaId ? { ...a, resultado } : a)) }));
  const todas = (resultado) =>
    setPedidoActivo((p) => ({
      ...p,
      asigs: p.asigs.map((a) =>
        a.media && a.mediaSalta ? { ...a, resultado: resultado === "sirve" ? "salta" : resultado } : { ...a, resultado }
      ),
    }));

  const confirmar = () => {
    if (!pedidoActivo) return;
    let arr = bateas.map((b) => ({ ...b }));
    const lineas = [];
    const rotaIds = new Set();

    pedidoActivo.asigs.forEach((a) => {
      const idx = arr.findIndex((b) => b.id === a.bateaId);
      if (idx < 0) return;
      const b = arr[idx];

      // Media batea en turno de salto: rota al final SIN servir y alterna su turno.
      // (También si por lo que sea se marcó "sirve" estando en turno de salto.)
      if (a.resultado === "salta" || (a.resultado === "sirve" && b.media && b.mediaSalta)) {
        arr[idx] = { ...b, mediaSalta: false };
        rotaIds.add(a.bateaId);
        return;
      }

      if (a.resultado === "sirve") {
        const nuevoAcum = Math.max(0, b.viajesAcum - 1);
        // Si es media batea, tras servir pasa a "salta" para el próximo turno.
        arr[idx] = { ...b, viajesAcum: nuevoAcum, rechazosAcum: 0, mediaSalta: b.media ? true : b.mediaSalta };
        lineas.push({ barcoNombre: a.barcoNombre, poligonoNombre: a.poligonoNombre, viajes: 1 });
        // Rota al final SOLO si no le queda cupo acumulado pendiente.
        if (nuevoAcum === 0) rotaIds.add(a.bateaId);
      } else {
        let rech = b.rechazosAcum + 1;
        let acum = b.viajesAcum;
        if (acum > 0 && rech >= 3) { acum = 0; rech = 0; } // 3 rechazos seguidos → pierde acumulado
        arr[idx] = { ...b, rechazosAcum: rech, viajesAcum: acum };
      }
    });

    // Los que rotan van al final (preservando su orden relativo); los demás mantienen su sitio.
    const quedan = arr.filter((b) => !rotaIds.has(b.id));
    const alFinal = arr.filter((b) => rotaIds.has(b.id));
    arr = recalc([...quedan, ...alFinal]);

    // Guarda el estado PREVIO para poder deshacer este pedido.
    if (pushUndo) pushUndo({ bateas, historial, label: `${pedidoActivo.fecha} · ${lineas.length} viaje(s)` });

    setBateas(arr);
    setHistorial((h) => [{ id: uid(), fecha: pedidoActivo.fecha, desc: pedidoActivo.desc, lineas, ts: Date.now() }, ...h]);
    setPedidoActivo(null);
  };

  if (!pedidoActivo) {
    return (
      <div className="fade-in" style={{ maxWidth: 420 }}>
        <SectionTitle>📦 Nuevo Pedido</SectionTitle>
        <Card>
          <Label>Fecha del pedido</Label>
          <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ marginBottom: 14 }} />
          <Label>Descripción <span style={{ color: C.textDim, fontWeight: 400 }}>(opcional)</span></Label>
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="ej. Conservera · 8 viajes" style={{ marginBottom: 20 }} />
          <Btn onClick={iniciar} disabled={!candidatos.length} color={C.accent} style={{ width: "100%", color: "#000" }}>
            Proponer bateas abiertas ({candidatos.length})
          </Btn>
          {!candidatos.length && (
            <div style={{ fontSize: 12, color: C.textDim, marginTop: 10, textAlign: "center" }}>No hay bateas abiertas para proponer.</div>
          )}
          {undoStack && undoStack.length > 0 && (
            <>
              <div style={{ borderTop: `1px solid ${C.border}`, margin: "16px 0 12px" }} />
              <Btn outline color={C.orange} onClick={onUndo} style={{ width: "100%" }}>
                ↩ Deshacer último pedido ({undoStack[undoStack.length - 1].label})
              </Btn>
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 8, textAlign: "center" }}>
                Revierte la lista y el historial al estado anterior. {undoStack.length} paso(s) disponible(s).
              </div>
            </>
          )}
        </Card>
      </div>
    );
  }

  const nSirven = pedidoActivo.asigs.filter((a) => a.resultado === "sirve" && !(a.media && a.mediaSalta)).length;
  const nSalta = pedidoActivo.asigs.filter((a) => a.resultado === "salta").length;
  const nRechazan = pedidoActivo.asigs.filter((a) => a.resultado === "rechaza").length;

  return (
    <div className="fade-in">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <SectionTitle style={{ marginBottom: 4 }}>📦 Propuesta de pedido — {pedidoActivo.fecha}</SectionTitle>
          <div style={{ fontSize: 13, color: C.textMid }}>{pedidoActivo.desc || "Marca cuáles sirven y cuáles rechazan; al confirmar se mueve la lista."}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn small outline onClick={() => todas("sirve")} color={C.green}>Todas sirven</Btn>
          <Btn small outline onClick={() => todas("rechaza")} color={C.red}>Todas rechazan</Btn>
        </div>
      </div>
      <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}`, marginBottom: 16, marginTop: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
          <thead>
            <tr>
              {["#", "Barco", "Polígono", "Info", "Decisión"].map((h, i) => (
                <th key={i} style={{ background: "#0a1520", color: C.textDim, padding: "10px 14px",
                  textAlign: i >= 4 ? "right" : "left", fontSize: 10, fontWeight: 700,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pedidoActivo.asigs.map((a, i) => {
              const rowBg = a.resultado === "sirve" ? "#0d2b1a" : a.resultado === "salta" ? "#180d2e" : a.resultado === "rechaza" ? "#1f1010" : i % 2 === 0 ? C.surface : C.bg;
              return (
                <tr key={a.bateaId} style={{ background: rowBg, borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 14px" }}>
                    <span className="mono cond" style={{ fontSize: 16, fontWeight: 800, color: C.accentL }}>{a.posicion}</span>
                  </td>
                  <td style={{ padding: "10px 14px", fontWeight: 600, color: C.text }}>{a.barcoNombre}</td>
                  <td style={{ padding: "10px 14px", fontSize: 12, color: C.textMid }}>{a.poligonoNombre}</td>
                  <td style={{ padding: "10px 14px", fontSize: 12 }}>
                    {a.faltan === 0
                      ? <span style={{ color: C.green, fontWeight: 700 }}>¡Le toca!</span>
                      : <span style={{ color: C.textDim }}>Faltan {a.faltan}</span>}
                    {a.viajesAcum > 0 && <span style={{ marginLeft: 6, color: C.accent }}>★ {a.viajesAcum} acum.</span>}
                    {a.media && <span style={{ marginLeft: 6, color: C.violet, fontWeight: 700 }}>½{a.mediaSalta ? " salta turno" : " media"}</span>}
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {(a.media && a.mediaSalta
                        ? [{ r: "salta", label: "½ SALTA", col: C.violet }, { r: "rechaza", label: "RECHAZA", col: C.red }]
                        : [{ r: "sirve", label: "SIRVE", col: C.green }, { r: "rechaza", label: "RECHAZA", col: C.red }]
                      ).map(({ r, label, col }) => (
                        <button key={r} onClick={() => upd(a.bateaId, r)}
                          style={{ padding: "6px 14px", borderRadius: 8, border: "none",
                            background: a.resultado === r ? col : C.navy,
                            color: a.resultado === r ? "#fff" : C.textDim,
                            cursor: "pointer", fontSize: 12, fontWeight: 700 }}>{label}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Btn outline onClick={() => setPedidoActivo(null)}>Cancelar</Btn>
        <Btn onClick={confirmar} color={C.green} disabled={nSirven === 0 && nSalta === 0}>✓ Confirmar pedido</Btn>
        <span className="mono" style={{ fontSize: 13, color: C.textMid }}>
          <strong style={{ color: C.green }}>{nSirven}</strong> sirven · <strong style={{ color: C.red }}>{nRechazan}</strong> rechazan
          {nSalta > 0 && <> · <strong style={{ color: C.violet }}>{nSalta}</strong> ½ saltan</>}
        </span>
        {nSirven === 0 && nSalta === 0 && <span style={{ fontSize: 12, color: C.textDim }}>Sin viajes (todas rechazaron).</span>}
      </div>
    </div>
  );
}

/* ── TAB FLOTA ─────────────────────────────────────────────── */
function TabFlota({ barcos, bateas, poligonos, cierres, setBarcos, setBateas }) {
  const [form, setForm] = useState({ nombre: "", pin: "", poligonoId: "", nBateas: "1" });
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);

  const add = () => {
    const n = parseInt(form.nBateas);
    if (!form.nombre.trim() || !/^\d{4}$/.test(form.pin) || !form.poligonoId || isNaN(n) || n < 1) {
      setErr("Completa nombre, PIN de 4 dígitos, polígono y nº de bateas (≥1)."); return;
    }
    const nb = { id: uid(), nombre: form.nombre.trim(), pin: form.pin, activo: true };
    setBarcos((x) => [...x, nb]);
    setBateas((bs) => recalc([
      ...bs,
      ...Array.from({ length: n }, () => ({ id: uid(), barcoId: nb.id, poligonoId: form.poligonoId, posicion: 0, viajesAcum: 0, rechazosAcum: 0, media: false, mediaSalta: false })),
    ]));
    setForm({ nombre: "", pin: "", poligonoId: "", nBateas: "1" }); setShow(false); setErr("");
  };

  const cambiarPoligonoBatea = (bateaId, poligonoId) =>
    setBateas((bs) => bs.map((b) => (b.id === bateaId ? { ...b, poligonoId } : b)));

  const addBatea = (barcoId, poligonoId) =>
    setBateas((bs) => recalc([...bs, { id: uid(), barcoId, poligonoId, posicion: 0, viajesAcum: 0, rechazosAcum: 0, media: false, mediaSalta: false }]));

  const delBatea = (bateaId) =>
    setBateas((bs) => recalc(bs.filter((b) => b.id !== bateaId)));

  // Marca/desmarca una batea como "media batea" (sirve una vez de cada dos).
  const toggleMedia = (bateaId) =>
    setBateas((bs) => bs.map((b) => (b.id === bateaId ? { ...b, media: !b.media, mediaSalta: false } : b)));

  const borrarBarco = (barcoId) => {
    setBarcos((bs) => bs.filter((b) => b.id !== barcoId));
    setBateas((bs) => recalc(bs.filter((b) => b.barcoId !== barcoId)));
    setConfirmDel(null);
  };

  const barcoDel = confirmDel ? barcos.find((b) => b.id === confirmDel) : null;

  return (
    <div className="fade-in">
      {confirmDel && barcoDel && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
          <Card style={{ maxWidth: 380, width: "100%", boxShadow: "0 24px 64px #000a" }}>
            <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.red, marginBottom: 8 }}>⚠ Dar de baja barco</div>
            <div style={{ fontSize: 14, color: C.text, marginBottom: 12 }}><strong>{barcoDel.nombre}</strong></div>
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 20 }}>Se eliminará de la lista y de la flota junto con sus bateas. Sus viajes en el historial quedarán registrados.</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={() => borrarBarco(confirmDel)} color={C.red} style={{ flex: 1 }}>Confirmar baja</Btn>
              <Btn outline onClick={() => setConfirmDel(null)}>Cancelar</Btn>
            </div>
          </Card>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <SectionTitle style={{ marginBottom: 0 }}>🚢 Flota</SectionTitle>
        <Btn onClick={() => setShow(!show)} color={C.blue}>+ Añadir barco</Btn>
      </div>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Barcos y sus bateas por polígono. Se crean todas las bateas en el polígono elegido; luego puedes cambiar el polígono de cada una. El botón <strong style={{ color: C.violet }}>½</strong> marca una <strong>media batea</strong>: sirve una vez y a la siguiente salta al final sin servir (alterna).</div>

      {show && (
        <Card style={{ maxWidth: 440, marginBottom: 20 }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>Nuevo barco</div>
          {err && <div style={{ fontSize: 12, color: C.red, background: "#1f1010", border: `1px solid ${C.red}40`, borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>{err}</div>}
          <Label>Nombre del barco</Label>
          <Input value={form.nombre} onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))} placeholder="Nombre del barco" style={{ marginBottom: 10 }} />
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <Label>PIN socio (4 díg.)</Label>
              <Input value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }))} placeholder="0000" className="mono" style={{ marginBottom: 10 }} />
            </div>
            <div style={{ width: 90 }}>
              <Label>Nº bateas</Label>
              <Input type="number" min="1" value={form.nBateas} onChange={(e) => setForm((f) => ({ ...f, nBateas: e.target.value }))} style={{ marginBottom: 10 }} />
            </div>
          </div>
          <Label>Polígono 1ª batea</Label>
          <Sel value={form.poligonoId} onChange={(e) => setForm((f) => ({ ...f, poligonoId: e.target.value }))} style={{ marginBottom: 14 }}>
            <option value="">Seleccionar polígono...</option>
            {poligonos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </Sel>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={add} color={C.green} style={{ flex: 1 }}>Añadir</Btn>
            <Btn outline onClick={() => { setShow(false); setErr(""); }}>Cancelar</Btn>
          </div>
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {barcos.map((b) => {
          const bs = bateas.filter((x) => x.barcoId === b.id);
          return (
            <Card key={b.id} style={{ padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{b.nombre}</span>
                  <span className="mono" style={{ fontSize: 11, color: C.textDim, background: C.navy, padding: "2px 8px", borderRadius: 6 }}>PIN {b.pin}</span>
                  <span style={{ fontSize: 11, color: C.textMid }}>{bs.length} batea(s)</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn small outline color={C.blue} onClick={() => addBatea(b.id, poligonos[0]?.id)}>+ Batea</Btn>
                  <Btn small outline color={C.red} onClick={() => setConfirmDel(b.id)}>Dar de baja</Btn>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {bs.map((bt, idx) => {
                  const enCierre = poligonoCerrado(bt.poligonoId, cierres);
                  return (
                    <div key={bt.id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.navy, borderRadius: 8, padding: "6px 10px" }}>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: C.blue, minWidth: 28 }}>#{bt.posicion}</span>
                      <Sel value={bt.poligonoId} onChange={(e) => cambiarPoligonoBatea(bt.id, e.target.value)} style={{ flex: 1, padding: "5px 10px", fontSize: 12 }}>
                        {poligonos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                      </Sel>
                      {enCierre && <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>🔒 en cierre</span>}
                      {bt.viajesAcum > 0 && <span style={{ fontSize: 10, color: C.accent, fontWeight: 700 }}>★ {bt.viajesAcum}</span>}
                      <button onClick={() => toggleMedia(bt.id)} title="Media batea: sirve una vez de cada dos vueltas"
                        style={{ background: bt.media ? C.violet : "transparent", color: bt.media ? "#fff" : C.textDim, border: `1px solid ${bt.media ? C.violet : C.border2}`, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 800, padding: "2px 8px", lineHeight: 1.4 }}>½</button>
                      {bs.length > 1 && (
                        <button onClick={() => delBatea(bt.id)} title="Eliminar batea"
                          style={{ background: "transparent", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "0 4px" }}>✕</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ── TAB CIERRES (por polígono) ────────────────────────────── */
function ReabrirModal({ cierre, poligono, cierres, bateas, historial, onConfirm, onCancel }) {
  const [fecha, setFecha] = useState(hoy());
  const [override, setOverride] = useState("");
  const calc = useMemo(() => calcViajesAcumulados(cierre, fecha, cierres, bateas, historial), [cierre, fecha, cierres, bateas, historial]);
  const porBateaFinal = override !== "" ? (parseInt(override) || 0) : calc.porBatea;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 16, padding: 28, maxWidth: 440, width: "100%", boxShadow: "0 24px 64px #000a" }}>
        <div className="cond" style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>Reabrir y calcular acumulado</div>
        <div style={{ fontSize: 14, color: C.textMid, marginBottom: 16 }}>{poligono?.nombre} · {calc.nBateas} batea(s) en cierre</div>
        <Label>Fecha de reapertura</Label>
        <Input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); setOverride(""); }} style={{ marginBottom: 16 }} />

        <div style={{ background: "#0a1f10", border: `1px solid ${C.green}40`, borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Viajes acumulados por batea (automático)</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 12 }}>
            <span className="mono" style={{ fontSize: 36, fontWeight: 800, color: C.green }}>{calc.porBatea}</span>
            <span style={{ fontSize: 14, color: C.textMid }}>viaje(s) / batea</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", alignItems: "center", gap: 4, fontSize: 11 }}>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{calc.totalViajes}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>viajes servidos</div>
            </div>
            <div style={{ color: C.textDim, fontSize: 16, textAlign: "center" }}>÷</div>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{calc.abiertas}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>bateas abiertas</div>
            </div>
            <div style={{ color: C.textDim, fontSize: 16, textAlign: "center" }}>=</div>
            <div style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: C.green }}>{calc.porBatea}</div>
              <div style={{ color: C.textDim, marginTop: 2 }}>por batea</div>
            </div>
          </div>
          {calc.totalViajes === 0 && <div style={{ fontSize: 11, color: C.textDim, marginTop: 10, textAlign: "center" }}>Sin viajes en historial durante este período</div>}
        </div>

        <div style={{ marginBottom: 20 }}>
          <Label>Corrección manual <span style={{ color: C.textDim, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(vacío = usar calculado)</span></Label>
          <Input type="number" min="0" value={override} onChange={(e) => setOverride(e.target.value)} placeholder={`${calc.porBatea} (calculado)`} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn onClick={() => onConfirm(porBateaFinal, fecha)} color={C.green} style={{ flex: 1 }}>Reabrir — +{porBateaFinal} viaje(s)/batea</Btn>
          <Btn outline onClick={onCancel}>Cancelar</Btn>
        </div>
      </div>
    </div>
  );
}

function TabCierres({ poligonos, barcos, bateas, cierres, setCierres, setBateas, historial }) {
  const [form, setForm] = useState({ poligonoId: "", fecha: hoy() });
  const [show, setShow] = useState(false);
  const [closing, setClosing] = useState(null);
  const active = cierres.filter((c) => !c.fechaFin);
  const hist = cierres.filter((c) => c.fechaFin);
  const disponibles = poligonos.filter((p) => !poligonoCerrado(p.id, cierres));

  const abrir = () => {
    if (!form.poligonoId) return;
    setCierres((cs) => [...cs, { id: uid(), poligonoId: form.poligonoId, fechaInicio: form.fecha, fechaFin: null, createdTs: Date.now(), porBatea: 0 }]);
    setForm({ poligonoId: "", fecha: hoy() }); setShow(false);
  };
  const reabrir = (cierreId, porBatea, fecha) => {
    const cierre = cierres.find((c) => c.id === cierreId);
    if (!cierre) return;
    setCierres((cs) => cs.map((c) => (c.id === cierreId ? { ...c, fechaFin: fecha, porBatea } : c)));
    if (porBatea > 0) {
      setBateas((bs) => bs.map((b) => (b.poligonoId === cierre.poligonoId ? { ...b, viajesAcum: b.viajesAcum + porBatea } : b)));
    }
    setClosing(null);
  };
  const cierreToClose = closing ? cierres.find((c) => c.id === closing) : null;

  return (
    <div className="fade-in">
      {cierreToClose && (
        <ReabrirModal cierre={cierreToClose} poligono={poligonos.find((p) => p.id === cierreToClose.poligonoId)}
          cierres={cierres} bateas={bateas} historial={historial}
          onConfirm={(pb, f) => reabrir(closing, pb, f)} onCancel={() => setClosing(null)} />
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <SectionTitle style={{ marginBottom: 0 }}>🔒 Cierres administrativos</SectionTitle>
        <Btn onClick={() => setShow(!show)} color={C.red} disabled={!disponibles.length}>+ Nuevo cierre</Btn>
      </div>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16 }}>Se aplican a un polígono completo. Al reabrir se calcula el acumulado de cada barco con bateas en ese polígono.</div>

      {show && (
        <Card style={{ maxWidth: 380, marginBottom: 20, borderColor: `${C.red}40` }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.red, marginBottom: 14 }}>Cierre por toxina / Veda</div>
          <Label>Polígono a cerrar</Label>
          <Sel value={form.poligonoId} onChange={(e) => setForm((f) => ({ ...f, poligonoId: e.target.value }))} style={{ marginBottom: 10 }}>
            <option value="">Seleccionar polígono...</option>
            {disponibles.map((p) => {
              const n = bateas.filter((b) => b.poligonoId === p.id).length;
              return <option key={p.id} value={p.id}>{p.nombre} ({n} batea(s))</option>;
            })}
          </Sel>
          <Label>Fecha de inicio</Label>
          <Input type="date" value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} style={{ marginBottom: 14 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={abrir} color={C.red} disabled={!form.poligonoId} style={{ flex: 1 }}>Abrir cierre</Btn>
            <Btn outline onClick={() => setShow(false)}>Cancelar</Btn>
          </div>
        </Card>
      )}

      {active.length > 0 ? (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.red, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Cierres activos</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {active.map((c) => {
              const pol = poligonos.find((p) => p.id === c.poligonoId);
              const n = bateas.filter((b) => b.poligonoId === c.poligonoId).length;
              return (
                <div key={c.id} style={{ background: "#1a0a0a", border: `1px solid ${C.red}40`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: C.text }}>{pol?.nombre}</div>
                    <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>
                      Desde {c.fechaInicio} · <span style={{ color: C.red, fontWeight: 600 }}>{n} batea(s) en cierre — excluidas de propuestas</span>
                    </div>
                  </div>
                  <Btn small onClick={() => setClosing(c.id)} color={C.green}>Reabrir y calcular acumulado</Btn>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: C.textDim, marginBottom: 24 }}>No hay cierres activos.</div>
      )}

      {hist.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textDim, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Histórico de cierres</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {hist.map((c) => {
              const pol = poligonos.find((p) => p.id === c.poligonoId);
              return (
                <Card key={c.id} style={{ padding: "14px 18px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600, color: C.text }}>{pol?.nombre}</span>
                    <span className="mono" style={{ fontSize: 11, color: C.textDim }}>{c.fechaInicio} → {c.fechaFin}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.textMid, marginTop: 6 }}>
                    Acumulado aplicado: <span className="mono" style={{ fontWeight: 700, color: C.accent }}>+{c.porBatea || 0}</span> viaje(s) por batea
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── TAB EXCLUSIONES ───────────────────────────────────────── */
function TabExclusiones({ barcos, exclusiones, setExclusiones }) {
  const [barcoId, setBarcoId] = useState("");
  const activas = exclusiones.filter((e) => !e.fechaFin);
  const activasBIds = new Set(activas.map((e) => e.barcoId));
  const disponibles = barcos.filter((b) => b.activo && !activasBIds.has(b.id));

  const excluir = () => {
    if (!barcoId) return;
    setExclusiones((es) => [...es, { id: uid(), barcoId, fechaInicio: hoy(), fechaFin: null }]);
    setBarcoId("");
  };
  const reactivar = (id) => setExclusiones((es) => es.map((e) => (e.id === id ? { ...e, fechaFin: hoy() } : e)));

  return (
    <div className="fade-in">
      <SectionTitle>🚫 Exclusiones</SectionTitle>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 16, maxWidth: 600 }}>
        Marca un barco como sin producto. No aparecerá en las propuestas de pedido, pero su posición en la lista sigue avanzando con normalidad y no acumula viajes.
      </div>
      <Card style={{ maxWidth: 420, marginBottom: 20 }}>
        <Label>Excluir barco (sin producto)</Label>
        <div style={{ display: "flex", gap: 8 }}>
          <Sel value={barcoId} onChange={(e) => setBarcoId(e.target.value)} style={{ flex: 1 }}>
            <option value="">Seleccionar barco...</option>
            {disponibles.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </Sel>
          <Btn onClick={excluir} color={C.orange} disabled={!barcoId}>Excluir</Btn>
        </div>
      </Card>
      {activas.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {activas.map((e) => {
            const b = barcos.find((x) => x.id === e.barcoId);
            return (
              <div key={e.id} style={{ background: "#1a1400", border: `1px solid ${C.orange}40`, borderRadius: 12, padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600, color: C.text }}>{b?.nombre}</div>
                  <div style={{ fontSize: 12, color: C.textDim, marginTop: 2 }}>Sin producto desde {e.fechaInicio}</div>
                </div>
                <Btn small onClick={() => reactivar(e.id)} color={C.green}>Marcar operativo</Btn>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "40px 0", color: C.textDim }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>✓</div>
          <div>Todos los barcos operativos</div>
        </div>
      )}
    </div>
  );
}

/* ── TAB HISTORIAL ─────────────────────────────────────────── */
function TabHistorial({ historial }) {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [vista, setVista] = useState("pedidos");

  const filtrado = useMemo(
    () => historial.filter((p) => {
      if (desde && p.fecha < desde) return false;
      if (hasta && p.fecha > hasta) return false;
      return true;
    }),
    [historial, desde, hasta]
  );

  const resumenPorBarco = useMemo(() => {
    const mapa = {};
    filtrado.forEach((p) => p.lineas.forEach((l) => {
      if (!mapa[l.barcoNombre]) mapa[l.barcoNombre] = { viajes: 0, pedidos: 0 };
      mapa[l.barcoNombre].viajes += l.viajes;
      mapa[l.barcoNombre].pedidos += 1;
    }));
    return Object.entries(mapa).sort((a, b) => b[1].viajes - a[1].viajes);
  }, [filtrado]);

  const exportarExcel = () => {
    const wb = XLSX.utils.book_new();
    const detalle = [["Fecha", "Descripción", "Barco", "Polígono", "Viajes"]];
    filtrado.forEach((p) => p.lineas.forEach((l) => detalle.push([p.fecha, p.desc || "", l.barcoNombre, l.poligonoNombre || "", l.viajes])));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalle), "Historial");
    const resumen = [["Barco", "Total viajes", "Nº pedidos", "Media viajes/pedido"]];
    resumenPorBarco.forEach(([nombre, d]) => resumen.push([nombre, d.viajes, d.pedidos, Math.round((d.viajes / d.pedidos) * 10) / 10]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), "Por barco");
    const sufijo = desde || hasta ? `_${desde || "inicio"}_${hasta || "hoy"}` : "";
    XLSX.writeFile(wb, `reparto_viajes_fabrica${sufijo}.xlsx`);
  };

  const totalViajes = filtrado.reduce((s, p) => s + p.lineas.reduce((ss, l) => ss + l.viajes, 0), 0);

  if (historial.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 0", color: C.textDim }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📋</div>
        <div>Todavía no hay pedidos confirmados.</div>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <SectionTitle style={{ marginBottom: 0 }}>📜 Historial</SectionTitle>
        <Btn small onClick={exportarExcel} color={C.green}>⬇ Exportar a Excel</Btn>
      </div>

      <Card style={{ marginBottom: 16, padding: "14px 18px" }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Label>Desde</Label>
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Label>Hasta</Label>
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {["pedidos", "barcos"].map((v) => (
              <button key={v} onClick={() => setVista(v)} style={{
                padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 700, fontFamily: "'Barlow', sans-serif",
                background: vista === v ? C.blue : C.navy, color: vista === v ? "#fff" : C.textMid,
              }}>{v === "pedidos" ? "Por pedido" : "Por barco"}</button>
            ))}
          </div>
          {(desde || hasta) && <Btn small outline onClick={() => { setDesde(""); setHasta(""); }}>✕ Limpiar</Btn>}
        </div>
        <div className="mono" style={{ fontSize: 11, color: C.textDim, marginTop: 10 }}>
          {filtrado.length} pedido{filtrado.length !== 1 ? "s" : ""} · {totalViajes.toLocaleString()} viajes totales
          {(desde || hasta) && ` · filtrado de ${historial.length} total`}
        </div>
      </Card>

      {vista === "pedidos" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtrado.length === 0 && <div style={{ textAlign: "center", padding: 40, color: C.textDim }}>Sin pedidos en el periodo seleccionado</div>}
          {filtrado.map((p) => {
            const total = p.lineas.reduce((s, l) => s + l.viajes, 0);
            return (
              <Card key={p.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <span className="cond" style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{p.fecha}</span>
                    {p.desc && <span style={{ marginLeft: 10, fontSize: 13, color: C.textMid }}>{p.desc}</span>}
                  </div>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: C.accent, background: "#1a2f00", border: `1px solid ${C.accent}40`, padding: "3px 12px", borderRadius: 20 }}>
                    {total} viaje{total !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {p.lineas.map((l, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 12px", borderRadius: 8, background: "#0a2010", fontSize: 13 }}>
                      <span style={{ color: C.text }}>{l.barcoNombre} <span style={{ color: C.textDim, fontSize: 11 }}>· {l.poligonoNombre}</span></span>
                      <span className="mono" style={{ color: C.green, fontWeight: 700 }}>{l.viajes} viaje{l.viajes !== 1 ? "s" : ""}</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {vista === "barcos" && (
        <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Barco", "Total viajes", "Nº pedidos", "Media/pedido"].map((h) => (
                  <th key={h} style={{ background: "#0a1520", color: C.textDim, padding: "10px 16px", textAlign: h === "Barco" ? "left" : "right",
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                    fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resumenPorBarco.length === 0 && <tr><td colSpan={4} style={{ padding: 40, textAlign: "center", color: C.textDim }}>Sin datos</td></tr>}
              {resumenPorBarco.map(([nombre, d], i) => (
                <tr key={nombre} style={{ background: i % 2 === 0 ? C.surface : C.bg, borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 16px", fontWeight: 600, color: C.text }}>{nombre}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.accent, fontWeight: 700 }}>{d.viajes}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.textMid }}>{d.pedidos}</td>
                  <td className="mono" style={{ padding: "10px 16px", textAlign: "right", color: C.textDim }}>{Math.round((d.viajes / d.pedidos) * 10) / 10}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── VISTA SOCIO / PATRÓN ──────────────────────────────────── */
function VistaSocio({ barcos, bateas, poligonos, cierres, exclusiones, barcoId }) {
  const barco = barcos.find((b) => b.id === barcoId);
  const misBateas = bateas.filter((b) => b.barcoId === barcoId);

  return (
    <div className="fade-in">
      <SectionTitle>👤 Mi Posición</SectionTitle>
      {!barco ? (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textDim }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🚢</div>
          <div>Barco no encontrado</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "linear-gradient(135deg, #1a3a5c 0%, #0f1f35 100%)", border: `1px solid ${C.border2}`, borderRadius: 16, padding: 24 }}>
            <div className="cond" style={{ fontSize: 28, fontWeight: 800, color: "#fff" }}>{barco.nombre}</div>
            <div className="mono" style={{ fontSize: 12, color: C.textMid, marginTop: 4 }}>{misBateas.length} batea(s) en lista</div>
          </div>

          {misBateas.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.textDim }}>No tienes bateas en la lista.</div>
          )}

          {misBateas
            .slice()
            .sort((a, b) => a.posicion - b.posicion)
            .map((bt) => {
              const pol = poligonos.find((p) => p.id === bt.poligonoId);
              const enCierre = poligonoCerrado(bt.poligonoId, cierres);
              const excl = barcoExcluido(bt.barcoId, exclusiones);
              const { reales, posibles } = viajesParaQueLeToque(bt, bateas, barcos, cierres, exclusiones);
              return (
                <Card key={bt.id} style={{ padding: 24, borderColor: reales === 0 && !enCierre && !excl ? `${C.accent}60` : C.border }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
                    <div>
                      <div className="cond mono" style={{ fontSize: 56, fontWeight: 800, color: C.accentL, lineHeight: 1 }}>#{bt.posicion}</div>
                      <div style={{ fontSize: 13, color: C.textMid, marginTop: 6 }}>{pol?.nombre}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <EstadoBadge tipo={enCierre ? "cierre" : excl ? "excluido" : reales === 0 ? "le_toca" : "en_espera"} />
                      {bt.viajesAcum > 0 && <div style={{ marginTop: 8, fontSize: 12, color: C.accent, fontWeight: 700 }}>★ {bt.viajesAcum} viaje(s) acumulado(s)</div>}
                    </div>
                  </div>

                  {enCierre ? (
                    <div style={{ background: "#1a0505", border: `1px solid ${C.red}50`, borderRadius: 10, padding: "12px 16px", color: C.red, fontSize: 13, fontWeight: 600 }}>
                      🔒 Polígono en cierre administrativo. Esta batea no participa en el reparto hasta que se reabra.
                    </div>
                  ) : (
                    <div style={{ background: "#0a1f35", border: `1px solid ${C.blue}30`, borderRadius: 10, padding: "14px 18px" }}>
                      <div style={{ fontSize: 11, color: C.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                        Viajes que tienen que salir antes de que le toque
                      </div>
                      {reales === 0 ? (
                        <div className="cond" style={{ fontSize: 26, fontWeight: 800, color: C.green }}>¡Le toca! Es el siguiente</div>
                      ) : (
                        <div className="mono" style={{ fontSize: 30, fontWeight: 800, color: C.blue }}>
                          {reales.toLocaleString()}
                          <span style={{ fontSize: 14, fontWeight: 400, color: C.textMid, marginLeft: 6 }}>viaje(s)</span>
                        </div>
                      )}
                      {posibles !== reales && (
                        <div style={{ fontSize: 12, color: C.violet, marginTop: 6 }}>
                          Hasta <span className="mono" style={{ fontWeight: 700 }}>{posibles.toLocaleString()}</span> si se reactivan barcos sin producto o se reabren polígonos cerrados
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
        </div>
      )}
    </div>
  );
}

/* ── IMPORTAR FLOTA DESDE EXCEL / CSV ──────────────────────── */
// Cada fila del Excel = una batea = una posición de la lista. Columnas
// reconocidas (cabecera, sin distinguir mayúsculas/acentos): Barco y Polígono
// (obligatorias), Orden y PIN (opcionales). Reutiliza SheetJS (ya es dependencia).
const normHdr = (s) =>
  String(s ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const ALIAS_IMP = {
  orden: ["orden", "posicion", "pos", "n", "no", "numero", "#"],
  barco: ["barco", "embarcacion", "buque", "nombre"],
  poligono: ["poligono", "pol", "zona"],
  pin: ["pin", "clave", "codigo"],
};
function clasifHdr(celda) {
  const n = normHdr(celda);
  for (const [k, al] of Object.entries(ALIAS_IMP)) if (al.includes(n)) return k;
  return null;
}
function interpretarFlotaImport(matriz) {
  let hi = -1, mapa = {};
  for (let i = 0; i < matriz.length; i++) {
    const m = {};
    (matriz[i] || []).forEach((celda, col) => {
      const k = clasifHdr(celda);
      if (k && !(k in m)) m[k] = col;
    });
    if ("barco" in m && "poligono" in m) { hi = i; mapa = m; break; }
  }
  if (hi < 0)
    return { ok: false, error: "No se encontraron las columnas obligatorias «Barco» y «Polígono» en la fila de cabecera." };
  const registros = [], errores = [];
  const hayOrden = mapa.orden != null;
  for (let i = hi + 1; i < matriz.length; i++) {
    const fila = matriz[i] || [];
    const barco = String(fila[mapa.barco] ?? "").trim();
    const poligono = String(fila[mapa.poligono] ?? "").trim();
    if (!barco && !poligono) continue;
    if (!barco || !poligono) { errores.push(`Fila ${i + 1}: falta ${!barco ? "barco" : "polígono"}.`); continue; }
    const pin = mapa.pin != null ? String(fila[mapa.pin] ?? "").replace(/\D/g, "").slice(0, 4) : "";
    let orden = null;
    if (hayOrden) { const v = parseInt(String(fila[mapa.orden] ?? "").trim(), 10); orden = Number.isFinite(v) ? v : null; }
    registros.push({ orden, barco, poligono, pin });
  }
  if (!registros.length) return { ok: false, error: "No hay filas de datos para importar." };
  if (hayOrden && registros.every((r) => r.orden != null)) {
    const ord = registros.map((r, i) => ({ r, i })).sort((a, b) => a.r.orden - b.r.orden || a.i - b.i).map((x) => x.r);
    registros.length = 0; registros.push(...ord);
  }
  const nb = new Set(registros.map((r) => normHdr(r.barco)));
  const np = new Set(registros.map((r) => normHdr(r.poligono)));
  return { ok: true, registros, errores, resumen: { barcos: nb.size, poligonos: np.size, bateas: registros.length } };
}
function construirFlotaImport(registros) {
  const polMap = new Map(), poligonos = [];
  const barcoMap = new Map(), barcos = [];
  const bateas = [];
  for (const r of registros) {
    const kp = normHdr(r.poligono);
    let pol = polMap.get(kp);
    if (!pol) { pol = { id: uid(), nombre: r.poligono.trim() }; polMap.set(kp, pol); poligonos.push(pol); }
    const kb = normHdr(r.barco);
    let barco = barcoMap.get(kb);
    if (!barco) { barco = { id: uid(), nombre: r.barco.trim(), pin: r.pin || "0000", activo: true }; barcoMap.set(kb, barco); barcos.push(barco); }
    else if ((!barco.pin || barco.pin === "0000") && r.pin) barco.pin = r.pin;
    bateas.push({ id: uid(), barcoId: barco.id, poligonoId: pol.id, posicion: 0, viajesAcum: 0, rechazosAcum: 0, media: false, mediaSalta: false });
  }
  return { poligonos, barcos, bateas: recalc(bateas) };
}

function ImportarFlotaCard({ onAplicar }) {
  const [error, setError] = useState("");
  const [datos, setDatos] = useState(null);
  const [hecho, setHecho] = useState(false);
  const [leyendo, setLeyendo] = useState(false);

  const onArchivo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLeyendo(true); setError(""); setDatos(null); setHecho(false);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
      const res = interpretarFlotaImport(matriz);
      if (!res.ok) setError(res.error); else setDatos(res);
    } catch (_) {
      setError("No se pudo leer el archivo. Debe ser un Excel (.xlsx) o CSV válido.");
    } finally { setLeyendo(false); e.target.value = ""; }
  };

  const confirmar = () => {
    if (!datos) return;
    if (!window.confirm("Esto REEMPLAZA la flota, los polígonos y el orden de la lista, y borra los cierres y exclusiones activos. El historial y la contraseña se conservan. ¿Continuar?")) return;
    onAplicar(datos.registros);
    setDatos(null); setHecho(true);
    setTimeout(() => setHecho(false), 5000);
  };

  const plantilla = () => {
    const wb = XLSX.utils.book_new();
    const aoa = [
      ["Orden", "Barco", "Poligono", "PIN"],
      [1, "Rías Baixas", "Polígono A — Vilagarcía", "1111"],
      [2, "A Marola", "Polígono A — Vilagarcía", "2222"],
      [3, "Corrubedo", "Polígono B — O Grove", "3333"],
      [4, "Rías Baixas", "Polígono B — O Grove", "1111"],
      [5, "Ondina", "Polígono C — Cambados", "4444"],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Flota");
    XLSX.writeFile(wb, "plantilla_flota.xlsx");
  };

  return (
    <Card style={{ gridColumn: "1 / -1", borderColor: `${C.violet}40` }}>
      <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>📥 Importar flota desde Excel</div>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 14, maxWidth: 640 }}>
        Cada fila es una <strong>batea</strong> = una posición de la lista. Columnas: <span className="mono" style={{ color: C.text }}>Barco</span> y <span className="mono" style={{ color: C.text }}>Polígono</span> (obligatorias), <span className="mono" style={{ color: C.text }}>Orden</span> y <span className="mono" style={{ color: C.text }}>PIN</span> (opcionales). Acepta .xlsx y .csv.
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <label style={{ display: "inline-block" }}>
          <span style={{ background: C.blue, color: "#fff", padding: "8px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-block" }}>
            {leyendo ? "Leyendo…" : "Elegir archivo…"}
          </span>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={onArchivo} style={{ display: "none" }} />
        </label>
        <Btn outline onClick={plantilla}>⬇ Descargar plantilla</Btn>
      </div>

      {error && <div style={{ fontSize: 13, color: C.red, background: "#1f0808", borderRadius: 8, padding: "10px 14px", marginTop: 14 }}>⚠ {error}</div>}
      {hecho && <div style={{ fontSize: 13, color: C.green, background: "#0a2010", borderRadius: 8, padding: "10px 14px", marginTop: 14 }}>✓ Flota importada correctamente.</div>}

      {datos && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {[
              [`${datos.resumen.barcos}`, "barcos"],
              [`${datos.resumen.poligonos}`, "polígonos"],
              [`${datos.resumen.bateas}`, "bateas / posiciones"],
            ].map(([n, t]) => (
              <span key={t} className="mono" style={{ fontSize: 12, color: C.text, background: C.navy, border: `1px solid ${C.border2}`, padding: "4px 12px", borderRadius: 20 }}>
                <strong style={{ color: C.accent }}>{n}</strong> {t}
              </span>
            ))}
          </div>

          {datos.errores?.length > 0 && (
            <div style={{ fontSize: 12, color: C.accentL, background: "#1a1400", border: `1px solid ${C.accent}40`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
              {datos.errores.length} fila(s) omitida(s): {datos.errores.slice(0, 4).join(" ")} {datos.errores.length > 4 ? "…" : ""}
            </div>
          )}

          <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${C.border}`, marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
              <thead>
                <tr>{["#", "Barco", "Polígono", "PIN"].map((h) => (
                  <th key={h} style={{ background: "#0a1520", color: C.textDim, padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Barlow Condensed', sans-serif", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {datos.registros.slice(0, 12).map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? C.surface : C.bg, borderBottom: `1px solid ${C.border}` }}>
                    <td className="mono" style={{ padding: "7px 12px", color: C.textDim }}>{i + 1}</td>
                    <td style={{ padding: "7px 12px", color: C.text, fontWeight: 600 }}>{r.barco}</td>
                    <td style={{ padding: "7px 12px", color: C.textMid, fontSize: 12 }}>{r.poligono}</td>
                    <td className="mono" style={{ padding: "7px 12px", color: C.textDim }}>{r.pin || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {datos.registros.length > 12 && (
              <div style={{ padding: "6px 12px", fontSize: 11, color: C.textDim }}>… y {datos.registros.length - 12} fila(s) más.</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <Btn onClick={confirmar} color={C.green}>Importar y reemplazar</Btn>
            <Btn outline onClick={() => setDatos(null)}>Cancelar</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ── TAB CONFIGURACIÓN ─────────────────────────────────────── */
function TabConfig({ barcos, setBarcos, oficinistaPass, setOficinistaPass, poligonos, setPoligonos, bateas, setBateas, setCierres, setExclusiones }) {
  const aplicarImport = (registros) => {
    const { poligonos: np, barcos: nb, bateas: nbt } = construirFlotaImport(registros);
    setPoligonos(np); setBarcos(nb); setBateas(nbt);
    setCierres([]); setExclusiones([]);
  };
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [passMsg, setPassMsg] = useState("");
  const [pins, setPins] = useState(() => Object.fromEntries(barcos.map((b) => [b.id, b.pin || "0000"])));
  const [nuevoPol, setNuevoPol] = useState("");

  const savePass = () => {
    if (newPass.length < 4) { setPassMsg("Mínimo 4 caracteres"); return; }
    if (newPass !== confirmPass) { setPassMsg("Las contraseñas no coinciden"); return; }
    setOficinistaPass(newPass);
    setNewPass(""); setConfirmPass(""); setPassMsg("✓ Contraseña actualizada");
    setTimeout(() => setPassMsg(""), 3000);
  };
  const savePin = (barcoId) => {
    const pin = pins[barcoId] || "0000";
    if (!/^\d{4}$/.test(pin)) { alert("El PIN debe ser exactamente 4 dígitos"); return; }
    setBarcos((bs) => bs.map((b) => (b.id === barcoId ? { ...b, pin } : b)));
  };
  const addPol = () => {
    const n = nuevoPol.trim();
    if (!n) return;
    if (poligonos.some((p) => p.nombre.toLowerCase() === n.toLowerCase())) { alert("Ya existe ese polígono"); return; }
    setPoligonos((ps) => [...ps, { id: uid(), nombre: n }]);
    setNuevoPol("");
  };
  const delPol = (pid) => {
    const n = bateas.filter((b) => b.poligonoId === pid).length;
    if (n > 0) { alert(`No se puede eliminar: tiene ${n} batea(s) asociada(s).`); return; }
    if (poligonos.length <= 1) return;
    setPoligonos((ps) => ps.filter((p) => p.id !== pid));
  };

  return (
    <div className="fade-in">
      <SectionTitle>⚙️ Configuración</SectionTitle>
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>🔑 Contraseña Oficinista</div>
          <Label>Nueva contraseña</Label>
          <Input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="Nueva contraseña" style={{ marginBottom: 10 }} />
          <Label>Confirmar</Label>
          <Input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} placeholder="Repetir contraseña" style={{ marginBottom: 14 }} onKeyDown={(e) => e.key === "Enter" && savePass()} />
          {passMsg && <div style={{ fontSize: 12, marginBottom: 10, color: passMsg.startsWith("✓") ? C.green : C.red }}>{passMsg}</div>}
          <Btn onClick={savePass} color={C.blue} style={{ width: "100%" }}>Guardar contraseña</Btn>
        </Card>

        <Card>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>⚓ PINs de socios (4 dígitos)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {barcos.filter((b) => b.activo).map((b) => (
              <div key={b.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ flex: 1, fontSize: 13, color: C.text, fontWeight: 600 }}>{b.nombre}</div>
                <input type="text" maxLength={4} value={pins[b.id] || ""}
                  onChange={(e) => setPins((p) => ({ ...p, [b.id]: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                  className="mono"
                  style={{ width: 70, background: C.navy, border: `1px solid ${C.border2}`, color: C.text, padding: "6px 10px", borderRadius: 8, fontSize: 14, textAlign: "center", outline: "none", letterSpacing: 4 }} />
                <Btn small onClick={() => savePin(b.id)} color={C.green}>✓</Btn>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ gridColumn: "1 / -1" }}>
          <div className="cond" style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>🗺️ Polígonos</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
            {poligonos.map((p) => {
              const n = bateas.filter((b) => b.poligonoId === p.id).length;
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.navy, border: `1px solid ${C.border2}`, borderRadius: 10, padding: "8px 14px" }}>
                  <span className="cond" style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{p.nombre}</span>
                  <span className="mono" style={{ fontSize: 11, color: C.textDim }}>{n} batea(s)</span>
                  {poligonos.length > 1 && (
                    <button onClick={() => delPol(p.id)} title="Eliminar polígono"
                      style={{ background: "transparent", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, maxWidth: 380 }}>
            <Input value={nuevoPol} onChange={(e) => setNuevoPol(e.target.value)} placeholder="Nuevo polígono (ej. Polígono D — Muros)" onKeyDown={(e) => e.key === "Enter" && addPol()} style={{ flex: 1 }} />
            <Btn onClick={addPol} color={C.green} disabled={!nuevoPol.trim()}>+ Añadir</Btn>
          </div>
        </Card>

        <ImportarFlotaCard onAplicar={aplicarImport} />
      </div>
    </div>
  );
}

/* ── APP PRINCIPAL ─────────────────────────────────────────── */
const TABS = [
  { id: "lista", label: "📋 Lista" },
  { id: "pedido", label: "📦 Pedido" },
  { id: "flota", label: "🚢 Flota" },
  { id: "cierres", label: "🔒 Cierres" },
  { id: "exclusiones", label: "🚫 Exclusiones" },
  { id: "historial", label: "📜 Historial" },
  { id: "config", label: "⚙️ Config" },
];

export default function App() {
  const [poligonos, setPoligonos] = useState(DEMO_POLIGONOS);
  const [barcos, setBarcos] = useState(DEMO_BARCOS);
  const [bateas, setBateas] = useState(initBateas);
  const [cierres, setCierres] = useState([]);
  const [exclusiones, setExclusiones] = useState([]);
  const [historial, setHistorial] = useState([]);
  const [pedidoActivo, setPedidoActivo] = useState(null);
  const [oficinistaPass, setOficinistaPass] = useState("admin");
  const [undoStack, setUndoStack] = useState([]); // snapshots previos a cada pedido (sesión)
  const [tab, setTab] = useState("lista");
  const [role, setRole] = useState(null);
  const [patronBarcoId, setPatronBarcoId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState(false);
  const skipSave = useRef(false); // evita re-guardar justo después de cargar de Supabase

  // Aplica un estado completo recibido (de Supabase o de la caché local).
  const aplicarEstado = (s) => {
    if (s.poligonos) setPoligonos(s.poligonos);
    if (s.barcos) setBarcos(s.barcos);
    if (s.bateas) setBateas(s.bateas);
    setCierres(s.cierres || []);
    setExclusiones(s.exclusiones || []);
    setHistorial(s.historial || []);
  };

  /* Carga inicial: Supabase es la fuente de la verdad; localStorage es respaldo. */
  useEffect(() => {
    let cancelado = false;
    (async () => {
      // La contraseña de oficinista vive solo en local (no se sincroniza).
      try {
        const raw = localStorage.getItem("fabrica-state");
        if (raw) { const s = JSON.parse(raw); if (s.oficinistaPass) setOficinistaPass(s.oficinistaPass); }
      } catch (_) {}

      const remoto = await loadAll();
      if (cancelado) return;

      if (remoto && remoto.poligonos.length > 0) {
        skipSave.current = true;
        aplicarEstado(remoto);
      } else {
        // Supabase vacío o sin conexión: arrancamos desde la caché local si existe.
        try {
          const raw = localStorage.getItem("fabrica-state");
          if (raw) { skipSave.current = true; aplicarEstado(JSON.parse(raw)); }
        } catch (_) {}
        if (!remoto) setOffline(true);
      }
      setLoaded(true);
    })();
    return () => { cancelado = true; };
  }, []);

  /* Guardado: caché local siempre; Supabase solo desde la oficina (un único editor). */
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem("fabrica-state", JSON.stringify({ poligonos, barcos, bateas, cierres, exclusiones, historial, oficinistaPass }));
    } catch (_) {}
    if (skipSave.current) { skipSave.current = false; return; }
    if (role !== "oficinista") return;
    const t = setTimeout(() => {
      saveAll({ poligonos, barcos, bateas, cierres, exclusiones, historial })
        .then(() => setOffline(false))
        .catch(() => setOffline(true));
    }, 800);
    return () => clearTimeout(t);
  }, [poligonos, barcos, bateas, cierres, exclusiones, historial, oficinistaPass, loaded, role]);

  /* Refresco automático para socios: recarga de Supabase cada 15 s y al volver a la pestaña. */
  useEffect(() => {
    if (role !== "patron") return;
    let parar = false;
    const refrescar = async () => {
      const r = await loadAll();
      if (!parar && r && r.poligonos.length > 0) { skipSave.current = true; aplicarEstado(r); }
    };
    const iv = setInterval(refrescar, 15000);
    const onFocus = () => refrescar();
    window.addEventListener("focus", onFocus);
    return () => { parar = true; clearInterval(iv); window.removeEventListener("focus", onFocus); };
  }, [role]);

  /* Deshacer: guarda estado previo a cada pedido y permite revertir (hasta 10 pasos) */
  const pushUndo = (snap) => setUndoStack((s) => [...s, snap].slice(-10));
  const undoLast = () => {
    if (!undoStack.length) return;
    const last = undoStack[undoStack.length - 1];
    setBateas(last.bateas);
    setHistorial(last.historial);
    setUndoStack((s) => s.slice(0, -1));
  };

  if (!loaded) {
    return (
      <>
        <GlobalStyles />
        <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.textMid }}>
          <div style={{ textAlign: "center" }}><div style={{ marginBottom: 16 }}><AnchorLogo size={64} /></div>Cargando datos...</div>
        </div>
      </>
    );
  }

  if (!role) {
    return (
      <>
        <GlobalStyles />
        <LoginScreen barcos={barcos} oficinistaPass={oficinistaPass}
          onLoginOficinista={() => { setRole("oficinista"); setTab("lista"); }}
          onLoginPatron={(bid) => { setRole("patron"); setPatronBarcoId(bid); }} />
      </>
    );
  }

  if (role === "patron") {
    const barco = barcos.find((b) => b.id === patronBarcoId);
    return (
      <>
        <GlobalStyles />
        <div style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
          <header style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, padding: "0 20px", display: "flex", alignItems: "center", gap: 12, height: 52 }}>
            <AnchorLogo size={28} />
            <div className="cond" style={{ fontSize: 16, fontWeight: 800, color: C.text, flex: 1 }}>{barco?.nombre}</div>
            <button onClick={() => { setRole(null); setPatronBarcoId(null); }}
              style={{ background: "transparent", border: `1px solid ${C.border2}`, color: C.textMid, padding: "5px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>Cerrar sesión</button>
          </header>
          <main style={{ maxWidth: 640, margin: "0 auto", padding: "24px 20px" }}>
            <VistaSocio barcos={barcos} bateas={bateas} poligonos={poligonos} cierres={cierres} exclusiones={exclusiones} barcoId={patronBarcoId} />
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <GlobalStyles />
      <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Barlow', sans-serif" }}>
        <header className="no-print" style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, padding: "0 24px", display: "flex", alignItems: "center", gap: 16, height: 56 }}>
          <AnchorLogo size={32} />
          <div>
            <div className="cond" style={{ fontSize: 18, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>Reparto de Viajes · Fábrica</div>
            <div style={{ fontSize: 11, color: C.textDim, letterSpacing: "0.06em" }}>ASOCIACIÓN DE PRODUCTORES DE MEJILLÓN</div>
          </div>
          {pedidoActivo && (
            <div style={{ fontSize: 12, fontWeight: 700, color: C.accent, background: "#1a1400", border: `1px solid ${C.accent}50`, padding: "4px 14px", borderRadius: 20 }}>
              ⚠ Pedido en curso — {pedidoActivo.fecha}
            </div>
          )}
          {offline && (
            <div title="No se pudo conectar con la base de datos en la nube. Los cambios se guardan en este equipo y se sincronizarán cuando vuelva la conexión." style={{ fontSize: 12, fontWeight: 700, color: C.red, background: "#1f0808", border: `1px solid ${C.red}50`, padding: "4px 14px", borderRadius: 20 }}>
              ⚠ Sin conexión — solo local
            </div>
          )}
          <button onClick={() => setRole(null)} style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${C.border2}`, color: C.textMid, padding: "5px 14px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}>Cerrar sesión</button>
        </header>

        <nav className="no-print" style={{ background: "#0a1520", borderBottom: `1px solid ${C.border}`, display: "flex", overflowX: "auto", padding: "0 24px" }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "11px 18px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700,
              letterSpacing: "0.04em", fontFamily: "'Barlow Condensed', sans-serif",
              background: "transparent", whiteSpace: "nowrap",
              color: tab === t.id ? C.accentL : C.textDim,
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
            }}>{t.label}</button>
          ))}
        </nav>

        <main style={{ maxWidth: 960, margin: "0 auto", padding: "28px 24px" }}>
          {tab === "lista" && <TabLista bateas={bateas} barcos={barcos} poligonos={poligonos} cierres={cierres} exclusiones={exclusiones} />}
          {tab === "pedido" && <TabPedido bateas={bateas} barcos={barcos} poligonos={poligonos} cierres={cierres} exclusiones={exclusiones} setBateas={setBateas} setHistorial={setHistorial} historial={historial} pedidoActivo={pedidoActivo} setPedidoActivo={setPedidoActivo} pushUndo={pushUndo} undoStack={undoStack} onUndo={undoLast} />}
          {tab === "flota" && <TabFlota barcos={barcos} bateas={bateas} poligonos={poligonos} cierres={cierres} setBarcos={setBarcos} setBateas={setBateas} />}
          {tab === "cierres" && <TabCierres poligonos={poligonos} barcos={barcos} bateas={bateas} cierres={cierres} setCierres={setCierres} setBateas={setBateas} historial={historial} />}
          {tab === "exclusiones" && <TabExclusiones barcos={barcos} exclusiones={exclusiones} setExclusiones={setExclusiones} />}
          {tab === "historial" && <TabHistorial historial={historial} />}
          {tab === "config" && <TabConfig barcos={barcos} setBarcos={setBarcos} oficinistaPass={oficinistaPass} setOficinistaPass={setOficinistaPass} poligonos={poligonos} setPoligonos={setPoligonos} bateas={bateas} setBateas={setBateas} setCierres={setCierres} setExclusiones={setExclusiones} />}
        </main>
      </div>
    </>
  );
}
