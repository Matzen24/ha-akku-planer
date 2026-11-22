/* Akku-Planer Card – animierte 2.5D-Karte für die Akku-Planer-Integration */
const APC_VERSION = "1.1.0";


/* Finds the Akku-Planer entities on any system: the integration publishes their ids in the
 * attribute "akku_planer" of its "planned minimum SoC" sensor. Entities set in the card config win. */
var AP_KEYS = {
  target: "target_min_soc", reason: "reason", forecast: "forecast_days", forecast_fallback: "pv_tomorrow",
  forecast_today: "pv_today_remaining", model: "pv_model", floor: "floor_soc", reserve: "reserve_soc",
  mode: "mode", auto: "automatic", grid_charge: "grid_charge", refill: "refill", drain: "drain",
  soc_refill: "soc_at_refill", accuracy: "accuracy", cerbo_min_soc: "min_soc", cerbo: "min_soc", soc: "soc",
  pv_power: "pv_power", grid_power: "grid_power", load_power: "load_power", battery_power: "battery_power",
};
var apResolve = function (hass, ents, userEnts, extra) {
  let map = null;
  for (const id in hass.states) {
    const a = hass.states[id].attributes;
    if (a && a.akku_planer && typeof a.akku_planer === "object") { map = a.akku_planer; break; }
  }
  if (!map) return false;
  const keys = { ...AP_KEYS, ...(extra || {}) };
  for (const k of Object.keys(ents)) {
    if (userEnts && userEnts[k]) continue;
    if (keys[k] && keys[k] in map) ents[k] = map[keys[k]] || "";
  }
  return true;
};

const APC_DEFAULTS = {
  soc: "sensor.victron_mqtt_battery_512_battery_soc",
  target: "sensor.akku_planer_geplanter_mindest_soc",
  cerbo_min_soc: "number.victron_mqtt_system_0_system_ess_min_soc_limit",
  reason: "sensor.akku_planer_begrundung",
  forecast: "sensor.akku_planer_pv_prognose_4_tage",
  forecast_fallback: "sensor.akku_planer_pv_prognose_morgen",
  forecast_today: "sensor.akku_planer_pv_prognose_rest_heute",
  model: "sensor.akku_planer_gelernte_pv_leistung",
  floor: "number.akku_planer_untergrenze_bei_sonne",
  reserve: "number.akku_planer_notstrom_reserve",
  mode: "select.akku_planer_betriebsart",
  pv_power: "",
  grid_power: "sensor.victron_mqtt_grid_30_grid_power",
  load_power: "",
  battery_power: "sensor.victron_mqtt_battery_512_battery_power",
};

const STATUS = {
  sonnig: { label: "Akku frei", color: "#8BD46A", glow: "rgba(139,212,106,.55)" },
  teilweise: { label: "Teilweise freigegeben", color: "#F2B347", glow: "rgba(242,179,71,.55)" },
  schlecht: { label: "Reserve halten", color: "#F28C4B", glow: "rgba(242,140,75,.55)" },
  unwetter: { label: "Unwetter-Reserve", color: "#F0605D", glow: "rgba(240,96,93,.6)" },
  reserve_fest: { label: "Reserve (fest)", color: "#5DCAA5", glow: "rgba(93,202,165,.5)" },
  voll_fest: { label: "Voll nutzen (fest)", color: "#6FA8F0", glow: "rgba(111,168,240,.5)" },
};
const MODE_LABEL = {
  observe: "Schattenbetrieb", auto: "Automatik", always_reserve: "Immer Reserve", full_use: "Voll nutzen",
};

const NS = "http://www.w3.org/2000/svg";
const fmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : Number(v).toFixed(d).replace(".", ","));
const kw = (w) => (Math.abs(w) >= 1000 ? fmt(w / 1000, 1) + " kW" : Math.round(w) + " W");

class AkkuPlanerCard extends HTMLElement {
  static getStubConfig() { return { view: "full" }; }

  setConfig(config) {
    this._config = { view: "full", tilt: true, ...config };
    this._e = { ...APC_DEFAULTS, ...(config.entities || {}) };
    this._ue = config.entities || {};
    this._apr = false;
    this._built = false;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return this._config && this._config.view === "compact" ? 6 : 8; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._apr) this._apr = apResolve(hass, this._e, this._ue, null);
    if (!this._built) this._build();
    const keys = Object.values(this._e).map((id) => {
      const s = hass.states[id];
      return s ? s.state + "|" + (s.last_updated || "") : "x";
    }).join(";");
    if (keys === this._lastKeys) return;
    this._lastKeys = keys;
    this._update();
  }

  /* ---------- Hilfen ---------- */
  _st(key) { return this._hass && this._hass.states[this._e[key]]; }
  _num(key) { const s = this._st(key); const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; }
  _el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  _moreInfo(entityId) {
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  /* ---------- Aufbau (einmalig) ---------- */
  _build() {
    const compact = this._config.view === "compact";
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const W = compact ? 420 : 860, H = compact ? 360 : 400;
    this._geo = compact
      ? { bx: 100, bTop: 70, bH: 190, rx: 52, ry: 15, barsX: 215, barsBase: 270, barsH: 170, barW: 30, gap: 48 }
      : { bx: 130, bTop: 80, bH: 220, rx: 62, ry: 17, barsX: 600, barsBase: 320, barsH: 210, barW: 34, gap: 62 };
    root.innerHTML = `
<style>
:host{display:block}
ha-card{overflow:hidden;position:relative;background:
 radial-gradient(120% 90% at 15% 0%,#1d3047 0%,#0d1621 55%,#081019 100%);color:#e8eef5;
 border:1px solid rgba(255,255,255,.06)}
.stage{perspective:1100px;padding:10px 12px 4px}
.tilt{transform-style:preserve-3d;transition:transform .6s cubic-bezier(.2,.8,.2,1);will-change:transform}
svg{width:100%;height:auto;display:block;overflow:visible}
.t{fill:#e8eef5;font-family:var(--ha-font-family-body,Roboto,sans-serif)}
.m{fill:#8aa0b6}
.liq{transition:transform 1.8s cubic-bezier(.2,.8,.2,1)}
.ring{transition:transform 1.6s cubic-bezier(.2,.8,.2,1)}
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
.float{animation:float 6s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.bar{transform-origin:bottom;transform-box:fill-box;animation:rise 1.3s cubic-bezier(.2,.8,.2,1) both}
@keyframes rise{from{transform:scaleY(.02);opacity:.2}to{transform:scaleY(1);opacity:1}}
.sunrays{transform-box:fill-box;transform-origin:center;animation:spin 18s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.cloud{animation:drift 7s ease-in-out infinite}
@keyframes drift{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}
.foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 16px 14px;font-size:13px;color:#b9c7d6}
.chip{display:inline-flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;
 background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);cursor:pointer;white-space:nowrap}
.chip b{color:#e8eef5;font-weight:500}
.reason{flex:1 1 100%;color:#9fb2c6;font-size:12.5px;line-height:1.45;cursor:pointer}
.dot{filter:url(#glow)}
</style>
<ha-card>
 <div class="stage"><div class="tilt" id="tilt">
  <svg viewBox="0 0 ${W} ${H}" id="svg"></svg>
 </div></div>
 <div class="foot" id="foot"></div>
</ha-card>`;
    this._svg = root.getElementById("svg");
    this._foot = root.getElementById("foot");
    this._buildSvg(W, H, compact);

    const card = root.querySelector("ha-card");
    const tilt = root.getElementById("tilt");
    if (this._config.tilt) {
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
        tilt.style.transform = `rotateY(${x * 7}deg) rotateX(${-y * 6}deg)`;
      });
      card.addEventListener("pointerleave", () => { tilt.style.transform = "rotateY(0) rotateX(0)"; });
    }
    this._built = true;
  }

  _buildSvg(W, H, compact) {
    const s = this._svg, g = this._geo;
    s.innerHTML = `
<defs>
 <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/>
  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
 <linearGradient id="liqG" x1="0" x2="0" y1="0" y2="1"><stop id="lq1" offset="0" stop-color="#F2B347"/><stop id="lq2" offset="1" stop-color="#9a5a12"/></linearGradient>
 <linearGradient id="liqS" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset=".35" stop-color="#fff" stop-opacity=".12"/><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></linearGradient>
 <linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".03"/><stop offset=".22" stop-color="#fff" stop-opacity=".18"/><stop offset=".3" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></linearGradient>
 <linearGradient id="barF" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FFD27A"/><stop offset="1" stop-color="#E08A1E"/></linearGradient>
 <linearGradient id="barS" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#C77814"/><stop offset="1" stop-color="#8a4f0c"/></linearGradient>
 <clipPath id="cyl"><rect x="${g.bx - g.rx}" y="${g.bTop}" width="${2 * g.rx}" height="${g.bH}"/><ellipse cx="${g.bx}" cy="${g.bTop + g.bH}" rx="${g.rx}" ry="${g.ry}"/></clipPath>
</defs>
<g id="head"></g>
<g id="battery"></g>
<g id="flows"></g>
<g id="bars"></g>`;
    this._buildBattery();
    if (!compact) this._buildFlows();
  }

  _buildBattery() {
    const g = this._geo, b = this._svg.querySelector("#battery"), x0 = g.bx - g.rx, x1 = g.bx + g.rx;
    const bottom = g.bTop + g.bH;
    // Schatten
    this._el("ellipse", { cx: g.bx, cy: bottom + 14, rx: g.rx * 1.25, ry: g.ry * 1.1, fill: "#000", opacity: ".45", filter: "url(#soft)" }, b);
    // Körper hinten
    this._el("rect", { x: x0, y: g.bTop, width: 2 * g.rx, height: g.bH, fill: "#132131" }, b);
    this._el("ellipse", { cx: g.bx, cy: bottom, rx: g.rx, ry: g.ry, fill: "#132131" }, b);
    // Flüssigkeit
    const clip = this._el("g", { "clip-path": "url(#cyl)" }, b);
    this._liq = this._el("g", { class: "liq" }, clip);
    const w = this._el("path", { fill: "url(#liqG)", d: this._wave(x0 - 20, x1 + 20, 0) }, this._liq);
    const a = this._el("animate", { attributeName: "d", dur: "3.4s", repeatCount: "indefinite",
      values: [this._wave(x0 - 20, x1 + 20, 0), this._wave(x0 - 20, x1 + 20, 1), this._wave(x0 - 20, x1 + 20, 0)].join(";") }, w);
    this._el("ellipse", { cx: g.bx, cy: 0, rx: g.rx, ry: g.ry, fill: "#fff", opacity: ".14" }, this._liq);
    this._el("rect", { x: x0, y: g.bTop, width: 2 * g.rx, height: g.bH + g.ry, fill: "url(#liqS)" }, clip);
    // Blasen
    for (let i = 0; i < 6; i++) {
      const c = this._el("circle", { cx: x0 + 14 + i * (2 * g.rx - 28) / 5, cy: bottom, r: 1.6 + (i % 3), fill: "#fff", opacity: ".35" }, clip);
      this._el("animate", { attributeName: "cy", from: bottom, to: g.bTop, dur: 3 + i * 0.7 + "s", begin: i * 0.6 + "s", repeatCount: "indefinite" }, c);
      this._el("animate", { attributeName: "opacity", values: ".0;.4;0", dur: 3 + i * 0.7 + "s", begin: i * 0.6 + "s", repeatCount: "indefinite" }, c);
    }
    // Glas
    this._el("rect", { x: x0, y: g.bTop, width: 2 * g.rx, height: g.bH, fill: "url(#glass)" }, b);
    this._el("path", { d: `M${x0} ${g.bTop} V${bottom} A${g.rx} ${g.ry} 0 0 0 ${x1} ${bottom} V${g.bTop}`, fill: "none", stroke: "#4d6378", "stroke-width": 1.2 }, b);
    this._el("ellipse", { cx: g.bx, cy: g.bTop, rx: g.rx, ry: g.ry, fill: "#1a2b3d", stroke: "#5d7389", "stroke-width": 1.2 }, b);
    this._el("rect", { x: g.bx - 18, y: g.bTop - g.ry - 12, width: 36, height: 16, rx: 4, fill: "#5d7389" }, b);
    this._el("ellipse", { cx: g.bx, cy: g.bTop - g.ry - 12, rx: 18, ry: 5, fill: "#7d93a8" }, b);
    // Ringe: Untergrenze (fein) und Ziel (leuchtend)
    this._floorRing = this._el("g", { class: "ring" }, b);
    this._el("ellipse", { cx: g.bx, cy: 0, rx: g.rx + 4, ry: g.ry + 1, fill: "none", stroke: "#8aa0b6", "stroke-width": 1, "stroke-dasharray": "2 4", opacity: ".7" }, this._floorRing);
    this._targetRing = this._el("g", { class: "ring" }, b);
    this._ringGlow = this._el("ellipse", { cx: g.bx, cy: 0, rx: g.rx + 8, ry: g.ry + 3, fill: "none", stroke: "#F28C4B", "stroke-width": 4, class: "pulse", filter: "url(#glow)" }, this._targetRing);
    this._ringLine = this._el("ellipse", { cx: g.bx, cy: 0, rx: g.rx + 8, ry: g.ry + 3, fill: "none", stroke: "#F28C4B", "stroke-width": 1.2, "stroke-dasharray": "7 5" }, this._targetRing);
    this._ringText = this._el("text", { x: g.bx + g.rx + 16, y: 4, class: "t", "font-size": 12 }, this._targetRing);
    // Werte
    this._socText = this._el("text", { x: g.bx, y: bottom + g.ry + 34, class: "t", "font-size": 30, "font-weight": 500, "text-anchor": "middle" }, b);
    this._kwhText = this._el("text", { x: g.bx, y: bottom + g.ry + 52, class: "m", "font-size": 12, "text-anchor": "middle" }, b);
    b.style.cursor = "pointer";
    b.addEventListener("click", () => this._moreInfo(this._e.target));
    // Kopfzeile
    const h = this._svg.querySelector("#head");
    this._statusGlow = this._el("rect", { x: 18, y: 14, width: 210, height: 30, rx: 15, fill: "#F28C4B", opacity: ".22", filter: "url(#soft)", class: "pulse" }, h);
    this._statusPill = this._el("rect", { x: 18, y: 14, width: 210, height: 30, rx: 15, fill: "rgba(255,255,255,.06)", stroke: "#F28C4B", "stroke-width": 1.2 }, h);
    this._statusDot = this._el("circle", { cx: 36, cy: 29, r: 5, fill: "#F28C4B", class: "pulse" }, h);
    this._statusText = this._el("text", { x: 50, y: 34, class: "t", "font-size": 14, "font-weight": 500 }, h);
    this._modeText = this._el("text", { x: 240, y: 34, class: "m", "font-size": 12 }, h);
  }

  _wave(xa, xb, phase) {
    const w = xb - xa, a = phase ? -7 : 7;
    return `M${xa} 0 Q ${xa + w * 0.25} ${a} ${xa + w * 0.5} 0 T ${xb} 0 V 400 H ${xa} Z`;
  }

  _buildFlows() {
    const f = this._svg.querySelector("#flows"), g = this._geo;
    const P = { pv: [330, 92], grid: [330, 330], house: [470, 215], bat: [g.bx + g.rx + 6, 205] };
    this._nodes = P;
    const paths = {
      pv_house: `M${P.pv[0] + 18} ${P.pv[1] + 14} C 410 120 440 160 ${P.house[0] - 8} ${P.house[1] - 34}`,
      pv_bat: `M${P.pv[0] - 18} ${P.pv[1] + 10} C 270 110 230 150 ${P.bat[0]} ${P.bat[1] - 30}`,
      grid_house: `M${P.grid[0] + 20} ${P.grid[1] - 10} C 410 310 440 280 ${P.house[0] - 6} ${P.house[1] + 30}`,
      grid_bat: `M${P.grid[0] - 20} ${P.grid[1] - 8} C 270 320 230 270 ${P.bat[0]} ${P.bat[1] + 40}`,
      bat_house: `M${P.bat[0] + 4} ${P.bat[1]} C 300 200 380 210 ${P.house[0] - 36} ${P.house[1]}`,
    };
    this._flows = {};
    for (const [k, d] of Object.entries(paths)) {
      const p = this._el("path", { id: "p_" + k, d, fill: "none", stroke: "#2a3d52", "stroke-width": 2, "stroke-linecap": "round" }, f);
      const grp = this._el("g", { opacity: 0 }, f);
      grp.style.transition = "opacity .8s";
      this._flows[k] = { path: p, grp, dots: [] };
    }
    // Knoten: Sonne
    const sun = this._el("g", { transform: `translate(${P.pv[0]},${P.pv[1]})` }, f);
    this._sunGlow = this._el("circle", { r: 26, fill: "#FFC94D", opacity: ".25", filter: "url(#soft)" }, sun);
    const rays = this._el("g", { class: "sunrays" }, sun);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      this._el("line", { x1: Math.cos(a) * 19, y1: Math.sin(a) * 19, x2: Math.cos(a) * 25, y2: Math.sin(a) * 25, stroke: "#FFC94D", "stroke-width": 2, "stroke-linecap": "round" }, rays);
    }
    this._el("circle", { r: 14, fill: "#FFC94D" }, sun);
    this._pvText = this._el("text", { x: 34, y: 5, class: "t", "font-size": 13, "font-weight": 500 }, sun);
    // Netz-Mast
    const grid = this._el("g", { transform: `translate(${P.grid[0]},${P.grid[1]})` }, f);
    this._el("path", { d: "M-10 18 L0 -22 L10 18 M-14 -10 H14 M-11 0 H11 M-6 -22 H6", fill: "none", stroke: "#85B7EB", "stroke-width": 2, "stroke-linejoin": "round" }, grid);
    this._gridText = this._el("text", { x: 22, y: 5, class: "t", "font-size": 13, "font-weight": 500 }, grid);
    // Haus (isometrisch)
    const hOuter = this._el("g", { transform: `translate(${P.house[0]},${P.house[1]})` }, f);
    const h = this._el("g", { class: "float" }, hOuter);
    this._el("ellipse", { cx: 8, cy: 40, rx: 52, ry: 12, fill: "#000", opacity: ".4", filter: "url(#soft)" }, h);
    this._el("path", { d: "M-34 0 L0 18 L0 50 L-34 32 Z", fill: "#3b5168" }, h);
    this._el("path", { d: "M0 18 L44 -4 L44 28 L0 50 Z", fill: "#2b3d50" }, h);
    this._el("path", { d: "M-40 2 L-10 -34 L50 -4 L0 22 Z", fill: "#55708c" }, h);
    this._el("path", { d: "M-10 -34 L50 -4 L44 -4 L-10 -30 Z", fill: "#6d8aa8" }, h);
    this._houseWin = [];
    for (const [x, y] of [[-26, 16], [-14, 22], [10, 24], [26, 16]]) {
      const w = this._el("rect", { x, y, width: 7, height: 9, fill: "#FFD27A", opacity: ".85", transform: x < 0 ? `skewY(28)` : `skewY(-27)` }, h);
      this._houseWin.push(w);
    }
    this._loadText = this._el("text", { x: 56, y: 22, class: "t", "font-size": 13, "font-weight": 500 }, h);
  }

  _setFlow(key, watts, color, reverse = false) {
    const fl = this._flows && this._flows[key];
    if (!fl) return;
    const on = watts > 30;
    fl.grp.setAttribute("opacity", on ? 1 : 0);
    fl.path.setAttribute("stroke", on ? color : "#2a3d52");
    fl.path.setAttribute("stroke-opacity", on ? ".35" : "1");
    const dur = Math.max(0.7, Math.min(4, 4.2 - Math.log10(Math.max(watts, 31)) * 0.95));
    const sig = `${on}|${dur.toFixed(1)}|${color}|${reverse}`;
    if (fl.sig === sig) return;
    fl.sig = sig;
    fl.grp.innerHTML = "";
    if (!on) return;
    const n = Math.min(6, 2 + Math.round(watts / 1500));
    for (let i = 0; i < n; i++) {
      const c = this._el("circle", { r: 3.6, fill: color, class: "dot" }, fl.grp);
      const am = this._el("animateMotion", { dur: dur + "s", begin: (i * dur) / n + "s", repeatCount: "indefinite",
        keyPoints: reverse ? "1;0" : "0;1", keyTimes: "0;1", calcMode: "linear" }, c);
      const mp = document.createElementNS(NS, "mpath");
      mp.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#p_" + key);
      mp.setAttribute("href", "#p_" + key);
      am.appendChild(mp);
    }
  }

  /* ---------- Weather glyph ---------- */
  _glyph(parent, x, y, kind) {
    const g = this._el("g", { transform: `translate(${x},${y})` }, parent);
    const sun = (dx, dy, r) => {
      const s = this._el("g", { transform: `translate(${dx},${dy})` }, g);
      const rays = this._el("g", { class: "sunrays" }, s);
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        this._el("line", { x1: Math.cos(a) * (r + 3), y1: Math.sin(a) * (r + 3), x2: Math.cos(a) * (r + 7), y2: Math.sin(a) * (r + 7), stroke: "#FFC94D", "stroke-width": 1.8, "stroke-linecap": "round" }, rays);
      }
      this._el("circle", { r, fill: "#FFC94D" }, s);
    };
    const cloud = (dx, dy, col) => {
      const c = this._el("g", { transform: `translate(${dx},${dy})`, class: "cloud" }, g);
      this._el("path", { d: "M-14 6 a7 7 0 0 1 2 -13 a9 9 0 0 1 17 -2 a7 7 0 0 1 9 9 a6 6 0 0 1 -2 6 Z", fill: col }, c);
    };
    if (kind === "sun") sun(0, 0, 9);
    else if (kind === "partly") { sun(-5, -4, 7); cloud(4, 4, "#c9d6e3"); }
    else if (kind === "cloud") { cloud(-3, 0, "#9fb0c2"); cloud(5, 6, "#c9d6e3"); }
    else {
      cloud(0, 0, "#7d8fa3");
      for (let i = 0; i < 3; i++) {
        const l = this._el("line", { x1: -8 + i * 7, y1: 10, x2: -11 + i * 7, y2: 17, stroke: "#85B7EB", "stroke-width": 1.8, "stroke-linecap": "round" }, g);
        this._el("animate", { attributeName: "opacity", values: "1;.2;1", dur: "1.4s", begin: i * 0.3 + "s", repeatCount: "indefinite" }, l);
      }
    }
  }

  _prism(parent, x, yTop, h, w, d, faces, opacity, delay) {
    const g = this._el("g", { class: "bar", opacity }, parent);
    g.style.animationDelay = delay + "s";
    this._el("path", { d: `M${x} ${yTop} h${w} v${h} h${-w} Z`, fill: faces[0] }, g);
    this._el("path", { d: `M${x + w} ${yTop} l${d} ${-d * 0.55} v${h} l${-d} ${d * 0.55} Z`, fill: faces[1] }, g);
    this._el("path", { d: `M${x} ${yTop} l${d} ${-d * 0.55} h${w} l${-d} ${d * 0.55} Z`, fill: faces[2] }, g);
    return g;
  }

  _days() {
    const fc = this._st("forecast");
    if (fc && Array.isArray(fc.attributes.tage) && fc.attributes.tage.length) return fc.attributes.tage;
    const t = this._st("forecast_today"), m = this._st("forecast_fallback");
    const out = [];
    if (t) out.push({ tag: "Rest heute", pv_p10: t.attributes.p10_sicher, pv_p50: parseFloat(t.state), pv_p90: t.attributes.p90_optimistisch, verbrauch: null });
    if (m) out.push({ tag: "Morgen", pv_p10: m.attributes.p10_sicher, pv_p50: parseFloat(m.state), pv_p90: m.attributes.p90_optimistisch, verbrauch: null });
    return out;
  }

  _drawBars() {
    const g = this._geo, root = this._svg.querySelector("#bars");
    const days = this._days();
    const sig = JSON.stringify(days.map((d) => [d.tag, d.pv_p10, d.pv_p50, d.pv_p90, d.verbrauch]));
    if (sig === this._barsSig) return;
    this._barsSig = sig;
    root.innerHTML = "";
    if (!days.length) return;
    // Skala nach PV (Verbrauch ist im Winter oft 5x größer und würde die Säulen platt drücken)
    const max = Math.max(5, ...days.map((d) => d.pv_p90 || 0)) * 1.12;
    const sc = (v) => ((v || 0) / max) * g.barsH;
    this._el("text", { x: g.barsX - 6, y: g.barsBase - g.barsH - 40, class: "m", "font-size": 12 }, root).textContent = "PV-Prognose (kWh)";
    // Bodenplatte
    const n = days.length, totalW = (n - 1) * g.gap + g.barW;
    this._el("path", { d: `M${g.barsX - 14} ${g.barsBase + 6} h${totalW + 28} l16 -9 h${-totalW - 28} Z`, fill: "rgba(255,255,255,.05)" }, root);
    days.forEach((d, i) => {
      const x = g.barsX + i * g.gap, d3 = 13;
      const h90 = sc(d.pv_p90), h50 = sc(d.pv_p50), h10 = sc(d.pv_p10);
      this._prism(root, x, g.barsBase - h90, h90, g.barW, d3, ["#FFD27A", "#C77814", "#FFE3A3"], 0.16, i * 0.12);
      this._prism(root, x, g.barsBase - h50, h50, g.barW, d3, ["url(#barF)", "url(#barS)", "#FFE3A3"], 1, i * 0.12 + 0.08);
      if (h10 > 2) this._el("line", { x1: x - 2, x2: x + g.barW + 2, y1: g.barsBase - h10, y2: g.barsBase - h10, stroke: "#fff", "stroke-width": 1.4, "stroke-dasharray": "3 2", opacity: ".8" }, root);
      if (d.verbrauch && sc(d.verbrauch) <= g.barsH) {
        const ly = g.barsBase - sc(d.verbrauch);
        this._el("path", { d: `M${x - 6} ${ly} h${g.barW + 12} l${d3} ${-d3 * 0.55}`, stroke: "#85B7EB", "stroke-width": 2, fill: "none", "stroke-linecap": "round" }, root);
      }
      const ratio = d.verbrauch ? d.pv_p50 / d.verbrauch : d.pv_p50 / 10;
      const kind = ratio >= 1 ? "sun" : ratio >= 0.45 ? "partly" : ratio >= 0.15 ? "cloud" : "rain";
      const top = g.barsBase - Math.max(h90, h50) - d3 * 0.55;
      this._glyph(root, x + g.barW / 2 + 6, top - 40, kind);
      const v = this._el("text", { x: x + g.barW / 2 + 6, y: top - 9, class: "t", "font-size": 13, "font-weight": 500, "text-anchor": "middle" }, root);
      v.textContent = fmt(d.pv_p50);
      const lab = this._el("text", { x: x + g.barW / 2, y: g.barsBase + 24, class: "m", "font-size": 12, "text-anchor": "middle" }, root);
      const short = this._config.view === "compact" || (d.tag && d.tag.length > 8);
      lab.textContent = short && d.tag && !["Heute", "Morgen"].includes(d.tag) ? d.tag.slice(0, 2) : d.tag;
      const s10 = this._el("text", { x: x + g.barW / 2, y: g.barsBase + 39, class: "m", "font-size": 10.5, "text-anchor": "middle" }, root);
      s10.textContent = "sicher " + fmt(d.pv_p10);
      if (d.verbrauch) {
        const vb = this._el("text", { x: x + g.barW / 2, y: g.barsBase + 53, "font-size": 10.5, "text-anchor": "middle", fill: "#85B7EB" }, root);
        vb.textContent = "Verbr. " + fmt(d.verbrauch, 0);
      }
    });
    const ly = g.barsBase + 72;
    this._el("line", { x1: g.barsX - 6, x2: g.barsX + 10, y1: ly - 4, y2: ly - 4, stroke: "#fff", "stroke-width": 1.4, "stroke-dasharray": "3 2" }, root);
    this._el("text", { x: g.barsX + 14, y: ly, class: "m", "font-size": 11 }, root).textContent = "sicher (P10) · Schleier = optimistisch";
    root.style.cursor = "pointer";
    root.onclick = () => this._moreInfo(this._e.forecast);
  }

  /* ---------- Aktualisieren ---------- */
  _update() {
    if (!this._built || !this._hass) return;
    const g = this._geo;
    const soc = this._num("soc");
    const tgtS = this._st("target");
    const target = tgtS ? parseFloat(tgtS.state) : null;
    const decision = (tgtS && tgtS.attributes.entscheidung) || "schlecht";
    const st = STATUS[decision] || STATUS.schlecht;
    const floor = this._num("floor");
    const cerbo = this._num("cerbo_min_soc");
    const model = this._st("model");
    const cap = model && model.attributes.kapazitaet_kwh;
    const lvl = (p) => g.bTop + g.bH * (1 - Math.max(0, Math.min(100, p || 0)) / 100);

    // Akku
    this._liq.style.transform = `translateY(${lvl(soc)}px)`;
    const c = soc === null ? ["#6b7c8f", "#38485a"] : soc < 20 ? ["#F0605D", "#8e2422"] : soc < 50 ? ["#F2B347", "#9a5a12"] : ["#8BD46A", "#2f6b15"];
    this._svg.querySelector("#lq1").setAttribute("stop-color", c[0]);
    this._svg.querySelector("#lq2").setAttribute("stop-color", c[1]);
    this._socText.textContent = soc === null ? "–" : Math.round(soc) + " %";
    this._kwhText.textContent = cap && soc !== null ? `${fmt((cap * soc) / 100)} von ${fmt(cap, 0)} kWh` : "";
    this._targetRing.style.transform = `translateY(${lvl(target)}px)`;
    this._floorRing.style.transform = `translateY(${lvl(floor)}px)`;
    for (const el of [this._ringGlow, this._ringLine]) el.setAttribute("stroke", st.color);
    this._ringText.setAttribute("fill", st.color);
    const compact = this._config.view === "compact";
    this._ringText.textContent = target === null ? "" : compact ? `${Math.round(target)} %` : `Mindest-SoC ${Math.round(target)} %`;

    // Status
    for (const el of [this._statusPill]) el.setAttribute("stroke", st.color);
    this._statusGlow.setAttribute("fill", st.color);
    this._statusDot.setAttribute("fill", st.color);
    this._statusText.textContent = st.label;
    const wpx = 44 + st.label.length * 8.2;
    this._statusPill.setAttribute("width", wpx);
    this._statusGlow.setAttribute("width", wpx);
    const mode = this._st("mode");
    this._modeText.setAttribute("x", 18 + wpx + 12);
    this._modeText.textContent = mode ? MODE_LABEL[mode.state] || mode.state : "";

    // Flüsse
    if (this._flows) {
      const pv = Math.max(0, this._num("pv_power") || 0);
      const grid = this._num("grid_power") || 0;
      const load = Math.max(0, this._num("load_power") || 0);
      const bat = this._num("battery_power") || 0; // + = Laden
      const pvToBat = bat > 0 ? Math.min(pv, bat) : 0;
      const gridToBat = bat > 0 ? Math.max(0, bat - pvToBat) : 0;
      const batToHouse = bat < 0 ? -bat : 0;
      const pvToHouse = Math.max(0, Math.min(pv - pvToBat, load));
      this._setFlow("pv_house", pvToHouse, "#FFC94D");
      this._setFlow("pv_bat", pvToBat, "#FFC94D");
      this._setFlow("bat_house", batToHouse, "#8BD46A");
      this._setFlow("grid_bat", grid > 30 ? gridToBat : 0, "#85B7EB");
      this._setFlow("grid_house", Math.abs(grid) > 30 ? Math.abs(grid) - (grid > 0 ? gridToBat : 0) : 0, grid < 0 ? "#B9E07A" : "#85B7EB", grid < 0);
      this._pvText.textContent = kw(pv);
      this._gridText.textContent = (grid < 0 ? "Einspeisung " : "Netz ") + kw(Math.abs(grid));
      this._loadText.textContent = "Haus " + kw(load);
      this._sunGlow.setAttribute("opacity", pv > 50 ? Math.min(0.6, 0.15 + pv / 15000) : 0.05);
      const night = pv < 20;
      this._houseWin.forEach((w) => w.setAttribute("opacity", night ? ".95" : ".35"));
    }

    this._drawBars();

    // Fußzeile
    const reason = this._st("reason");
    const full = reason ? reason.attributes.volltext || reason.state : "";
    const chips = [];
    chips.push(`<span class="chip" data-e="target">Geplant <b>${target === null ? "–" : Math.round(target) + " %"}</b></span>`);
    chips.push(`<span class="chip" data-e="cerbo_min_soc">Cerbo <b>${cerbo === null ? "–" : Math.round(cerbo) + " %"}</b></span>`);
    if (tgtS && tgtS.attributes.netzladung) chips.push(`<span class="chip" data-e="target" style="border-color:#85B7EB">Netzladung <b>${fmt(tgtS.attributes.netzladung_ziel, 0)} %</b></span>`);
    if (this._config.view !== "compact" && model && model.state) chips.push(`<span class="chip" data-e="model">PV gelernt <b>${fmt(parseFloat(model.state))} kWp</b></span>`);
    this._foot.innerHTML = chips.join("") + `<div class="reason" data-e="reason"></div>`;
    this._foot.querySelector(".reason").textContent = full.replace(/^\[Schattenbetrieb\]\s*/, "");
    this._foot.querySelectorAll("[data-e]").forEach((n) => n.addEventListener("click", () => this._moreInfo(this._e[n.dataset.e])));
  }
}

if (!customElements.get("akku-planer-card")) {
  customElements.define("akku-planer-card", AkkuPlanerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "akku-planer-card", name: "Akku-Planer Card", description: "Animierte 2.5D-Karte für die Akku-Planer-Integration", preview: false });
  console.info(`%c AKKU-PLANER-CARD %c ${APC_VERSION} `, "background:#F2B347;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
