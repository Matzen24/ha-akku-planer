/* Akku-Planer page in the sidebar: all bundled cards, laid out like the "Cockpit" dashboard.
 * Registered by the integration itself, so it works right after installation. */
const APP_VERSION = "1.2.0";

const APP_LAYOUT = [
  { type: "akku-planer-card", config: { view: "full" }, wide: true },
  { type: "akku-planer-forecast-card", config: {}, wide: true },
  { type: "akku-planer-control-card", config: {} },
  { type: "akku-planer-kpi-card", config: {} },
  { type: "akku-planer-analysis-card", config: {}, wide: true },
];

class AkkuPlanerPanel extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    if (this._menu) this._menu.hass = hass;
    for (const c of this._cards || []) c.hass = hass;
  }

  set narrow(narrow) {
    this._narrow = narrow;
    if (this._menu) this._menu.narrow = narrow;
  }

  set panel(panel) {
    this._panel = panel;
    if (this._title) this._title.textContent = (panel && panel.config && panel.config.title) || "Akku-Planer";
  }

  _build() {
    this._built = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; min-height: 100vh; background: var(--primary-background-color, #111); }
        .toolbar {
          position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
          height: var(--header-height, 56px); padding: 0 12px; box-sizing: border-box;
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
          border-bottom: var(--app-header-border-bottom, none);
        }
        .title { font-size: 20px; font-weight: 400; margin-left: 4px; }
        .grid {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;
          max-width: 1240px; margin: 0 auto; padding: 16px; box-sizing: border-box;
        }
        .wide { grid-column: 1 / -1; }
        .slot { min-width: 0; }
        .msg { grid-column: 1 / -1; color: var(--secondary-text-color); text-align: center; padding: 32px 0; }
        @media (max-width: 870px) { .grid { grid-template-columns: minmax(0, 1fr); padding: 8px; gap: 8px; } }
      </style>
      <div class="toolbar"><ha-menu-button></ha-menu-button><div class="title">Akku-Planer</div></div>
      <div class="grid"></div>`;
    this._menu = root.querySelector("ha-menu-button");
    this._menu.hass = this._hass;
    this._menu.narrow = this._narrow;
    this._title = root.querySelector(".title");
    if (this._panel) this.panel = this._panel;
    this._grid = root.querySelector(".grid");
    this._cards = [];
    this._placeCards();
  }

  async _placeCards() {
    for (const item of APP_LAYOUT) {
      const slot = document.createElement("div");
      slot.className = item.wide ? "slot wide" : "slot";
      this._grid.appendChild(slot);
      try {
        await Promise.race([
          customElements.whenDefined(item.type),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
        ]);
        const card = document.createElement(item.type);
        card.setConfig({ type: `custom:${item.type}`, ...item.config });
        if (this._hass) card.hass = this._hass;
        slot.appendChild(card);
        this._cards.push(card);
      } catch (err) {
        slot.innerHTML = `<div class="msg">${item.type}: ${err && err.message ? err.message : err}</div>`;
      }
    }
  }
}

if (!customElements.get("akku-planer-panel")) {
  customElements.define("akku-planer-panel", AkkuPlanerPanel);
  console.info(`%c AKKU-PLANER-PANEL %c ${APP_VERSION} `, "background:#F2B347;color:#000;border-radius:3px 0 0 3px", "background:#1d3047;color:#fff;border-radius:0 3px 3px 0");
}
