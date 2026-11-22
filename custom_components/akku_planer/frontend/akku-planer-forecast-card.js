/* Akku-Planer 4-Tage-Vorschau – animierte Stundenkurve im Stil der Akku-Planer-Card */
const FC_VERSION = "1.0.0";


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

const FC_DEFAULTS = {
  forecast: "sensor.akku_planer_pv_prognose_4_tage",
  target: "sensor.akku_planer_geplanter_mindest_soc",
};
const FC_NS = "http://www.w3.org/2000/svg";
const ffmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : Number(v).toFixed(d).replace(".", ","));
const FC_DAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/* glatte Kurve (Catmull-Rom -> Bezier), nie unter 0 überschießen */
function fcSmooth(pts) {
  if (!pts.length) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    const lo = Math.max(p1[1], p2[1]);
    c1[1] = Math.min(c1[1], lo); c2[1] = Math.min(c2[1], lo);
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

class AkkuPlanerForecastCard extends HTMLElement {
  static getStubConfig() { return {}; }
  setConfig(config) {
    this._config = { title: "Die nächsten 4 Tage", ...config };
    this._e = { ...FC_DEFAULTS, ...(config.entities || {}) };
    this._ue = config.entities || {};
    this._apr = false;
    this._built = false;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }
  getCardSize() { return 7; }
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
    this._draw();
  }
  _st(k) { return this._hass && this._hass.states[this._e[k]]; }
  _el(tag, attrs = {}, parent) {
    const n = document.createElementNS(FC_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }
  _moreInfo(entityId) {
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  _build() {
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
:host{display:block}
ha-card{display:block;position:relative;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,#1d3047 0%,#0d1621 55%,#081019 100%);
 color:#e8eef5;border:1px solid rgba(255,255,255,.06);padding:14px 10px 10px}
.head{display:flex;align-items:center;gap:8px;margin:0 6px 4px;flex-wrap:wrap}
.head .t{font-size:15px;font-weight:500;color:#cfdbe7;flex:1;white-space:nowrap}
.head .live{width:7px;height:7px;border-radius:50%;background:#FFC94D;box-shadow:0 0 8px #FFC94D;animation:blink 2s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
.leg{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#9fb2c6}
.leg span{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none;transition:opacity .3s}
.leg span.off{opacity:.3}
.leg i{display:inline-block;width:14px;height:3px;border-radius:2px}
.stage{perspective:1200px}
.tilt{transform-style:preserve-3d;transition:transform .6s cubic-bezier(.2,.8,.2,1)}
svg{width:100%;height:auto;display:block;overflow:visible}
.t{font-family:var(--ha-font-family-body,Roboto,sans-serif)}
.draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 2.4s cubic-bezier(.4,.1,.2,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.fadein{opacity:0;animation:fade 1.2s ease-out forwards}
@keyframes fade{to{opacity:1}}
.star{animation:tw 3s ease-in-out infinite}
@keyframes tw{50%{opacity:.15}}
.now{animation:nowp 2s ease-in-out infinite}
@keyframes nowp{50%{opacity:.35}}
.spin{transform-box:fill-box;transform-origin:center;animation:spin 16s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.drift{animation:drift 6s ease-in-out infinite}
@keyframes drift{50%{transform:translateX(3px)}}
.rain{animation:rain 1.1s linear infinite}
@keyframes rain{from{transform:translateY(-2px);opacity:0}30%{opacity:1}to{transform:translateY(7px);opacity:0}}
.day{cursor:pointer}
.day:hover .dbg{fill:rgba(255,255,255,.05)}
.tip{position:absolute;pointer-events:none;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.5;white-space:nowrap;
 background:rgba(12,22,33,.94);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 20px rgba(0,0,0,.5);opacity:0;transition:opacity .2s}
.tip b{color:#fff}
.tip .r{display:flex;justify-content:space-between;gap:14px}
.layer{transition:opacity .4s}
.rv{transform-origin:0 0;animation:rv 2.2s cubic-bezier(.4,.1,.2,1) both}
@keyframes rv{from{transform:scaleX(0)}to{transform:scaleX(1)}}
</style>
<ha-card>
 <div class="head"><span class="live"></span><span class="t" id="title"></span><div class="leg" id="leg"></div></div>
 <div class="stage"><div class="tilt" id="tilt"><svg viewBox="0 0 860 330" id="svg"></svg></div></div>
 <div class="tip" id="tip"></div>
</ha-card>`;
    this._svg = root.getElementById("svg");
    this._tip = root.getElementById("tip");
    root.getElementById("title").textContent = this._config.title;
    this._hidden = {};
    const leg = root.getElementById("leg");
    [["pv", "PV wahrscheinlich", "#F2B347"], ["band", "Spanne", "rgba(255,227,163,.5)"], ["load", "Verbrauch", "#85B7EB"],
     ["soc", "Akku-SoC", "#8BD46A"], ["min", "Mindest-SoC", "#F28C4B"]].forEach(([k, l, c]) => {
      const s = document.createElement("span");
      s.innerHTML = `<i style="background:${c}"></i>${l}`;
      s.addEventListener("click", () => {
        this._hidden[k] = !this._hidden[k];
        s.classList.toggle("off", this._hidden[k]);
        const g = this._svg.querySelector(`#L_${k}`);
        if (g) g.style.opacity = this._hidden[k] ? 0 : 1;
      });
      leg.appendChild(s);
    });
    const card = root.querySelector("ha-card"), tilt = root.getElementById("tilt");
    card.addEventListener("pointermove", (ev) => {
      const r = card.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
      tilt.style.transform = `rotateY(${x * 4}deg) rotateX(${-y * 3}deg)`;
    });
    card.addEventListener("pointerleave", () => { tilt.style.transform = ""; this._hover(null); });
    this._built = true;
  }

  _draw() {
    const fs = this._st("forecast");
    const rows = (fs && fs.attributes.stunden) || [];
    const days = (fs && fs.attributes.tage) || [];
    const tgtS = this._st("target");
    const minSoc = tgtS ? parseFloat(tgtS.state) : NaN;
    const svg = this._svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!rows.length) {
      this._el("text", { x: 430, y: 165, "text-anchor": "middle", fill: "#8aa0b6", class: "t", "font-size": 14 }, svg).textContent = "Noch keine Prognose";
      return;
    }

    const W = 860, H = 330, L = 34, R = 826, T = 74, B = 290;
    const n = rows.length;
    const X = (i) => L + (i / (n - 1)) * (R - L);
    const maxKw = Math.max(1, ...rows.map((r) => Math.max(r.p90 || 0, r.last || 0))) * 1.12;
    const Y = (v) => B - (Math.max(0, v || 0) / maxKw) * (B - T);
    const YS = (p) => B - (Math.max(0, Math.min(100, p)) / 100) * (B - T);

    const defs = this._el("defs", {}, svg);
    defs.innerHTML = `
      <linearGradient id="gPv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC94D" stop-opacity=".85"/><stop offset="1" stop-color="#F2B347" stop-opacity=".04"/></linearGradient>
      <linearGradient id="gBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE3A3" stop-opacity=".28"/><stop offset="1" stop-color="#FFE3A3" stop-opacity=".02"/></linearGradient>
      <linearGradient id="gSoc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5DCAA5"/><stop offset="1" stop-color="#8BD46A"/></linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <clipPath id="reveal"><rect class="rv" x="0" y="0" width="${W}" height="${H}"/></clipPath>`;

    // Tage: Hintergrund, Nacht, Kopf
    const dayIdx = [];
    rows.forEach((r, i) => {
      const d = new Date(r.t).toDateString();
      if (!dayIdx.length || dayIdx[dayIdx.length - 1].key !== d) dayIdx.push({ key: d, start: i, end: i });
      else dayIdx[dayIdx.length - 1].end = i;
    });
    const bg = this._el("g", {}, svg);
    dayIdx.forEach((d, k) => {
      const x0 = k === 0 ? L : (X(d.start - 1) + X(d.start)) / 2;
      const x1 = k === dayIdx.length - 1 ? R : (X(d.end) + X(d.end + 1)) / 2;
      const info = days[k] || {};
      const g = this._el("g", { class: "day fadein", style: `animation-delay:${k * 120}ms` }, bg);
      this._el("rect", { class: "dbg", x: x0, y: 8, width: x1 - x0, height: B - 8, rx: 10, fill: k % 2 ? "rgba(255,255,255,.018)" : "rgba(255,255,255,0)" }, g);
      // Nachtschatten: Stunden ohne P90
      let ns = null;
      for (let i = d.start; i <= d.end + 1; i++) {
        const night = i <= d.end && !(rows[i].p90 > 0.02);
        if (night && ns === null) ns = i;
        if ((!night || i > d.end) && ns !== null) {
          const a = Math.max(x0, X(ns) - (R - L) / (n - 1) / 2), b = Math.min(x1, X(i - 1) + (R - L) / (n - 1) / 2);
          this._el("rect", { x: a, y: T - 6, width: Math.max(0, b - a), height: B - T + 6, fill: "rgba(4,10,20,.35)" }, g);
          for (let s = 0; s < 3; s++) {
            const sx = a + ((s * 37 + k * 13) % Math.max(10, b - a - 10)) + 5, sy = T + 6 + ((s * 23 + k * 7) % 40);
            this._el("circle", { class: "star", cx: sx, cy: sy, r: 0.9, fill: "#cfdbe7", style: `animation-delay:${(s + k) * 0.7}s` }, g);
          }
          ns = null;
        }
      }
      if (k > 0) this._el("line", { x1: x0, x2: x0, y1: 16, y2: B, stroke: "rgba(255,255,255,.07)" }, g);
      // Kopf
      const cx = (x0 + x1) / 2;
      const dt = new Date(rows[d.start].t);
      const label = info.tag && info.tag.length <= 7 ? info.tag : `${FC_DAYS[dt.getDay()]} ${dt.getDate()}.`;
      this._el("text", { x: x0 + 12, y: 30, fill: "#e8eef5", class: "t", "font-size": 14, "font-weight": 600 }, g).textContent = label;
      const pv = info.pv_p50, use = info.verbrauch;
      this._el("text", { x: x0 + 12, y: 50, fill: "#FFC94D", class: "t", "font-size": 12.5 }, g).textContent = pv != null ? `☀ ${ffmt(pv)} kWh` : "";
      this._el("text", { x: x0 + 12, y: 65, fill: "#8aa0b6", class: "t", "font-size": 11 }, g).textContent =
        info.pv_p10 != null ? `sicher ${ffmt(info.pv_p10)} · Verbr. ${ffmt(use, 0)}` : "";
      this._weather(g, x1 - 30, 36, pv != null && use ? pv / use : 0);
      g.addEventListener("click", () => this._moreInfo(this._e.forecast));
    });

    // Achsen
    const ax = this._el("g", { class: "fadein" }, svg);
    const step = maxKw > 6 ? 2 : maxKw > 3 ? 1 : 0.5;
    for (let v = step; v < maxKw; v += step) {
      this._el("line", { x1: L, x2: R, y1: Y(v), y2: Y(v), stroke: "rgba(255,255,255,.05)", "stroke-dasharray": "2 4" }, ax);
      this._el("text", { x: L - 6, y: Y(v) + 3, fill: "#5f7286", class: "t", "font-size": 9.5, "text-anchor": "end" }, ax).textContent = ffmt(v, step < 1 ? 1 : 0);
    }
    this._el("text", { x: L - 6, y: B + 3, fill: "#5f7286", class: "t", "font-size": 9.5, "text-anchor": "end" }, ax).textContent = "0";
    this._el("text", { x: L - 6, y: T - 10, fill: "#5f7286", class: "t", "font-size": 9.5, "text-anchor": "end" }, ax).textContent = "kW";
    [0, 50, 100].forEach((p) => {
      this._el("text", { x: R + 4, y: YS(p) + 3, fill: "#4f7a5a", class: "t", "font-size": 9.5 }, ax).textContent = p + "%";
    });
    dayIdx.forEach((d) => {
      for (let i = d.start; i <= d.end; i++) {
        const h = new Date(rows[i].t).getHours();
        if (h % 6 === 0 && h) this._el("text", { x: X(i), y: B + 16, fill: "#5f7286", class: "t", "font-size": 9.5, "text-anchor": "middle" }, ax).textContent = h + "h";
      }
    });
    this._el("line", { x1: L, x2: R, y1: B, y2: B, stroke: "rgba(255,255,255,.15)" }, ax);

    // Datenebenen (mit Wisch-Animation)
    const data = this._el("g", { "clip-path": "url(#reveal)" }, svg);
    const pts = (key, fy = Y) => rows.map((r, i) => (r[key] === undefined ? null : [X(i), fy(r[key])]));
    const area = (p) => {
      const q = p.filter(Boolean);
      return q.length ? `${fcSmooth(q)} L${q[q.length - 1][0]},${B} L${q[0][0]},${B} Z` : "";
    };
    // Spanne P10–P90
    const gBand = this._el("g", { id: "L_band", class: "layer" }, data);
    this._el("path", { d: area(pts("p90")), fill: "url(#gBand)" }, gBand);
    const p10 = fcSmooth(pts("p10").filter(Boolean));
    this._el("path", { d: p10, fill: "none", stroke: "rgba(255,255,255,.55)", "stroke-width": 1.2, "stroke-dasharray": "3 4" }, gBand);
    // P50
    const gPv = this._el("g", { id: "L_pv", class: "layer" }, data);
    this._el("path", { d: area(pts("p50")), fill: "url(#gPv)" }, gPv);
    const p50 = fcSmooth(pts("p50").filter(Boolean));
    this._el("path", { d: p50, fill: "none", stroke: "#FFC94D", "stroke-width": 2.2, filter: "url(#glow)" }, gPv);
    // Sonnenfunken entlang P50 in den Sonnenstunden
    if (rows.some((r) => r.p50 > 0.05)) {
      const sp = this._el("path", { d: p50, fill: "none", stroke: "none", id: "p50path" }, gPv);
      for (let s = 0; s < 6; s++) {
        const c = this._el("circle", { r: 2.2, fill: "#FFE3A3", filter: "url(#glow)", opacity: 0.9 }, gPv);
        const am = this._el("animateMotion", { dur: "14s", repeatCount: "indefinite", begin: `${s * 2.3}s` }, c);
        this._el("mpath", { href: "#p50path" }, am);
        this._el("animate", { attributeName: "opacity", values: "0;1;1;0", dur: "14s", repeatCount: "indefinite", begin: `${s * 2.3}s` }, c);
      }
      void sp;
    }
    // Verbrauch
    const gLoad = this._el("g", { id: "L_load", class: "layer" }, svg);
    const lp = this._el("path", { d: fcSmooth(pts("last").filter(Boolean)), fill: "none", stroke: "#85B7EB", "stroke-width": 1.8, opacity: 0.9 }, gLoad);
    this._dash(lp, 0.3);
    // Mindest-SoC
    const gMin = this._el("g", { id: "L_min", class: "layer fadein", style: "animation-delay:1.4s" }, svg);
    if (!isNaN(minSoc)) {
      this._el("line", { x1: L, x2: R, y1: YS(minSoc), y2: YS(minSoc), stroke: "#F28C4B", "stroke-width": 1.6, "stroke-dasharray": "7 6", opacity: 0.85 }, gMin)
        .appendChild(this._anim("stroke-dashoffset", "0", "-26", "1.6s"));
      this._el("text", { x: L + 6, y: YS(minSoc) - 5, fill: "#F28C4B", class: "t", "font-size": 10.5 }, gMin).textContent = `Mindest-SoC ${Math.round(minSoc)} %`;
    }
    // SoC
    const gSoc = this._el("g", { id: "L_soc", class: "layer" }, svg);
    const socPts = pts("soc", YS).filter(Boolean);
    if (socPts.length > 1) {
      const sp = this._el("path", { d: fcSmooth(socPts), fill: "none", stroke: "url(#gSoc)", "stroke-width": 2.8, filter: "url(#glow)", "stroke-linecap": "round" }, gSoc);
      this._dash(sp, 0.6);
      const last = socPts[socPts.length - 1];
      void last;
    }

    // Jetzt-Marker
    const now = Date.now();
    const iNow = rows.findIndex((r) => r.t > now) - 1;
    if (iNow >= 0) {
      const frac = (now - rows[iNow].t) / 3600000;
      const xn = X(iNow) + frac * (X(1) - X(0));
      const gN = this._el("g", { class: "fadein", style: "animation-delay:.8s" }, svg);
      this._el("rect", { x: L, y: T - 6, width: Math.max(0, xn - L), height: B - T + 6, fill: "rgba(8,16,25,.35)" }, gN);
      this._el("line", { class: "now", x1: xn, x2: xn, y1: T - 8, y2: B, stroke: "#F2B347", "stroke-width": 1.5, "stroke-dasharray": "3 3" }, gN);
      this._el("rect", { x: xn - 18, y: B + 4, width: 36, height: 15, rx: 7.5, fill: "#F2B347" }, gN);
      this._el("text", { x: xn, y: B + 15, fill: "#1a1300", class: "t", "font-size": 10, "font-weight": 700, "text-anchor": "middle" }, gN).textContent = "Jetzt";
      const sNow = rows[Math.max(iNow, rows.findIndex((r) => r.soc !== undefined))];
      if (sNow && sNow.soc !== undefined) {
        const cy = YS(sNow.soc);
        this._el("circle", { cx: xn, cy, r: 9, fill: "none", stroke: "#8BD46A", "stroke-width": 1.5 }, gN)
          .appendChild(this._anim("r", "4", "14", "2s", "indefinite"));
        this._el("circle", { cx: xn, cy, r: 4, fill: "#8BD46A", filter: "url(#glow)" }, gN);
      }
    }

    // Hover-Ebene
    this._rows = rows; this._X = X; this._geo = { L, R, T, B, n, W, H };
    const cross = this._el("g", { opacity: 0, "pointer-events": "none" }, svg);
    this._cross = cross;
    this._crossLine = this._el("line", { y1: T - 8, y2: B, stroke: "rgba(255,255,255,.4)", "stroke-width": 1 }, cross);
    this._crossDots = ["p50", "last", "soc"].map((k) => this._el("circle", { r: 3.5, fill: { p50: "#FFC94D", last: "#85B7EB", soc: "#8BD46A" }[k], stroke: "#081019", "stroke-width": 1.5 }, cross));
    this._YY = { p50: Y, last: Y, soc: YS };
    const hit = this._el("rect", { x: L, y: 8, width: R - L, height: B - 8, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (ev) => {
      const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
      const sp = p.matrixTransform(svg.getScreenCTM().inverse());
      this._hover(Math.round(((sp.x - L) / (R - L)) * (n - 1)), ev);
    });
    hit.addEventListener("pointerleave", () => this._hover(null));
    hit.addEventListener("click", () => this._moreInfo(this._e.forecast));
  }

  _anim(attr, from, to, dur, rep = "indefinite") {
    const a = document.createElementNS(FC_NS, "animate");
    a.setAttribute("attributeName", attr); a.setAttribute("from", from); a.setAttribute("to", to);
    a.setAttribute("dur", dur); a.setAttribute("repeatCount", rep);
    if (attr === "r") { a.setAttribute("values", `${from};${to}`); this._fadeWith(a, dur); }
    return a;
  }
  _fadeWith(a, dur) {
    queueMicrotask(() => {
      const c = a.parentNode; if (!c) return;
      const o = document.createElementNS(FC_NS, "animate");
      o.setAttribute("attributeName", "opacity"); o.setAttribute("values", "1;0"); o.setAttribute("dur", dur); o.setAttribute("repeatCount", "indefinite");
      c.appendChild(o);
    });
  }
  _dash(path, delay) {
    requestAnimationFrame(() => {
      let len = 2000;
      try { len = Math.ceil(path.getTotalLength()) + 2; } catch (e) { /* noop */ }
      path.style.setProperty("--len", len);
      path.style.animationDelay = `${delay}s`;
      path.classList.add("draw");
    });
  }

  _weather(g, x, y, ratio) {
    const w = this._el("g", { transform: `translate(${x},${y})` }, g);
    if (ratio >= 0.6) {
      const s = this._el("g", { class: "spin" }, w);
      for (let a = 0; a < 360; a += 45) this._el("line", { x1: 0, y1: -14, x2: 0, y2: -10, stroke: "#FFC94D", "stroke-width": 1.8, "stroke-linecap": "round", transform: `rotate(${a})` }, s);
      this._el("circle", { r: 7, fill: "#FFC94D", filter: "url(#glow)" }, w);
    } else if (ratio >= 0.25) {
      const s = this._el("g", { class: "spin", transform: "translate(-5,-5)" }, w);
      for (let a = 0; a < 360; a += 60) this._el("line", { x1: 0, y1: -11, x2: 0, y2: -8, stroke: "#FFC94D", "stroke-width": 1.6, "stroke-linecap": "round", transform: `rotate(${a})` }, s);
      this._el("circle", { cx: -5, cy: -5, r: 5.5, fill: "#FFC94D" }, w);
      this._cloud(w, 3, 3, "#cfdbe7");
    } else {
      this._cloud(w, 0, 0, "#9fb2c6");
      for (let i = 0; i < 3; i++) {
        this._el("line", { class: "rain", x1: -6 + i * 6, y1: 9, x2: -8 + i * 6, y2: 14, stroke: "#85B7EB", "stroke-width": 1.6, "stroke-linecap": "round", style: `animation-delay:${i * 0.35}s` }, w);
      }
    }
  }
  _cloud(g, x, y, c) {
    const d = this._el("g", { class: "drift" }, g);
    this._el("path", { d: `M${x - 11},${y + 6} a6,6 0 0 1 1,-11 a8,8 0 0 1 15,-2 a6,6 0 0 1 6,8 a5,5 0 0 1 -2,5 Z`, fill: c, opacity: 0.95 }, d);
  }

  _hover(i, ev) {
    if (i === null || i === undefined || !this._rows || i < 0 || i >= this._rows.length) {
      if (this._cross) this._cross.setAttribute("opacity", 0);
      this._tip.style.opacity = 0;
      return;
    }
    const r = this._rows[i], x = this._X(i);
    this._cross.setAttribute("opacity", 1);
    this._crossLine.setAttribute("x1", x); this._crossLine.setAttribute("x2", x);
    ["p50", "last", "soc"].forEach((k, j) => {
      const c = this._crossDots[j];
      if (r[k] === undefined) { c.setAttribute("opacity", 0); return; }
      c.setAttribute("opacity", 1); c.setAttribute("cx", x); c.setAttribute("cy", this._YY[k](r[k]));
    });
    const d = new Date(r.t);
    this._tip.innerHTML = `<b>${FC_DAYS[d.getDay()]} ${d.getHours()}:00</b>
      <div class="r"><span style="color:#FFC94D">PV</span><span>${ffmt(r.p50, 2)} kW <span style="color:#8aa0b6">(${ffmt(r.p10, 1)}–${ffmt(r.p90, 1)})</span></span></div>
      <div class="r"><span style="color:#85B7EB">Verbrauch</span><span>${ffmt(r.last, 2)} kW</span></div>
      ${r.soc !== undefined ? `<div class="r"><span style="color:#8BD46A">Akku</span><span>${Math.round(r.soc)} %</span></div>` : ""}`;
    const card = this.shadowRoot.querySelector("ha-card").getBoundingClientRect();
    const tw = this._tip.offsetWidth || 160;
    let left = (ev ? ev.clientX : card.left) - card.left + 14;
    if (left + tw > card.width - 6) left -= tw + 28;
    this._tip.style.left = `${left}px`;
    this._tip.style.top = `${(ev ? ev.clientY : card.top) - card.top - 40}px`;
    this._tip.style.opacity = 1;
  }
}

if (!customElements.get("akku-planer-forecast-card")) {
  customElements.define("akku-planer-forecast-card", AkkuPlanerForecastCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "akku-planer-forecast-card", name: "Akku-Planer 4-Tage-Vorschau", description: "Animierte Stundenprognose PV, Verbrauch und Akku", preview: false });
  console.info(`%c AKKU-PLANER-FC %c ${FC_VERSION} `, "background:#FFC94D;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
