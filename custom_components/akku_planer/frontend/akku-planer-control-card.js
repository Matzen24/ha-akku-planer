/* Akku-Planer Steuerung – animierte, bedienbare Karte im Stil der Akku-Planer-Card */
const CTL_VERSION = "1.0.0";


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

const CTL_DEFAULTS = {
  mode: "select.akku_planer_betriebsart",
  auto: "switch.akku_planer_automatik",
  grid_charge: "binary_sensor.akku_planer_netznachladung",
  floor: "number.akku_planer_untergrenze_bei_sonne",
  reserve: "number.akku_planer_notstrom_reserve",
  storm: "number.akku_planer_reserve_bei_unwetter",
  target: "sensor.akku_planer_geplanter_mindest_soc",
  soc: "sensor.victron_mqtt_battery_512_battery_soc",
};

const CTL_MODES = {
  observe: { label: "Schatten", sub: "nur beobachten", color: "#9fb2c6",
    icon: `<g class="eye"><path d="M4 16 Q16 5 28 16 Q16 27 4 16 Z" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle class="iris" cx="16" cy="16" r="4.5" fill="currentColor"/></g>` },
  auto: { label: "Automatik", sub: "Wetter steuert", color: "#8BD46A",
    icon: `<g class="gear"><circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="2"/>
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="14.6" y="4" width="2.8" height="5" rx="1" fill="currentColor" transform="rotate(${a} 16 16)"/>`).join("")}</g>` },
  always_reserve: { label: "Reserve", sub: "immer halten", color: "#F28C4B",
    icon: `<g class="shieldi"><path d="M16 4 L26 8 V16 C26 22 21 26 16 28 C11 26 6 22 6 16 V8 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M11.5 16 L15 19.5 L21 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>` },
  full_use: { label: "Voll nutzen", sub: "bis Untergrenze", color: "#6FA8F0",
    icon: `<path class="bolt" d="M18 3 L8 18 H15 L13 29 L24 13 H17 Z" fill="currentColor"/>` },
};

const SLIDERS = [
  { key: "floor", label: "Untergrenze bei Sonne", short: "Sonne", color: "#8BD46A", pos: "below" },
  { key: "reserve", label: "Notstrom-Reserve", short: "Reserve", color: "#F2B347", pos: "above" },
  { key: "storm", label: "Reserve bei Unwetter", short: "Unwetter", color: "#F0605D", pos: "below" },
];

class AkkuPlanerControlCard extends HTMLElement {
  static getStubConfig() { return {}; }
  setConfig(config) {
    this._config = { ...config };
    this._e = { ...CTL_DEFAULTS, ...(config.entities || {}) };
    this._ue = config.entities || {};
    this._apr = false;
    this._built = false;
    this._drag = {};      // key -> Wert während Ziehen
    this._pending = {};   // key -> {v, until}
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
  }
  getCardSize() { return 7; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this._apr) this._apr = apResolve(hass, this._e, this._ue, { storm: "storm_reserve_soc" });
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
  _call(domain, service, data) { return this._hass.callService(domain, service, data); }
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
ha-card{display:block;position:relative;overflow:hidden;background:radial-gradient(120% 90% at 85% 0%,#1d3047 0%,#0d1621 55%,#081019 100%);
 color:#e8eef5;border:1px solid rgba(255,255,255,.06);padding:14px 14px 16px}
.head{display:flex;align-items:center;gap:8px;margin:0 2px 14px}
.head .t{font-size:15px;font-weight:500;color:#cfdbe7;flex:1}
.head .live{width:7px;height:7px;border-radius:50%;background:#8BD46A;box-shadow:0 0 8px #8BD46A;animation:blink 2s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
/* Automatik-Schalter */
.sw{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12.5px;color:#9fb2c6}
.track{position:relative;width:54px;height:28px;border-radius:999px;background:rgba(255,255,255,.08);
 border:1px solid rgba(255,255,255,.12);box-shadow:inset 0 2px 6px rgba(0,0,0,.5);transition:background .4s,border-color .4s}
.knob{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;
 background:radial-gradient(circle at 35% 30%,#fff,#aab8c6);box-shadow:0 3px 8px rgba(0,0,0,.5);
 transition:transform .45s cubic-bezier(.3,1.6,.5,1),box-shadow .4s}
.sw.on .track{background:rgba(139,212,106,.35);border-color:#8BD46A}
.sw.on .knob{transform:translateX(26px);box-shadow:0 0 12px #8BD46A,0 3px 8px rgba(0,0,0,.5)}
.sw.on b{color:#8BD46A}
/* Modi */
.modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;perspective:800px;margin-bottom:16px}
.mode{position:relative;border-radius:14px;padding:10px 10px 9px;cursor:pointer;display:flex;gap:9px;align-items:center;
 background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.07);
 color:#7f93a8;transition:transform .35s cubic-bezier(.2,.8,.2,1),border-color .35s,box-shadow .35s,color .35s,background .35s;
 animation:enter .7s cubic-bezier(.2,.8,.2,1) both}
.mode:hover{transform:translateY(-2px) rotateX(6deg)}
.mode:active{transform:scale(.96)}
.mode svg{width:30px;height:30px;flex:0 0 30px;overflow:visible}
.mode .l{font-size:13.5px;font-weight:600;color:#cfdbe7;line-height:1.15}
.mode .s{font-size:11px;color:#7f93a8}
.mode.act{color:var(--c);border-color:var(--c);background:linear-gradient(160deg,color-mix(in srgb,var(--c) 22%,transparent),rgba(255,255,255,.02));
 box-shadow:0 0 0 1px var(--c) inset,0 8px 22px color-mix(in srgb,var(--c) 30%,transparent)}
.mode.act .l{color:#fff}
.mode.busy{animation:busy .8s ease-in-out infinite}
@keyframes busy{50%{opacity:.5}}
@keyframes enter{from{opacity:0;transform:translateY(12px) rotateX(16deg)}to{opacity:1;transform:none}}
.mode.act .iris{animation:look 4s ease-in-out infinite}
@keyframes look{0%,100%{transform:translateX(0)}30%{transform:translateX(-3px)}60%{transform:translateX(3px)}}
.mode.act .eye{transform-origin:16px 16px;animation:wink 5s infinite}
@keyframes wink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
.mode.act .gear{transform-origin:16px 16px;animation:spin 6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.mode.act .shieldi{transform-origin:16px 16px;animation:beat 2.2s ease-in-out infinite}
@keyframes beat{0%,100%{transform:scale(1)}15%{transform:scale(1.12)}30%{transform:scale(1)}}
.mode.act .bolt{animation:flick 2.6s infinite}
@keyframes flick{0%,100%{opacity:1}10%{opacity:.35}12%{opacity:1}60%{opacity:.85}}
/* Akku-Leiste */
.lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8aa0b6;margin:0 2px 30px;display:flex;justify-content:space-between}
.lbl span:last-child{letter-spacing:0;text-transform:none}
.batwrap{position:relative;margin:0 14px 0 8px;padding:0 0 64px}
.bat{position:relative;height:46px;border-radius:12px;background:rgba(255,255,255,.04);
 border:1.5px solid rgba(255,255,255,.22);box-shadow:inset 0 4px 14px rgba(0,0,0,.6),0 10px 26px rgba(0,0,0,.35);overflow:hidden}
.bat::after{content:"";position:absolute;inset:0;border-radius:10px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.16),transparent 40%,transparent 70%,rgba(0,0,0,.25))}
.cap{position:absolute;right:-9px;top:14px;width:7px;height:18px;border-radius:0 4px 4px 0;background:rgba(255,255,255,.25)}
.zone{position:absolute;top:0;bottom:0;transition:left .5s,width .5s}
.liq{position:absolute;left:0;top:0;bottom:0;width:0;transition:width 1.6s cubic-bezier(.2,.8,.2,1);
 background:linear-gradient(180deg,var(--lc1,#8BD46A),var(--lc2,#2f6b15));box-shadow:0 0 18px var(--lc1,#8BD46A)}
.liq::before{content:"";position:absolute;right:-6px;top:0;bottom:0;width:12px;border-radius:50%;
 background:inherit;filter:brightness(1.25);animation:wave 2.4s ease-in-out infinite}
@keyframes wave{50%{transform:scaleX(.5) translateX(-4px)}}
.bub{position:absolute;bottom:4px;width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.6);animation:bub 3s linear infinite}
@keyframes bub{from{transform:translateY(0);opacity:.8}to{transform:translateY(-36px);opacity:0}}
.plan{position:absolute;top:-4px;bottom:-4px;width:0;border-left:2px dashed #fff;opacity:.7;transition:left 1.2s cubic-bezier(.2,.8,.2,1)}
.socl{position:absolute;top:13px;font-size:13px;font-weight:600;text-shadow:0 1px 4px rgba(0,0,0,.8);transition:left 1.6s cubic-bezier(.2,.8,.2,1);white-space:nowrap}
.h{position:absolute;top:-8px;width:0;height:62px;transition:left .5s cubic-bezier(.2,.8,.2,1);touch-action:none}
.h.drag{transition:none}
.h .line{position:absolute;left:-1.5px;top:0;width:3px;height:62px;border-radius:2px;background:var(--c);box-shadow:0 0 10px var(--c)}
.h .grip{position:absolute;left:-13px;width:26px;height:26px;border-radius:50%;cursor:grab;outline:none;
 background:radial-gradient(circle at 35% 30%,#fff 0%,var(--c) 45%,color-mix(in srgb,var(--c) 50%,#000) 100%);
 box-shadow:0 0 0 3px rgba(8,16,25,.85),0 0 14px var(--c),0 4px 10px rgba(0,0,0,.6);transition:transform .25s cubic-bezier(.3,1.6,.5,1)}
.h.below .grip{top:56px}.h.above .grip{top:-20px}
.h .grip:hover,.h .grip:focus-visible,.h.drag .grip{transform:scale(1.2)}
.h.drag .grip{cursor:grabbing}
.h .tag{position:absolute;white-space:nowrap;font-size:11.5px;color:var(--c);transform:translateX(-50%);pointer-events:none;
 text-align:center;line-height:1.15}
.h .tag b{display:block;font-size:14px;color:#fff}
.h.below .tag{top:86px}.h.above .tag{top:-56px}
.h.drag .tag b{color:var(--c)}
.h .pulse{position:absolute;left:-13px;width:26px;height:26px;border-radius:50%;border:2px solid var(--c);pointer-events:none;animation:ring 2.4s ease-out infinite}
.h.below .pulse{top:56px}.h.above .pulse{top:-20px}
@keyframes ring{from{transform:scale(.8);opacity:.9}to{transform:scale(1.9);opacity:0}}
.ticks{position:absolute;left:0;right:0;bottom:6px;opacity:.7;display:flex;justify-content:space-between;font-size:10px;color:#5f7286}
/* Netzladung */
.grid{display:flex;align-items:center;gap:12px;margin-top:6px;padding:10px 12px;border-radius:14px;cursor:pointer;
 background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.01));border:1px solid rgba(255,255,255,.07);transition:border-color .4s}
.grid.on{border-color:rgba(133,183,235,.55);box-shadow:0 0 18px rgba(133,183,235,.15)}
.grid svg{width:112px;height:34px;flex:0 0 112px;overflow:visible}
.grid .gt{font-size:13.5px;font-weight:600}
.grid .gs{font-size:11.5px;color:#9fb2c6}
.fl{stroke-dasharray:4 6;animation:fl 0.9s linear infinite}
@keyframes fl{to{stroke-dashoffset:-20}}
.toast{position:absolute;left:50%;bottom:10px;transform:translate(-50%,20px);opacity:0;padding:6px 12px;border-radius:999px;
 background:rgba(20,32,46,.95);border:1px solid rgba(255,255,255,.12);font-size:12px;transition:all .35s;pointer-events:none}
.toast.show{transform:translate(-50%,0);opacity:1}
</style>
<ha-card>
 <div class="head"><span class="live"></span><span class="t">Steuerung</span>
  <div class="sw" id="sw" role="switch" tabindex="0"><span>Automatik <b id="swt"></b></span><div class="track"><div class="knob"></div></div></div>
 </div>
 <div class="modes" id="modes"></div>
 <div class="lbl"><span>Akku-Grenzen</span><span id="hint">Griffe ziehen zum Einstellen</span></div>
 <div class="batwrap" id="batwrap">
  <div class="bat" id="bat"><div class="zone" id="z1"></div><div class="zone" id="z2"></div><div class="zone" id="z3"></div>
   <div class="liq" id="liq"><span class="bub" style="left:20%"></span><span class="bub" style="left:55%;animation-delay:1.2s"></span><span class="bub" style="left:80%;animation-delay:2s"></span></div>
   <div class="plan" id="plan" title="Geplanter Mindest-SoC"></div><div class="socl" id="socl"></div></div>
  <div class="cap"></div>
  <div class="ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100 %</span></div>
 </div>
 <div class="grid" id="grid">
  <svg viewBox="0 0 112 34">
   <g stroke="#85B7EB" stroke-width="1.6" fill="none" stroke-linejoin="round">
    <path d="M8 32 L14 4 L20 32 M10 22 H18 M11.5 14 H16.5 M6 8 H22"/></g>
   <path class="fl" id="gfl" d="M26 17 H84" stroke="#85B7EB" stroke-width="3" stroke-linecap="round" fill="none"/>
   <rect x="86" y="8" width="22" height="18" rx="3" fill="none" stroke="#cfdbe7" stroke-width="1.6"/>
   <rect x="108" y="13" width="3" height="8" rx="1" fill="#cfdbe7"/>
   <rect id="gbat" x="88" y="10" width="0" height="14" rx="1.5" fill="#85B7EB" style="transition:width 1.2s"/>
  </svg>
  <div><div class="gt" id="gt"></div><div class="gs" id="gs"></div></div>
 </div>
 <div class="toast" id="toast"></div>
</ha-card>`;
    const $ = (id) => root.getElementById(id);
    this._r = { sw: $("sw"), swt: $("swt"), modes: $("modes"), bat: $("bat"), batwrap: $("batwrap"), liq: $("liq"),
      plan: $("plan"), socl: $("socl"), grid: $("grid"), gt: $("gt"), gs: $("gs"), gfl: $("gfl"), gbat: $("gbat"),
      toast: $("toast"), z: [$("z1"), $("z2"), $("z3")] };

    // Automatik
    const toggle = () => {
      const on = this._st("auto") && this._st("auto").state === "on";
      this._r.sw.classList.toggle("on", !on);
      this._call("switch", on ? "turn_off" : "turn_on", { entity_id: this._e.auto });
      this._toast(on ? "Automatik aus" : "Automatik an");
    };
    this._r.sw.addEventListener("click", toggle);
    this._r.sw.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });

    // Modi
    this._modeEls = {};
    Object.entries(CTL_MODES).forEach(([k, m], i) => {
      const el = document.createElement("div");
      el.className = "mode";
      el.tabIndex = 0;
      el.style.setProperty("--c", m.color);
      el.style.animationDelay = `${i * 70}ms`;
      el.innerHTML = `<svg viewBox="0 0 32 32">${m.icon}</svg><div><div class="l">${m.label}</div><div class="s">${m.sub}</div></div>`;
      const pick = () => {
        const cur = this._st("mode");
        if (cur && cur.state === k) return;
        Object.values(this._modeEls).forEach((x) => x.classList.remove("act"));
        el.classList.add("act", "busy");
        this._call("select", "select_option", { entity_id: this._e.mode, option: k });
        this._toast(`Betriebsart: ${m.label}`);
      };
      el.addEventListener("click", pick);
      el.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); pick(); } });
      this._r.modes.appendChild(el);
      this._modeEls[k] = el;
    });

    // Griffe
    this._handles = {};
    SLIDERS.forEach((s) => {
      const h = document.createElement("div");
      h.className = `h ${s.pos}`;
      h.style.setProperty("--c", s.color);
      h.innerHTML = `<div class="line"></div><div class="pulse"></div>
        <div class="grip" tabindex="0" role="slider" aria-label="${s.label}"></div><div class="tag"><b></b>${s.short}</div>`;
      this._r.batwrap.appendChild(h);
      const grip = h.querySelector(".grip");
      const pctFrom = (ev) => {
        const r = this._r.bat.getBoundingClientRect();
        return ((ev.clientX - r.left) / r.width) * 100;
      };
      grip.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        grip.setPointerCapture(ev.pointerId);
        h.classList.add("drag");
        this._drag[s.key] = this._clamp(s.key, pctFrom(ev));
        this._layout();
      });
      grip.addEventListener("pointermove", (ev) => {
        if (!(s.key in this._drag)) return;
        this._drag[s.key] = this._clamp(s.key, pctFrom(ev));
        this._layout();
      });
      const end = () => {
        if (!(s.key in this._drag)) return;
        const v = this._drag[s.key];
        delete this._drag[s.key];
        h.classList.remove("drag");
        this._commit(s, v);
      };
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
      grip.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const cur = this._val(s.key) ?? 0;
        this._commit(s, this._clamp(s.key, cur + d * (e.shiftKey ? 5 : 1)));
      });
      grip.addEventListener("dblclick", () => this._moreInfo(this._e[s.key]));
      this._handles[s.key] = h;
    });

    this._r.grid.addEventListener("click", () => this._moreInfo(this._e.grid_charge));
    this._built = true;
  }

  _clamp(key, v) {
    const st = this._st(key);
    const a = st ? st.attributes : {};
    const min = a.min ?? 0, max = a.max ?? 100, step = a.step ?? 1;
    return Math.max(min, Math.min(max, Math.round(v / step) * step));
  }
  _val(key) {
    if (key in this._drag) return this._drag[key];
    const p = this._pending[key];
    if (p && Date.now() < p.until) return p.v;
    return this._num(key);
  }
  _commit(s, v) {
    if (v === this._num(s.key)) { this._layout(); return; }
    this._pending[s.key] = { v, until: Date.now() + 5000 };
    this._call("number", "set_value", { entity_id: this._e[s.key], value: v });
    this._toast(`${s.label}: ${Math.round(v)} %`);
    this._layout();
  }
  _toast(msg) {
    const t = this._r.toast;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove("show"), 1800);
  }

  _layout() {
    const v = {};
    SLIDERS.forEach((s) => { v[s.key] = this._val(s.key); });
    SLIDERS.forEach((s) => {
      const h = this._handles[s.key], x = v[s.key];
      h.style.left = `${x ?? 0}%`;
      h.style.opacity = x === null ? 0.3 : 1;
      h.querySelector(".tag b").textContent = x === null ? "–" : `${Math.round(x)} %`;
      h.querySelector(".grip").setAttribute("aria-valuenow", x ?? "");
    });
    // Zonen: 0–Untergrenze rot, Untergrenze–Reserve "frei bei Sonne", Reserve–Unwetter Notstrom
    const f = v.floor ?? 0, r = v.reserve ?? 0, s = v.storm ?? 0;
    const zone = (el, a, b, col) => {
      el.style.left = `${Math.min(a, b)}%`;
      el.style.width = `${Math.abs(b - a)}%`;
      el.style.background = col;
    };
    zone(this._r.z[0], 0, f, "repeating-linear-gradient(135deg,rgba(240,96,93,.22) 0 6px,rgba(240,96,93,.08) 6px 12px)");
    zone(this._r.z[1], f, r, "linear-gradient(90deg,rgba(139,212,106,.10),rgba(242,179,71,.14))");
    zone(this._r.z[2], r, s, "repeating-linear-gradient(135deg,rgba(242,179,71,.16) 0 6px,rgba(240,96,93,.12) 6px 12px)");
  }

  _update() {
    // Automatik
    const au = this._st("auto"), on = au && au.state === "on";
    this._r.sw.classList.toggle("on", !!on);
    this._r.swt.textContent = on ? "an" : "aus";
    this._r.sw.setAttribute("aria-checked", on ? "true" : "false");

    // Modus
    const mode = this._st("mode");
    Object.entries(this._modeEls).forEach(([k, el]) => {
      el.classList.toggle("act", !!mode && mode.state === k);
      el.classList.remove("busy");
    });

    // Akku
    const soc = this._num("soc");
    const lc = soc === null ? ["#6b7c8f", "#38485a"] : soc < 20 ? ["#F0605D", "#8e2422"] : soc < 50 ? ["#F2B347", "#9a5a12"] : ["#8BD46A", "#2f6b15"];
    this._r.liq.style.setProperty("--lc1", lc[0]);
    this._r.liq.style.setProperty("--lc2", lc[1]);
    requestAnimationFrame(() => { this._r.liq.style.width = `${soc ?? 0}%`; });
    this._r.socl.style.left = `calc(${Math.min(88, soc ?? 0)}% + 8px)`;
    this._r.socl.textContent = soc === null ? "" : `SoC ${Math.round(soc)} %`;
    const tgt = this._num("target");
    this._r.plan.style.left = `${tgt ?? 0}%`;
    this._r.plan.style.display = tgt === null ? "none" : "";
    this._r.plan.title = tgt === null ? "" : `Geplanter Mindest-SoC ${Math.round(tgt)} %`;
    this._layout();

    // Netzladung
    const gc = this._st("grid_charge"), gon = gc && gc.state === "on";
    const tS = this._st("target");
    const zielGc = tS && tS.attributes.netzladung_ziel;
    this._r.grid.classList.toggle("on", !!gon);
    this._r.gfl.style.display = gon ? "" : "none";
    this._r.gbat.setAttribute("width", gon ? 18 * Math.min(1, (zielGc || 50) / 100) : 0);
    this._r.gt.textContent = gon ? `Netz lädt nach${zielGc ? ` bis ${Math.round(zielGc)} %` : ""}` : "Keine Netzladung";
    this._r.gt.style.color = gon ? "#85B7EB" : "#cfdbe7";
    const shadow = (mode && mode.state === "observe") || !on;
    this._r.gs.textContent = gon ? (shadow ? "geplant – wird noch nicht geschaltet" : "Ladeslot am Cerbo aktiv")
      : "Sonne oder Akku reichen";
  }
}

if (!customElements.get("akku-planer-control-card")) {
  customElements.define("akku-planer-control-card", AkkuPlanerControlCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "akku-planer-control-card", name: "Akku-Planer Steuerung", description: "Animierte Bedienung: Betriebsart, Automatik, Akku-Grenzen", preview: false });
  console.info(`%c AKKU-PLANER-CTL %c ${CTL_VERSION} `, "background:#6FA8F0;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
