/* Akku-Planer Kennzahlen – animierte Kacheln im Stil der Akku-Planer-Card */
const KPI_VERSION = "1.0.0";


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

const KPI_DEFAULTS = {
  refill: "sensor.akku_planer_sichere_nachladung",
  drain: "sensor.akku_planer_verbrauch_bis_nachladung",
  soc_refill: "sensor.akku_planer_erwarteter_soc_bei_nachladung",
  accuracy: "sensor.akku_planer_prognosegenauigkeit_7_tage",
  storm: "binary_sensor.akku_planer_unwetter_reserve_aktiv",
  cerbo: "number.victron_mqtt_system_0_system_ess_min_soc_limit",
  target: "sensor.akku_planer_geplanter_mindest_soc",
  soc: "sensor.victron_mqtt_battery_512_battery_soc",
  model: "sensor.akku_planer_gelernte_pv_leistung",
  floor: "number.akku_planer_untergrenze_bei_sonne",
  mode: "select.akku_planer_betriebsart",
};
const KPI_DAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const kfmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : Number(v).toFixed(d).replace(".", ","));
const socColor = (p) => (p === null ? "#6b7c8f" : p < 20 ? "#F0605D" : p < 50 ? "#F2B347" : "#8BD46A");

class AkkuPlanerKpiCard extends HTMLElement {
  static getStubConfig() { return {}; }
  setConfig(config) {
    this._config = { tilt: true, ...config };
    this._e = { ...KPI_DEFAULTS, ...(config.entities || {}) };
    this._ue = config.entities || {};
    this._apr = false;
    this._built = false;
    this._shown = {};
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }
  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._apr) this._apr = apResolve(hass, this._e, this._ue, { storm: "storm" });
    if (!this._built) this._build();
    const keys = Object.values(this._e).map((id) => {
      const s = hass.states[id];
      return s ? s.state + "|" + (s.last_updated || "") : "x";
    }).join(";");
    if (keys === this._lastKeys) return;
    this._lastKeys = keys;
    this._update();
  }

  _st(k) { return this._hass && this._hass.states[this._e[k]]; }
  _num(k) { const s = this._st(k); const v = s ? parseFloat(s.state) : NaN; return isNaN(v) ? null : v; }
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
ha-card{display:block;overflow:hidden;background:radial-gradient(120% 90% at 15% 0%,#1d3047 0%,#0d1621 55%,#081019 100%);
 color:#e8eef5;border:1px solid rgba(255,255,255,.06);padding:14px}
.head{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:500;margin:0 2px 12px;color:#cfdbe7}
.head .live{width:7px;height:7px;border-radius:50%;background:#8BD46A;box-shadow:0 0 8px #8BD46A;animation:blink 2s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;perspective:900px}
.tile{position:relative;border-radius:16px;padding:12px 12px 10px;cursor:pointer;min-height:132px;
 background:linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.02));
 border:1px solid rgba(255,255,255,.07);box-shadow:0 10px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);
 transform-style:preserve-3d;transition:transform .5s cubic-bezier(.2,.8,.2,1),box-shadow .4s;
 animation:enter .8s cubic-bezier(.2,.8,.2,1) both}
.tile:hover{box-shadow:0 16px 32px rgba(0,0,0,.45),0 0 0 1px var(--c,rgba(255,255,255,.15)) inset}
.tile::after{content:"";position:absolute;inset:0;border-radius:16px;pointer-events:none;
 background:radial-gradient(80% 60% at var(--mx,30%) var(--my,0%),rgba(255,255,255,.09),transparent 60%)}
@keyframes enter{from{opacity:0;transform:translateY(14px) rotateX(18deg)}to{opacity:1;transform:none}}
.lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8aa0b6;margin-bottom:4px}
.row{display:flex;align-items:center;gap:10px;transform:translateZ(18px)}
.vis{flex:0 0 74px;height:74px}
.vis svg{width:74px;height:74px;overflow:visible}
.val{font-size:22px;font-weight:600;line-height:1.1;white-space:nowrap}
.val small{font-size:12px;font-weight:400;color:#9fb2c6;margin-left:3px}
.sub{font-size:11.5px;color:#9fb2c6;margin-top:3px;line-height:1.35}
.foot{font-size:11px;color:#7f93a8;margin-top:8px;transform:translateZ(10px)}
.spin{transform-box:fill-box;transform-origin:center;animation:spin 14s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
.arc{transition:stroke-dashoffset 1.6s cubic-bezier(.2,.8,.2,1)}
.flow{animation:flow 1.2s linear infinite}
@keyframes flow{to{stroke-dashoffset:-16}}
.sweep{transform-origin:37px 37px;animation:spin 3.2s linear infinite}
.liq{transition:transform 1.6s cubic-bezier(.2,.8,.2,1)}
.draw{stroke-dasharray:400;stroke-dashoffset:400;animation:draw 2.2s .3s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.needle{transition:transform 1.4s cubic-bezier(.2,.8,.2,1)}
.ring{transform-box:fill-box;transform-origin:center;animation:ripple 2.8s ease-out infinite}
@keyframes ripple{from{transform:scale(.4);opacity:.9}to{transform:scale(1.25);opacity:0}}
</style>
<ha-card>
 <div class="head"><span class="live"></span>Kennzahlen</div>
 <div class="grid" id="grid"></div>
</ha-card>`;
    this._grid = root.getElementById("grid");
    const defs = [
      ["refill", "Sichere Nachladung", this._svgRefill()],
      ["drain", "Verbrauch bis dahin", this._svgDrain()],
      ["soc_refill", "SoC bei Nachladung", this._svgBattery()],
      ["accuracy", "Trefferquote 7 Tage", this._svgTarget()],
      ["storm", "Unwetter-Reserve", this._svgShield()],
      ["cerbo", "Cerbo Mindest-SoC", this._svgCompare()],
    ];
    this._t = {};
    defs.forEach(([key, label, svg], i) => {
      const el = document.createElement("div");
      el.className = "tile";
      el.style.animationDelay = `${i * 90}ms`;
      el.innerHTML = `<div class="lbl">${label}</div><div class="row"><div class="vis">${svg}</div>
        <div><div class="val"></div><div class="sub"></div></div></div><div class="foot"></div>`;
      el.addEventListener("click", () => this._moreInfo(this._e[key]));
      if (this._config.tilt) {
        el.addEventListener("pointermove", (ev) => {
          const r = el.getBoundingClientRect();
          const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
          el.style.transform = `rotateY(${(x - 0.5) * 14}deg) rotateX(${(0.5 - y) * 12}deg)`;
          el.style.setProperty("--mx", x * 100 + "%");
          el.style.setProperty("--my", y * 100 + "%");
        });
        el.addEventListener("pointerleave", () => { el.style.transform = ""; });
      }
      this._grid.appendChild(el);
      this._t[key] = {
        el, val: el.querySelector(".val"), sub: el.querySelector(".sub"), foot: el.querySelector(".foot"),
        q: (s) => el.querySelector(s),
      };
    });
    this._built = true;
  }

  /* ---------- SVG-Bausteine ---------- */
  _svgRefill() {
    // 270°-Bogen, r=28, Umfang 175.9 -> 3/4 = 131.9
    return `<svg viewBox="0 0 74 74"><defs>
      <linearGradient id="rg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#F2B347"/><stop offset="1" stop-color="#FFE3A3"/></linearGradient>
      <filter id="gl"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
      <g transform="rotate(135 37 37)">
       <circle cx="37" cy="37" r="28" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7" stroke-linecap="round" stroke-dasharray="131.9 200"/>
       <circle class="arc p50" cx="37" cy="37" r="28" fill="none" stroke="#F2B347" stroke-opacity=".35" stroke-width="7" stroke-linecap="round" stroke-dasharray="131.9 200" stroke-dashoffset="131.9"/>
       <circle class="arc p10g" cx="37" cy="37" r="28" fill="none" stroke="#F2B347" stroke-width="7" stroke-linecap="round" stroke-dasharray="131.9 200" stroke-dashoffset="131.9" filter="url(#gl)" opacity=".7"/>
       <circle class="arc p10" cx="37" cy="37" r="28" fill="none" stroke="url(#rg)" stroke-width="7" stroke-linecap="round" stroke-dasharray="131.9 200" stroke-dashoffset="131.9"/>
      </g>
      <g class="spin"><g stroke="#FFC94D" stroke-width="1.6" stroke-linecap="round">
       ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="37" y1="25" x2="37" y2="28.5" transform="rotate(${a} 37 37)"/>`).join("")}</g></g>
      <circle cx="37" cy="37" r="6.5" fill="#FFC94D"/><circle cx="37" cy="37" r="11" fill="#FFC94D" opacity=".18" class="pulse"/>
    </svg>`;
  }
  _svgDrain() {
    return `<svg viewBox="0 0 74 74">
      <path d="M14 36 L37 17 L60 36 V60 H14 Z" fill="rgba(133,183,235,.12)" stroke="#85B7EB" stroke-width="1.6" stroke-linejoin="round"/>
      <rect x="31" y="44" width="12" height="16" rx="1.5" fill="rgba(133,183,235,.25)"/>
      <rect class="win pulse" x="20" y="40" width="8" height="7" rx="1" fill="#FFD27A"/>
      <rect class="win pulse" x="46" y="40" width="8" height="7" rx="1" fill="#FFD27A" style="animation-delay:1.1s"/>
      <path class="flow" d="M2 68 H72" stroke="#85B7EB" stroke-width="3" stroke-dasharray="5 3" stroke-linecap="round" opacity=".8"/>
      <g class="fill"><rect x="2" y="70.5" width="70" height="2.5" rx="1.25" fill="rgba(255,255,255,.08)"/>
       <rect class="drainbar" x="2" y="70.5" width="0" height="2.5" rx="1.25" fill="#85B7EB" style="transition:width 1.6s cubic-bezier(.2,.8,.2,1)"/></g>
    </svg>`;
  }
  _svgBattery() {
    return `<svg viewBox="0 0 74 74"><defs>
      <clipPath id="bc"><path d="M22 14 V62 A15 4.5 0 0 0 52 62 V14 Z"/></clipPath>
      <linearGradient id="lq" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="l1" stop-color="#F0605D"/><stop offset="1" class="l2" stop-color="#8e2422"/></linearGradient></defs>
      <path d="M22 14 V62 A15 4.5 0 0 0 52 62 V14" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.25)" stroke-width="1.2"/>
      <g clip-path="url(#bc)"><g class="liq" style="transform:translateY(62px)">
        <path fill="url(#lq)" d="M10 0 Q 18 -3 26 0 T 42 0 T 58 0 T 74 0 V 80 H10 Z">
          <animateTransform attributeName="transform" type="translate" values="0 0;-16 0;0 0" dur="3.5s" repeatCount="indefinite"/></path>
      </g></g>
      <ellipse cx="37" cy="14" rx="15" ry="4.5" fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.3)" stroke-width="1.2"/>
      <rect x="33" y="7" width="8" height="5" rx="1.5" fill="rgba(255,255,255,.3)"/>
      <circle cx="30" cy="58" r="1.4" fill="#fff" opacity=".6"><animate attributeName="cy" values="60;22" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;0" dur="3s" repeatCount="indefinite"/></circle>
      <circle cx="44" cy="58" r="1" fill="#fff" opacity=".6"><animate attributeName="cy" values="60;26" dur="2.3s" begin="1s" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;0" dur="2.3s" begin="1s" repeatCount="indefinite"/></circle>
    </svg>`;
  }
  _svgTarget() {
    return `<svg viewBox="0 0 74 74">
      <circle cx="37" cy="37" r="30" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="5"/>
      <circle cx="37" cy="37" r="20" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="5"/>
      <circle cx="37" cy="37" r="9" fill="rgba(255,255,255,.12)"/>
      <circle class="acc arc" cx="37" cy="37" r="30" fill="none" stroke="#8BD46A" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="188.5 300" stroke-dashoffset="188.5" transform="rotate(-90 37 37)"/>
      <circle class="ring" cx="37" cy="37" r="30" fill="none" stroke="#8BD46A" stroke-width="1.5"/>
      <g class="arrow" style="transition:transform 1.4s cubic-bezier(.2,.8,.2,1),opacity .6s;transform:translate(30px,-30px);opacity:0">
        <line x1="37" y1="37" x2="58" y2="16" stroke="#e8eef5" stroke-width="2" stroke-linecap="round"/>
        <path d="M58 16 l-1 6 l5 -5 z M58 16 l-6 1 l5 -5 z" fill="#e8eef5"/>
        <circle cx="37" cy="37" r="2.5" fill="#e8eef5"/></g>
    </svg>`;
  }
  _svgShield() {
    return `<svg viewBox="0 0 74 74"><defs>
      <linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="s1" stop-color="#8BD46A" stop-opacity="0"/><stop offset="1" class="s2" stop-color="#8BD46A" stop-opacity=".55"/></linearGradient>
      <clipPath id="sc"><path d="M37 8 L60 16 V36 C60 51 50 61 37 67 C24 61 14 51 14 36 V16 Z"/></clipPath></defs>
      <g clip-path="url(#sc)"><path class="sweep" d="M37 37 L37 -10 A47 47 0 0 1 77 15 Z" fill="url(#sw)"/></g>
      <path class="shield" d="M37 8 L60 16 V36 C60 51 50 61 37 67 C24 61 14 51 14 36 V16 Z" fill="rgba(139,212,106,.1)" stroke="#8BD46A" stroke-width="1.8" stroke-linejoin="round"/>
      <path class="ok draw" d="M27 37 L34 44 L48 29" fill="none" stroke="#8BD46A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <g class="warn" style="display:none"><path d="M37 24 V42" stroke="#F0605D" stroke-width="4" stroke-linecap="round"/><circle cx="37" cy="51" r="2.6" fill="#F0605D"/></g>
    </svg>`;
  }
  _svgCompare() {
    // senkrechte Skala 0–100 %, links Cerbo, rechts geplant
    return `<svg viewBox="0 0 74 74"><defs>
      <linearGradient id="sk" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#F0605D"/><stop offset=".3" stop-color="#F2B347"/><stop offset=".7" stop-color="#8BD46A"/></linearGradient></defs>
      <rect x="32" y="6" width="10" height="62" rx="5" fill="url(#sk)" opacity=".25"/>
      <rect class="socfill" x="32" y="6" width="10" height="62" rx="5" fill="url(#sk)" style="transition:clip-path 1.4s;clip-path:inset(100% 0 0 0)"/>
      <g class="needle nc" style="transform:translateY(68px)"><path d="M10 0 H30" stroke="#6FA8F0" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M30 0 l-5 -3.5 v7 z" fill="#6FA8F0"/><text x="2" y="-3" font-size="7" fill="#6FA8F0">Cerbo</text></g>
      <g class="needle nt" style="transform:translateY(68px)"><path d="M44 0 H64" stroke="#F28C4B" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="3 2.5"/>
        <path d="M44 0 l5 -3.5 v7 z" fill="#F28C4B"/><text x="49" y="-3" font-size="7" fill="#F28C4B">Plan</text></g>
    </svg>`;
  }

  /* ---------- Werte ---------- */
  _count(tile, key, value, decimals, unit) {
    const from = this._shown[key] ?? 0;
    this._shown[key] = value;
    if (value === null) { tile.val.innerHTML = `–`; return; }
    const t0 = performance.now(), dur = 1200;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      tile.val.innerHTML = `${kfmt(from + (value - from) * e, decimals)}<small>${unit}</small>`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  _when(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date();
    const h = Math.round((d - now) / 3600000);
    const day = d.toDateString() === now.toDateString() ? "heute" : KPI_DAYS[d.getDay()];
    const hm = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    return `${day} ${hm}` + (h > 0 ? ` · in ${h} h` : "");
  }

  _update() {
    const T = this._t;
    const model = this._st("model");
    const cap = (model && model.attributes.kapazitaet_kwh) || 20;
    const soc = this._num("soc"), floor = this._num("floor") ?? 14;

    // 1 Sichere Nachladung
    const rf = this._st("refill"), p10 = this._num("refill");
    const p50 = rf ? rf.attributes.p50 : null;
    const L = 131.9, frac = (v) => Math.max(0, Math.min(1, (v || 0) / cap));
    T.refill.el.style.setProperty("--c", "rgba(242,179,71,.5)");
    for (const c of ["p10", "p10g"]) T.refill.q("." + c).style.strokeDashoffset = L * (1 - frac(p10));
    T.refill.q(".p50").style.strokeDashoffset = L * (1 - frac(p50));
    this._count(T.refill, "refill", p10, 1, "kWh");
    T.refill.sub.textContent = rf && rf.attributes.beginn ? `ab ${this._when(rf.attributes.beginn)}` : "kein Sonnenfenster in Sicht";
    T.refill.foot.textContent = p50 != null ? `wahrscheinlich ${kfmt(p50)} kWh · ${Math.round(frac(p10) * 100)} % Akku` : "";

    // 2 Verbrauch bis dahin
    const drain = this._num("drain");
    const usable = soc !== null ? Math.max(0, ((soc - floor) / 100) * cap) : null;
    this._count(T.drain, "drain", drain, 1, "kWh");
    const ratio = drain !== null ? drain / cap : null;
    T.drain.sub.textContent = ratio !== null ? `≈ ${kfmt(ratio)}× Akkuinhalt` : "";
    T.drain.q(".drainbar").setAttribute("width", 70 * Math.min(1, usable !== null && drain ? usable / drain : 0));
    T.drain.foot.textContent = usable === null ? "" : usable < 0.2 ? "Akku steht auf Untergrenze – Rest aus dem Netz" : `Akku deckt ${kfmt(usable)} kWh davon`;
    T.drain.el.style.setProperty("--c", "rgba(133,183,235,.5)");

    // 3 SoC bei Nachladung
    const sr = this._num("soc_refill"), srS = this._st("soc_refill");
    this._count(T.soc_refill, "soc_refill", sr, 0, "%");
    T.soc_refill.q(".liq").style.transform = `translateY(${14 + 48 * (1 - Math.max(0, Math.min(100, sr || 0)) / 100) - 2}px)`;
    const sc = socColor(sr);
    T.soc_refill.q(".l1").setAttribute("stop-color", sc);
    T.soc_refill.q(".l2").setAttribute("stop-color", sc === "#8BD46A" ? "#2f6b15" : sc === "#F2B347" ? "#9a5a12" : "#8e2422");
    T.soc_refill.el.style.setProperty("--c", sc + "88");
    T.soc_refill.sub.textContent = sr === null ? "" : sr <= floor + 1 ? "Akku erreicht Untergrenze" : sr < 50 ? "knapp, aber reicht" : "komfortabel";
    T.soc_refill.foot.innerHTML = this._spark(srS && srS.attributes.verlauf_p10, sc);

    // 4 Trefferquote
    const acc = this._num("accuracy"), accS = this._st("accuracy");
    const days = accS && accS.attributes.tage ? accS.attributes.tage.length : 0;
    const ac = acc === null ? "#6b7c8f" : acc >= 80 ? "#8BD46A" : acc >= 60 ? "#F2B347" : "#F0605D";
    T.accuracy.q(".acc").style.strokeDashoffset = 188.5 * (1 - (acc || 0) / 100);
    T.accuracy.q(".acc").setAttribute("stroke", ac);
    T.accuracy.q(".ring").setAttribute("stroke", ac);
    const arrow = T.accuracy.q(".arrow");
    if (acc !== null) {
      const miss = (100 - acc) / 100 * 22;
      requestAnimationFrame(() => { arrow.style.opacity = 1; arrow.style.transform = `translate(${miss * 0.6}px,${-miss * 0.4}px)`; });
      this._count(T.accuracy, "accuracy", acc, 0, "%");
      T.accuracy.sub.textContent = acc >= 80 ? "Prognose sitzt" : acc >= 60 ? "ordentlich" : "Wetter war launisch";
    } else {
      arrow.style.opacity = 0;
      T.accuracy.val.innerHTML = `<span style="font-size:15px">lernt noch</span>`;
      T.accuracy.sub.textContent = "Vergleich startet morgen";
    }
    T.accuracy.foot.textContent = `${days} von 7 Tagen erfasst`;
    T.accuracy.el.style.setProperty("--c", ac + "88");

    // 5 Unwetter
    const stS = this._st("storm"), on = stS && stS.state === "on";
    const lvl = stS ? stS.attributes.warnstufe || 0 : 0;
    const col = on ? "#F0605D" : "#8BD46A";
    T.storm.q(".shield").setAttribute("stroke", col);
    T.storm.q(".shield").setAttribute("fill", on ? "rgba(240,96,93,.14)" : "rgba(139,212,106,.1)");
    T.storm.q(".s1").setAttribute("stop-color", col); T.storm.q(".s2").setAttribute("stop-color", col);
    T.storm.q(".ok").style.display = on ? "none" : "";
    T.storm.q(".warn").style.display = on ? "" : "none";
    T.storm.val.innerHTML = on ? `Aktiv` : `Sicher`;
    T.storm.val.style.color = col;
    T.storm.sub.textContent = on ? `Warnstufe ${lvl} · Reserve hoch` : lvl ? `Warnstufe ${lvl}` : "keine Warnung";
    T.storm.foot.textContent = stS && stS.attributes.netz_verfuegbar === false ? "⚡ Inselbetrieb" : "Netz verfügbar";
    T.storm.el.style.setProperty("--c", col + "88");

    // 6 Cerbo vs. Plan
    const cerbo = this._num("cerbo"), target = this._num("target");
    const y = (p) => 68 - 62 * Math.max(0, Math.min(100, p || 0)) / 100;
    T.cerbo.q(".nc").style.transform = `translateY(${y(cerbo)}px)`;
    T.cerbo.q(".nt").style.transform = `translateY(${y(target)}px)`;
    T.cerbo.q(".socfill").style.clipPath = `inset(${100 - (soc || 0)}% 0 0 0 round 5px)`;
    this._count(T.cerbo, "cerbo", cerbo, 0, "%");
    const mode = this._st("mode");
    const same = cerbo !== null && target !== null && Math.abs(cerbo - target) < 1;
    T.cerbo.sub.textContent = target === null ? "" : `Plan ${Math.round(target)} %`;
    T.cerbo.foot.textContent = same ? "✓ übernommen" : mode && mode.state === "observe" ? "Schattenbetrieb – nicht geschrieben" : "wird angepasst";
    T.cerbo.el.style.setProperty("--c", "rgba(111,168,240,.5)");
  }

  _spark(arr, color) {
    if (!arr || arr.length < 2) return "";
    const w = 140, h = 16, n = arr.length;
    const pts = arr.map((v, i) => `${(i / (n - 1)) * w},${h - (Math.max(0, Math.min(100, v)) / 100) * h}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h + 2}" style="width:100%;height:18px;overflow:visible" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" class="draw" vector-effect="non-scaling-stroke"/></svg>`;
  }
}

if (!customElements.get("akku-planer-kpi-card")) {
  customElements.define("akku-planer-kpi-card", AkkuPlanerKpiCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "akku-planer-kpi-card", name: "Akku-Planer Kennzahlen", description: "Animierte Kennzahlen-Kacheln", preview: false });
  console.info(`%c AKKU-PLANER-KPI %c ${KPI_VERSION} `, "background:#8BD46A;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
