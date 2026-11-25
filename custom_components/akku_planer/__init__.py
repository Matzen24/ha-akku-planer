"""Akku-Planer: forecast based minimum-SoC control for home batteries."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_CONTROL,
    CONF_MIN_SOC,
    CONF_SHOW_PANEL,
    CONF_SLOT_DAYS,
    CONTROL_VICTRON,
    DOMAIN,
    FRONTEND_CARDS,
    FRONTEND_URL,
    LEGACY_V1_DEFAULTS,
    PANEL_FILE,
    PANEL_ICON,
    PANEL_URLS,
)
from .coordinator import AkkuPlanerCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
    Platform.NUMBER,
    Platform.BUTTON,
]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type AkkuPlanerConfigEntry = ConfigEntry[AkkuPlanerCoordinator]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the bundled Lovelace cards and load them in the frontend."""
    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415
        from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

        from homeassistant.loader import async_get_integration  # noqa: PLC0415

        path = Path(__file__).parent / "frontend"
        version = str((await async_get_integration(hass, DOMAIN)).version or "0")
        await hass.http.async_register_static_paths([StaticPathConfig(FRONTEND_URL, str(path), True)])
        for card in FRONTEND_CARDS:
            add_extra_js_url(hass, f"{FRONTEND_URL}/{card}?v={version}")
        hass.data[f"{DOMAIN}_version"] = version
    except Exception:  # noqa: BLE001 - cards are optional, the integration works without them
        _LOGGER.warning("Akku-Planer cards could not be registered", exc_info=True)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: AkkuPlanerConfigEntry) -> bool:
    coordinator = AkkuPlanerCoordinator(hass, entry)
    await coordinator.async_load()
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    if {**entry.data, **entry.options}.get(CONF_SHOW_PANEL, True):
        await _async_register_panel(hass, entry)
    return True


async def _async_register_panel(hass: HomeAssistant, entry: AkkuPlanerConfigEntry) -> None:
    """Own page in the sidebar with all cards: works right after installation, no dashboard needed."""
    try:
        from homeassistant.components import frontend, panel_custom  # noqa: PLC0415

        panels = hass.data.get(frontend.DATA_PANELS, {})
        url = next((u for u in PANEL_URLS if u not in panels), None)
        if url is None:
            _LOGGER.warning("Akku-Planer page not added: %s are already in use", ", ".join(PANEL_URLS))
            return
        version = hass.data.get(f"{DOMAIN}_version", "0")
        title = "Akku-Planer"
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=url,
            webcomponent_name="akku-planer-panel",
            sidebar_title=title,
            sidebar_icon=PANEL_ICON,
            module_url=f"{FRONTEND_URL}/{PANEL_FILE}?v={version}",
            embed_iframe=False,
            require_admin=False,
            config={"title": title},
        )
        entry.async_on_unload(lambda: frontend.async_remove_panel(hass, url))
    except Exception:  # noqa: BLE001 - the page is optional, the integration works without it
        _LOGGER.warning("Akku-Planer page could not be added to the sidebar", exc_info=True)


async def _async_reload(hass: HomeAssistant, entry: AkkuPlanerConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: AkkuPlanerConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Version 1 entries (first private build, Victron only) relied on built-in Victron defaults."""
    if entry.version == 1:
        data = {**LEGACY_V1_DEFAULTS, **entry.data}
        opts = {**data, **entry.options}
        data[CONF_CONTROL] = CONTROL_VICTRON if opts.get(CONF_SLOT_DAYS) and opts.get(CONF_MIN_SOC) else "number"
        hass.config_entries.async_update_entry(entry, data=data, version=2)
        _LOGGER.info("Akku-Planer config migrated to version 2 (control: %s)", data[CONF_CONTROL])
    return True
