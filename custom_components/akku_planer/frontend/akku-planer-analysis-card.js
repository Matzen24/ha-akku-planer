/* Akku-Planer Analyse – SoC-Verlauf, Prognose gegen Ist und gelerntes PV-Modell im Stil der Akku-Planer-Card */
const ANA_VERSION = "1.2.0";

/* Finds the Akku-Planer entities on any system: the integration publishes their ids in the
 * attribute "akku_planer" of its "planned minimum SoC" sensor. Entities set in the card config win. */
var AP_KEYS = {
  target: "target_min_soc", accuracy: "accuracy", model: "pv_model", soc: "soc", cerbo: "min_soc",
  retrain: "retrain", reserve: "reserve_soc", floor: "floor_soc",
};
var apResolve = function (hass, ents, userEnts) {
  let map = null;
  for (const id in hass.states) {
    const a = hass.states[id].attributes;
    if (a && a.akku_planer && typeof a.akku_planer === "object") { map = a.akku_planer; break; }
  }
  if (!map) return false;
  for (const k of Object.keys(ents)) {
    if (userEnts && userEnts[k]) continue;
    if (AP_KEYS[k] && AP_KEYS[k] in map) ents[k] = map[AP_KEYS[k]] || "";
  }
  return map;
};

const ANA_DEFAULTS = {
  soc: "sensor.victron_mqtt_battery_512_battery_soc",
  target: "sensor.akku_planer_geplanter_mindest_soc",
  cerbo: "number.victron_mqtt_system_0_system_ess_min_soc_limit",
  accuracy: "sensor.akku_planer_prognosegenauigkeit_7_tage",
  model: "sensor.akku_planer_gelernte_pv_leistung",
  retrain: "button.akku_planer_modelle_neu_lernen",
  reserve: "number.akku_planer_notstrom_reserve",
  floor: "number.akku_planer_untergrenze_bei_sonne",
};
const ANA_NS = "http://www.w3.org/2000/svg";
const ANA_WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const afmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : Number(v).toFixed(d).replace(".", ","));
const C = { soc: "#8BD46A", plan: "#F2B347", cerbo: "#85B7EB", fc: "#F2B347", act: "#8BD46A", bad: "#F0605D" };

/* Direction of a learned surface from its name (German and English) -> compass degrees, null = flat */
const DIRS = [
  [/s(ü|ue)dost|south.?east/i, 135], [/s(ü|ue)dwest|south.?west/i, 225], [/nordost|north.?east/i, 45],
  [/nordwest|north.?west/i, 315], [/\bost\b|east/i, 90], [/west/i, 270], [/s(ü|ue)d|south/i, 180], [/nord|north/i, 0],
];
const surfDir = (name) => { for (const [re, d] of DIRS) if (re.test(name)) return d; return null; };

class AkkuPlanerAnalysisCard extends HTMLElement {
  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = { days: 7, ...config };
    this._e = { ...ANA_DEFAULTS, ...(config.entities || {}) };
    this._ue = config.entities || {};
    this._apr = false;
    this._built = false;
    this._hist = null;
    this._histAt = 0;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }

  getCardSize() { return 14; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._apr) {
      this._apr = apResolve(hass, this._e, this._ue);
      if (this._apr && !this._apr.retrain && !this._ue.retrain && hass.entities) {
        const b = Object.values(hass.entities).find((e) => e.platform === "akku_planer" && e.entity_id.startsWith("button."));
        if (b) this._e.retrain = b.entity_id;
      }
    }
    if (!this._built) this._build();
    if (Date.now() - this._histAt > 10 * 60 * 1000) this._loadHistory();
    const sig = ["accuracy", "model", "soc"].map((k) => { const s = hass.states[this._e[k]]; return s ? s.last_updated : "x"; }).join("|");
    if (sig !== this._sig) { this._sig = sig; this._renderFc(); this._renderModel(); }
  }

  _st(k) { return this._hass && this._hass.states[this._e[k]]; }
  _moreInfo(entityId) {
    if (!entityId) return;
    const ev = new Event("hass-more-info", { bubbles: true, composed: true });
    ev.detail = { entityId };
    this.dispatchEvent(ev);
  }

  _build() {
    this._built = true;
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
:host{display:block}
ha-card{display:block;overflow:hidden;container-type:inline-size;color:#e8eef5;border:1px solid rgba(255,255,255,.06);padding:14px;
 background:radial-gradient(120% 90% at 15% 0%,#1d3047 0%,#0d1621 55%,#081019 100%)}
.wrap{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:12px}
.panel{position:relative;border-radius:16px;padding:12px 14px;min-width:0;
 background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));
 border:1px solid rgba(255,255,255,.07);box-shadow:0 10px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);
 animation:enter .8s cubic-bezier(.2,.8,.2,1) both}
.panel.full{grid-column:1/-1}
#pFc{display:flex;flex-direction:column}
#pFc .fcrow{flex:1}
.panel:nth-child(2){animation-delay:.12s}.panel:nth-child(3){animation-delay:.24s}
@keyframes enter{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:15px;font-weight:500;color:#cfdbe7;margin-bottom:8px}
.head .legend{margin-left:auto}
.head ha-icon{--mdc-icon-size:18px;color:#F2B347}
.head .sp{flex:1}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11.5px;color:#9fb2c6}
.legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{display:inline-flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;font-size:12.5px;color:#b9c7d6;
 background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);cursor:pointer}
.chip b{color:#e8eef5;font-weight:600}
svg{display:block;width:100%;height:auto;overflow:visible}
.ax{font-size:10px;fill:#7f93a8}
.grid line{stroke:rgba(255,255,255,.07);stroke-dasharray:3 4}
.draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:draw 2.4s .2s cubic-bezier(.3,.7,.2,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.fade{opacity:0;animation:fade 1.2s 1s ease forwards}
@keyframes fade{to{opacity:1}}
.tip{position:absolute;pointer-events:none;padding:6px 9px;border-radius:10px;font-size:12px;line-height:1.45;white-space:nowrap;
 background:rgba(8,16,25,.92);border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 20px rgba(0,0,0,.45);opacity:0;transition:opacity .15s}
.tip b{font-weight:600}
.empty{color:#7f93a8;font-size:13px;padding:24px 0;text-align:center}
.bar{transform-box:fill-box;transform-origin:bottom;animation:grow 1.1s cubic-bezier(.2,.8,.2,1) both}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.fcrow{display:flex;gap:12px;align-items:center}
.fcrow .chart{flex:1;min-width:0}
.gauge{flex:0 0 108px;text-align:center;cursor:pointer}
.gauge .big{font-size:22px;font-weight:600;margin-top:-62px}
.gauge .lbl{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#8aa0b6;margin-top:30px}
.arc{transition:stroke-dashoffset 1.8s cubic-bezier(.2,.8,.2,1)}
.src{border-top:1px solid rgba(255,255,255,.06);padding-top:10px;margin-top:10px}
.src:first-of-type{border-top:none;padding-top:0;margin-top:0}
.srch{display:flex;align-items:baseline;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:6px}
.srch span{font-weight:400;font-size:11.5px;color:#9fb2c6}
.srcrow{display:flex;gap:12px;align-items:center}
.compass{flex:0 0 112px}
.surfs{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.sf{font-size:12px;color:#b9c7d6}
.sf .t{display:flex;justify-content:space-between}
.sf .t b{color:#e8eef5}
.sf .track{height:7px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:3px}
.sf .fill{height:100%;border-radius:4px;width:0;transition:width 1.4s cubic-bezier(.2,.8,.2,1);
 background:linear-gradient(90deg,#c9781f,#F2B347 60%,#FFD27A);box-shadow:0 0 10px rgba(242,179,71,.45)}
.sf.low .fill{background:linear-gradient(90deg,#4f7fb8,#85B7EB);box-shadow:0 0 10px rgba(133,183,235,.4)}
.sum{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.kp{flex:1;min-width:110px;border-radius:12px;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}
.kp .l{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#8aa0b6}
.kp .v{font-size:19px;font-weight:600;margin-top:2px}
.kp .v small{font-size:11.5px;font-weight:400;color:#9fb2c6;margin-left:3px}
.btn{margin-top:12px;display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;cursor:pointer;color:#e8eef5;
 padding:9px 12px;border-radius:12px;border:1px solid rgba(242,179,71,.35);font:inherit;font-size:13.5px;
 background:linear-gradient(160deg,rgba(242,179,71,.16),rgba(242,179,71,.04));transition:box-shadow .3s,transform .2s}
.btn:hover{box-shadow:0 0 0 1px rgba(242,179,71,.6) inset,0 0 18px rgba(242,179,71,.25)}
.btn:active{transform:scale(.98)}
.btn ha-icon{--mdc-icon-size:20px;color:#F2B347}
.btn.busy ha-icon{animation:spin 1.2s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.btn small{margin-left:auto;color:#9fb2c6;font-size:11.5px}
.sun{transform-box:fill-box;transform-origin:center;animation:spin 30s linear infinite}
@container (max-width:720px){.wrap{grid-template-columns:minmax(0,1fr)}}
@container (max-width:480px){.fcrow{flex-direction:column}.gauge{flex:0 0 auto}.srcrow{flex-direction:column;align-items:stretch}.compass{align-self:center}ha-card{padding:10px}.panel{padding:10px}}
</style>
<ha-card>
 <div class="wrap">
  <div class="panel full" id="pHist">
   <div class="head"><ha-icon icon="mdi:scale-balance"></ha-icon>Hätte der Planer richtig entschieden?<span class="sp"></span>
    <div class="legend"><span><i style="background:${C.soc}"></i>Akku-SoC</span><span><i style="background:${C.plan}"></i>Planer: Mindest-SoC</span><span><i style="background:${C.cerbo}"></i>Wechselrichter: Mindest-SoC</span></div></div>
   <div class="sum" id="histSum"></div>
   <div id="hist" style="position:relative"><div class="empty">Verlauf wird geladen …</div></div>
  </div>
  <div class="panel" id="pFc">
   <div class="head"><ha-icon icon="mdi:solar-power-variant"></ha-icon>PV-Prognose gegen Ist<span class="sp"></span>
    <div class="legend"><span><i style="background:${C.fc}"></i>Prognose</span><span><i style="background:${C.act}"></i>Ist</span></div></div>
   <div class="fcrow"><div class="chart" id="fc" style="position:relative"></div><div class="gauge" id="gauge"></div></div>
   <div class="sum" id="fcSum" style="margin:12px 0 0"></div>
  </div>
  <div class="panel" id="pModel">
   <div class="head"><ha-icon icon="mdi:school"></ha-icon>Was das Modell gelernt hat</div>
   <div id="model"></div>
   <button class="btn" id="retrain"><ha-icon icon="mdi:refresh"></ha-icon>Modelle neu lernen<small id="retrainSub"></small></button>
  </div>
 </div>
</ha-card>`;
    this._r = root;
    this._ro = new ResizeObserver(() => {
      const w = Math.round(root.getElementById("hist").clientWidth);
      if (this._hist && Math.abs(w - (this._histW || 0)) > 24) this._renderHist();
    });
    this._ro.observe(root.getElementById("hist"));
    root.getElementById("retrain").addEventListener("click", () => this._retrain());
  }

  async _retrain() {
    const id = this._e.retrain;
    const btn = this._r.getElementById("retrain");
    if (!id || btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    this._r.getElementById("retrainSub").textContent = "lernt …";
    try {
      await this._hass.callService("button", "press", { entity_id: id });
      this._r.getElementById("retrainSub").textContent = "fertig";
    } catch (e) {
      this._r.getElementById("retrainSub").textContent = "Fehler";
    }
    setTimeout(() => btn.classList.remove("busy"), 1500);
  }

  /* ---------- 1. SoC history ---------- */
  async _loadHistory() {
    this._histAt = Date.now();
    const ids = ["soc", "target", "cerbo"].map((k) => this._e[k]).filter((id) => id && this._hass.states[id]);
    if (!ids.length) return;
    const end = new Date();
    const start = new Date(end.getTime() - this._config.days * 864e5);
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period", start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      const series = {};
      for (const k of ["soc", "target", "cerbo"]) {
        const rows = res[this._e[k]] || [];
        series[k] = rows.map((r) => [((r.lu || r.lc) * 1000), parseFloat(r.s)]).filter((p) => !isNaN(p[1]) && p[0]);
      }
      this._hist = { start: start.getTime(), end: end.getTime(), series };
      this._renderHist();
    } catch (e) {
      this._r.getElementById("hist").innerHTML = `<div class="empty">Verlauf nicht verfügbar</div>`;
    }
  }

  _bucket(points, start, end, stepMs) {
    // time-weighted average per bucket, carrying the last value forward
    const out = [];
    let i = 0, last = null;
    while (i < points.length && points[i][0] <= start) { last = points[i][1]; i++; }
    for (let t = start; t < end; t += stepMs) {
      let sum = 0, w = 0, cur = last, tc = t;
      while (i < points.length && points[i][0] < t + stepMs) {
        if (cur !== null) { sum += cur * (points[i][0] - tc); w += points[i][0] - tc; }
        cur = points[i][1]; tc = points[i][0]; i++;
      }
      if (cur !== null) { sum += cur * (t + stepMs - tc); w += t + stepMs - tc; }
      last = cur;
      out.push([t + stepMs / 2, w > 0 ? sum / w : null]);
    }
    return out;
  }

  _renderHist() {
    const box = this._r.getElementById("hist");
    const h = this._hist;
    if (!h || !h.series.soc.length) { box.innerHTML = `<div class="empty">Noch kein Verlauf vorhanden</div>`; return; }
    const W = Math.max(320, Math.round(box.clientWidth || 900)), H = 230, L = 34, R = 8, T = 10, B = 26;
    this._histW = W;
    const x = (t) => L + ((t - h.start) / (h.end - h.start)) * (W - L - R);
    const y = (v) => T + (1 - v / 100) * (H - T - B);
    const soc = this._bucket(h.series.soc, h.start, h.end, 20 * 60 * 1000).filter((p) => p[1] !== null);

    // smooth SoC path (Catmull-Rom -> Bezier)
    const pts = soc.map((p) => [x(p[0]), y(p[1])]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
    }
    const area = `${d} L${pts[pts.length - 1][0]},${y(0)} L${pts[0][0]},${y(0)} Z`;
    const step = (series) => {
      const s = series.filter((p) => p[0] >= h.start - 864e5);
      if (!s.length) return "";
      let v = s[0][1], out = `M${x(h.start)},${y(v)}`;
      for (const [t, val] of s) { if (t < h.start) { v = val; out = `M${x(h.start)},${y(v)}`; continue; } out += ` H${x(t)} V${y(val)}`; v = val; }
      return out + ` H${x(h.end)}`;
    };

    // night shading and day labels
    let nights = "", days = "";
    const d0 = new Date(h.start); d0.setHours(0, 0, 0, 0);
    for (let t = d0.getTime(); t < h.end + 864e5; t += 864e5) {
      const ns = Math.max(h.start, t - 6 * 36e5), ne = Math.min(h.end, t + 7 * 36e5);
      if (ne > ns) nights += `<rect x="${x(ns)}" y="${T}" width="${x(ne) - x(ns)}" height="${H - T - B}" fill="rgba(80,110,170,.07)"/>`;
      const noon = t + 12 * 36e5;
      if (noon > h.start && noon < h.end) {
        const dd = new Date(t);
        days += `<text class="ax" x="${x(noon)}" y="${H - 8}" text-anchor="middle">${ANA_WD[dd.getDay()]} ${dd.getDate()}.</text>`;
      }
    }
    let grid = "";
    for (const v of [0, 25, 50, 75, 100]) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;

    const res = this._st("reserve") ? parseFloat(this._st("reserve").state) : null;
    const resLine = res !== null && !isNaN(res)
      ? `<line x1="${L}" x2="${W - R}" y1="${y(res)}" y2="${y(res)}" stroke="rgba(242,140,75,.35)" stroke-dasharray="2 6"/><text class="ax" x="${W - R}" y="${y(res) - 4}" text-anchor="end" fill="#F28C4B">Reserve ${Math.round(res)} %</text>` : "";

    box.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" style="height:${H}px">
 <defs>
  <linearGradient id="socg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.soc}" stop-opacity=".45"/><stop offset="1" stop-color="${C.soc}" stop-opacity="0"/></linearGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <clipPath id="reveal"><rect x="${L}" y="0" width="0" height="${H}"><animate attributeName="width" from="0" to="${W}" dur="2.2s" begin="0.2s" fill="freeze" calcMode="spline" keySplines=".3 .7 .2 1"/></rect></clipPath>
 </defs>
 ${nights}<g class="grid">${grid}</g>${resLine}${days}
 <g clip-path="url(#reveal)">
  <path d="${area}" fill="url(#socg)"/>
  <path d="${step(h.series.cerbo)}" fill="none" stroke="${C.cerbo}" stroke-width="1.6" stroke-dasharray="5 4" opacity=".9"/>
  <path d="${step(h.series.target)}" fill="none" stroke="${C.plan}" stroke-width="2" filter="url(#glow)"/>
  <path d="${d}" fill="none" stroke="${C.soc}" stroke-width="2.4" stroke-linejoin="round" filter="url(#glow)"/>
 </g>
 <line id="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="rgba(255,255,255,.35)" opacity="0"/>
 <circle id="dot" r="4.5" fill="${C.soc}" stroke="#081019" stroke-width="2" opacity="0"/>
 <rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
</svg><div class="tip" id="tip"></div>`;

    // summary
    const vals = soc.map((p) => p[1]);
    const min = Math.min(...vals), avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const minT = soc[vals.indexOf(min)][0];
    let changes = 0;
    for (let i = 1; i < h.series.target.length; i++) if (h.series.target[i][1] !== h.series.target[i - 1][1] && h.series.target[i][0] >= h.start) changes++;
    let below = 0;
    const tgtB = this._bucket(h.series.target, h.start, h.end, 20 * 60 * 1000);
    soc.forEach((p, i) => { const t = tgtB.find((q) => q[0] === p[0]); if (t && t[1] !== null && p[1] < t[1] - 2) below++; });
    const md = new Date(minT);
    this._r.getElementById("histSum").innerHTML = `
     <div class="kp"><div class="l">Tiefster Stand</div><div class="v" style="color:${min < 20 ? C.bad : C.soc}">${Math.round(min)}<small>% · ${ANA_WD[md.getDay()]} ${String(md.getHours()).padStart(2, "0")}:00</small></div></div>
     <div class="kp"><div class="l">Ø Akkustand</div><div class="v">${Math.round(avg)}<small>%</small></div></div>
     <div class="kp"><div class="l">Plan-Änderungen</div><div class="v">${changes}<small>in ${this._config.days} Tagen</small></div></div>
     <div class="kp"><div class="l">Unter Plan</div><div class="v" style="color:${below ? C.plan : C.soc}">${afmt(below / 3, 1)}<small>Std.</small></div></div>`;

    // hover
    const svg = box.querySelector("svg"), tip = box.querySelector("#tip"), cross = box.querySelector("#cross"), dot = box.querySelector("#dot");
    const valAt = (series, t) => { let v = null; for (const p of series) { if (p[0] > t) break; v = p[1]; } return v; };
    box.querySelector("#hit").addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = h.start + ((px - L) / (W - L - R)) * (h.end - h.start);
      let best = soc[0];
      for (const p of soc) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      cross.setAttribute("x1", x(best[0])); cross.setAttribute("x2", x(best[0])); cross.setAttribute("opacity", 1);
      dot.setAttribute("cx", x(best[0])); dot.setAttribute("cy", y(best[1])); dot.setAttribute("opacity", 1);
      const dt = new Date(best[0]);
      const pl = valAt(h.series.target, best[0]), ce = valAt(h.series.cerbo, best[0]);
      tip.innerHTML = `${ANA_WD[dt.getDay()]} ${dt.getDate()}. ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}<br>
        <span style="color:${C.soc}">●</span> Akku <b>${Math.round(best[1])} %</b><br>
        <span style="color:${C.plan}">●</span> Planer <b>${pl === null ? "–" : Math.round(pl) + " %"}</b><br>
        <span style="color:${C.cerbo}">●</span> Wechselrichter <b>${ce === null ? "–" : Math.round(ce) + " %"}</b>`;
      const left = (x(best[0]) / W) * r.width;
      tip.style.left = Math.min(r.width - 170, Math.max(0, left + 12)) + "px";
      tip.style.top = "10px";
      tip.style.opacity = 1;
    });
    box.querySelector("#hit").addEventListener("mouseleave", () => { tip.style.opacity = 0; cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); });
  }

  /* ---------- 2. forecast vs actual ---------- */
  _renderFc() {
    const s = this._st("accuracy");
    const box = this._r.getElementById("fc"), gauge = this._r.getElementById("gauge");
    const days = (s && Array.isArray(s.attributes.tage) ? s.attributes.tage : []).slice(-7);
    if (!days.length) { box.innerHTML = `<div class="empty">Noch keine abgeschlossenen Tage</div>`; gauge.innerHTML = ""; return; }
    const W = 420, H = 200, B = 34, T = 22;
    const max = Math.max(1, ...days.map((d) => Math.max(d.prognose || 0, d.ist || 0))) * 1.12;
    const slot = W / days.length, bw = Math.min(26, slot * 0.28), dep = bw * 0.45;
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const prism = (x0, v, col, delay) => {
      const top = y(v), base = H - B;
      return `<g class="bar" style="animation-delay:${delay}s">
        <path d="M${x0},${top} L${x0 + dep},${top - dep * .55} L${x0 + bw + dep},${top - dep * .55} L${x0 + bw},${top} Z" fill="${col}" opacity=".95"/>
        <path d="M${x0 + bw},${top} L${x0 + bw + dep},${top - dep * .55} L${x0 + bw + dep},${base - dep * .55} L${x0 + bw},${base} Z" fill="${col}" opacity=".55"/>
        <rect x="${x0}" y="${top}" width="${bw}" height="${Math.max(0, base - top)}" fill="url(#g${col.slice(1)})"/>
        <text x="${x0 + bw / 2}" y="${top - dep * .55 - 5}" text-anchor="middle" style="font-size:10.5px;fill:#cfdbe7">${afmt(v, 1)}</text></g>`;
    };
    let bars = "";
    days.forEach((d, i) => {
      const cx = slot * i + slot / 2;
      bars += prism(cx - bw - 2, d.prognose || 0, C.fc, i * 0.08) + prism(cx + 2, d.ist || 0, C.act, i * 0.08 + 0.05);
      const dt = new Date(d.datum + "T12:00:00");
      const err = d.ist ? Math.abs((d.prognose || 0) - d.ist) / d.ist : null;
      const ok = err !== null && err <= 0.25;
      bars += `<text class="ax" x="${cx}" y="${H - 18}" text-anchor="middle">${ANA_WD[dt.getDay()]} ${dt.getDate()}.</text>
        <text x="${cx}" y="${H - 4}" text-anchor="middle" style="font-size:10px;fill:${err === null ? "#7f93a8" : ok ? C.act : C.plan}">${err === null ? "" : (ok ? "✓ " : "") + "±" + Math.round(err * 100) + " %"}</text>`;
    });
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="height:auto">
      <defs>
       <linearGradient id="g${C.fc.slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD27A"/><stop offset="1" stop-color="#d9861e"/></linearGradient>
       <linearGradient id="g${C.act.slice(1)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b6f08f"/><stop offset="1" stop-color="#4f9a3a"/></linearGradient>
      </defs>
      <path d="M0,${H - B} L${dep},${H - B - dep * .55} L${W},${H - B - dep * .55} L${W - dep},${H - B} Z" fill="rgba(255,255,255,.04)"/>
      ${bars}</svg>`;

    const q = parseFloat(s.state);
    const R = 44, circ = 2 * Math.PI * R * 0.75;
    const col = isNaN(q) ? "#6b7c8f" : q >= 80 ? C.act : q >= 60 ? C.plan : C.bad;
    gauge.innerHTML = `<svg viewBox="0 0 108 108" style="width:108px;height:108px">
       <g transform="rotate(135 54 54)">
        <circle cx="54" cy="54" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${circ} 999"/>
        <circle class="arc" cx="54" cy="54" r="${R}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${circ} 999" stroke-dashoffset="${circ}" style="filter:drop-shadow(0 0 6px ${col})"/>
       </g></svg>
      <div class="big" style="color:${col}">${isNaN(q) ? "–" : Math.round(q)}<small style="font-size:12px;color:#9fb2c6"> %</small></div>
      <div class="lbl">Trefferquote</div>`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const arc = gauge.querySelector(".arc");
      if (arc && !isNaN(q)) arc.style.strokeDashoffset = circ * (1 - Math.max(0, Math.min(100, q)) / 100);
    }));
    gauge.onclick = () => this._moreInfo(this._e.accuracy);
    const sp = days.reduce((x, d) => x + (d.prognose || 0), 0), si = days.reduce((x, d) => x + (d.ist || 0), 0);
    const errs = days.filter((d) => d.ist).map((d) => Math.abs((d.prognose || 0) - d.ist) / d.ist);
    const me = errs.length ? errs.reduce((x, e) => x + e, 0) / errs.length : null;
    this._r.getElementById("fcSum").innerHTML = `
     <div class="kp"><div class="l">Prognose</div><div class="v" style="color:${C.fc}">${afmt(sp, 1)}<small>kWh</small></div></div>
     <div class="kp"><div class="l">Ist</div><div class="v" style="color:${C.act}">${afmt(si, 1)}<small>kWh</small></div></div>
     <div class="kp"><div class="l">Ø Abweichung</div><div class="v">${me === null ? "–" : "±" + Math.round(me * 100)}<small>% / Tag</small></div></div>`;
  }

  /* ---------- 3. learned PV model ---------- */
  _compass(surfs) {
    const S = 112, c = S / 2, rMax = 40;
    const maxK = Math.max(0.1, ...surfs.map((s) => s.kwp));
    let g = "";
    for (const [lbl, deg] of [["N", 0], ["O", 90], ["S", 180], ["W", 270]]) {
      const a = (deg - 90) * Math.PI / 180;
      g += `<text x="${c + Math.cos(a) * 51}" y="${c + Math.sin(a) * 51 + 3.5}" text-anchor="middle" style="font-size:9.5px;fill:#7f93a8">${lbl}</text>`;
    }
    let flat = 0;
    surfs.forEach((s, i) => {
      if (s.dir === null) { flat += s.kwp; return; }
      const a = (s.dir - 90) * Math.PI / 180, len = 12 + (s.kwp / maxK) * (rMax - 12), half = 0.42;
      const p1 = [c + Math.cos(a - half) * 9, c + Math.sin(a - half) * 9];
      const p2 = [c + Math.cos(a - half * .55) * len, c + Math.sin(a - half * .55) * len];
      const p3 = [c + Math.cos(a + half * .55) * len, c + Math.sin(a + half * .55) * len];
      const p4 = [c + Math.cos(a + half) * 9, c + Math.sin(a + half) * 9];
      const wall = /wand|wall|fassade|facade/i.test(s.name);
      g += `<path d="M${p1} L${p2} L${p3} L${p4} Z" fill="url(#cg)" stroke="#FFD27A" stroke-width="${wall ? 1.2 : 0}" stroke-dasharray="${wall ? "3 2" : ""}"
        style="filter:drop-shadow(0 0 5px rgba(242,179,71,.55));transform-origin:${c}px ${c}px;animation:enter .9s ${0.1 * i}s both"/>`;
    });
    const fr = flat > 0 ? 6 + (flat / maxK) * 10 : 5;
    return `<svg viewBox="0 0 ${S} ${S}" style="width:${S}px;height:${S}px">
      <defs><radialGradient id="cg" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#FFD27A"/><stop offset="1" stop-color="#d9861e"/></radialGradient></defs>
      <circle cx="${c}" cy="${c}" r="${rMax + 2}" fill="rgba(255,255,255,.025)" stroke="rgba(255,255,255,.08)"/>
      <circle cx="${c}" cy="${c}" r="${(rMax + 2) / 2}" fill="none" stroke="rgba(255,255,255,.05)" stroke-dasharray="2 4"/>
      ${g}
      <g class="sun"><circle cx="${c}" cy="${c}" r="${fr}" fill="#F2B347" opacity="${flat > 0 ? 1 : .35}" style="filter:drop-shadow(0 0 6px rgba(242,179,71,.8))"/>
       ${[0, 45, 90, 135, 180, 225, 270, 315].map((d) => { const a = d * Math.PI / 180; return `<line x1="${c + Math.cos(a) * (fr + 2)}" y1="${c + Math.sin(a) * (fr + 2)}" x2="${c + Math.cos(a) * (fr + 5)}" y2="${c + Math.sin(a) * (fr + 5)}" stroke="#F2B347" stroke-width="1.4" stroke-linecap="round" opacity="${flat > 0 ? .9 : .3}"/>`; }).join("")}</g>
    </svg>`;
  }

  _renderModel() {
    const s = this._st("model");
    const box = this._r.getElementById("model");
    if (!s) { box.innerHTML = `<div class="empty">Modell noch nicht verfügbar</div>`; return; }
    const a = s.attributes;
    const srcs = Object.entries(a).filter(([k, v]) => k.includes(".") && v && typeof v === "object" && v.flaechen_kwp);
    let html = `<div class="sum">
      <div class="kp"><div class="l">Effektive PV-Leistung</div><div class="v" style="color:${C.plan}">${afmt(parseFloat(s.state), 1)}<small>kWp</small></div></div>
      <div class="kp"><div class="l">Akku</div><div class="v">${afmt(a.kapazitaet_kwh, 1)}<small>kWh</small></div></div>
      ${a.verbrauchsmodell_stunden ? `<div class="kp"><div class="l">Verbrauch gelernt</div><div class="v">${Math.round(a.verbrauchsmodell_stunden / 24)}<small>Tage</small></div></div>` : ""}</div>`;
    for (const [eid, v] of srcs) {
      const st = this._hass.states[eid];
      const name = (st && st.attributes.friendly_name) || eid;
      const surfs = Object.entries(v.flaechen_kwp).filter(([n]) => !/anteil|share/i.test(n)).map(([n, k]) => ({ name: n, kwp: k, dir: surfDir(n) }));
      const low = Object.entries(v.flaechen_kwp).find(([n]) => /anteil|share/i.test(n));
      const maxK = Math.max(0.1, ...surfs.map((x) => x.kwp));
      html += `<div class="src">
        <div class="srch">${name}<span>${v.trainingsstunden} Std. gelernt · Fehler ±${Math.round((v.rmse_kw || 0) * 1000)} W${v.max_kw ? " · max " + afmt(v.max_kw, 1) + " kW" : ""}</span></div>
        <div class="srcrow"><div class="compass">${this._compass(surfs)}</div><div class="surfs">
          ${surfs.map((x) => `<div class="sf"><div class="t"><span>${x.name}</span><b>${afmt(x.kwp, 2)} kWp</b></div><div class="track"><div class="fill" data-w="${(x.kwp / maxK) * 100}"></div></div></div>`).join("")}
          ${low ? `<div class="sf low"><div class="t"><span>${low[0]}</span><b>${afmt(low[1] * 100, 0)} %</b></div><div class="track"><div class="fill" data-w="${Math.min(100, low[1] * 100)}"></div></div></div>` : ""}
        </div></div></div>`;
    }
    if (!srcs.length) html += `<div class="empty">Noch nicht genug Daten gelernt</div>`;
    box.innerHTML = html;
    requestAnimationFrame(() => requestAnimationFrame(() => box.querySelectorAll(".fill").forEach((f) => { f.style.width = f.dataset.w + "%"; })));
    box.querySelectorAll(".srch").forEach((n) => n.addEventListener("click", () => this._moreInfo(this._e.model)));
  }
}

if (!customElements.get("akku-planer-analysis-card")) {
  customElements.define("akku-planer-analysis-card", AkkuPlanerAnalysisCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "akku-planer-analysis-card", name: "Akku-Planer Analyse", description: "SoC-Verlauf, Prognose gegen Ist und gelerntes PV-Modell", preview: false });
  console.info(`%c AKKU-PLANER-ANALYSE %c ${ANA_VERSION} `, "background:#F2B347;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
