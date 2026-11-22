"""Automatic detection of the battery system during setup.

Sources, in this order:
1. Home Assistant's Energy dashboard (solar, battery and grid sources).
2. The entity registry (state of charge, Victron ESS controls, DWD warning level).

Everything found here is only a *suggestion* for the setup form.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .const import (
    CONF_BATTERY_POWER,
    CONF_CAPACITY_AH,
    CONF_CONTROL,
    CONF_GRID_POWER,
    CONF_GRID_SOURCE,
    CONF_MIN_SOC,
    CONF_PV_POWER,
    CONF_PV_SOURCES,
    CONF_SLOT_DAYS,
    CONF_SLOT_DURATION,
    CONF_SLOT_SOC,
    CONF_SLOT_START,
    CONF_SOC,
    CONF_VOLTAGE,
    CONF_WARNING,
    CONTROL_NONE,
    CONTROL_NUMBER,
    CONTROL_VICTRON,
)

from .sources import EnergySources, parse_energy_sources, pick_soc

_LOGGER = logging.getLogger(__name__)


async def async_energy_sources(hass: HomeAssistant) -> EnergySources:
    try:
        from homeassistant.components.energy.data import async_get_manager  # noqa: PLC0415

        manager = await async_get_manager(hass)
        prefs = manager.data or {}
        return parse_energy_sources(prefs.get("energy_sources", []))
    except Exception as err:  # noqa: BLE001 - energy is optional
        _LOGGER.debug("Energy dashboard not readable: %s", err)
        return EnergySources()


def _ends(entities: list[er.RegistryEntry], domain: str, suffix: str) -> str | None:
    for e in entities:
        if e.domain == domain and e.entity_id.endswith(suffix) and not e.disabled_by:
            return e.entity_id
    return None


async def async_detect(hass: HomeAssistant) -> tuple[dict[str, Any], list[str]]:
    """Return (suggested config values, human readable notes)."""
    reg = er.async_get(hass)
    entries = list(reg.entities.values())
    energy = await async_energy_sources(hass)
    found: dict[str, Any] = {}
    notes: list[str] = []

    # --- PV: energy statistics from the Energy dashboard are guaranteed to have long-term statistics
    if energy.solar_energy:
        found[CONF_PV_SOURCES] = list(energy.solar_energy)
        notes.append(f"solar:{len(energy.solar_energy)}")
    if len(energy.solar_power) == 1:
        found[CONF_PV_POWER] = energy.solar_power[0]
    if energy.grid_power:
        found[CONF_GRID_POWER] = energy.grid_power[0]
    if energy.battery_power_charge_positive:
        found[CONF_BATTERY_POWER] = energy.battery_power_charge_positive[0]
    if energy.can_derive_load:
        notes.append("load:energy")

    # --- State of charge
    battery_stats = set(energy.battery_from + energy.battery_to + energy.battery_power_charge_positive)
    battery_devices = {e.device_id for e in entries if e.entity_id in battery_stats and e.device_id}
    cands: list[tuple[str, str, str | None]] = []
    for e in entries:
        if e.domain != "sensor" or e.disabled_by:
            continue
        st = hass.states.get(e.entity_id)
        dc = e.device_class or e.original_device_class
        unit = st.attributes.get("unit_of_measurement") if st else e.unit_of_measurement
        if dc == "battery" and unit == "%":
            cands.append((e.entity_id, e.platform, e.device_id))
    if soc := pick_soc(cands, battery_devices):
        found[CONF_SOC] = soc
        soc_entry = reg.async_get(soc)
        same_dev = [e for e in entries if soc_entry and e.device_id and e.device_id == soc_entry.device_id]
        if ah := _ends(same_dev, "sensor", "_installed_capacity"):
            found[CONF_CAPACITY_AH] = ah
            if v := _ends(same_dev, "sensor", "_battery_voltage") or _ends(same_dev, "sensor", "_voltage"):
                found[CONF_VOLTAGE] = v

    # --- Victron ESS (victron_mqtt integration)
    victron = [e for e in entries if e.platform == "victron_mqtt"]
    control = CONTROL_NONE
    if victron:
        if m := _ends(victron, "number", "_ess_min_soc_limit"):
            found[CONF_MIN_SOC] = m
            control = CONTROL_NUMBER
        if g := _ends(victron, "sensor", "_ac_active_input_source"):
            found[CONF_GRID_SOURCE] = g
        slot = {
            CONF_SLOT_START: _ends(victron, "time", "_ess_schedule_charge_1_start"),
            CONF_SLOT_DURATION: _ends(victron, "number", "_ess_schedule_charge_1_duration"),
            CONF_SLOT_SOC: _ends(victron, "number", "_ess_schedule_charge_1_soc"),
            CONF_SLOT_DAYS: _ends(victron, "select", "_ess_schedule_charge_1_days"),
        }
        if all(slot.values()) and CONF_MIN_SOC in found:
            found.update(slot)
            control = CONTROL_VICTRON
        notes.append(f"victron:{control}")
    found[CONF_CONTROL] = control

    # --- Weather warnings (DWD)
    if w := _ends([e for e in entries if e.platform == "dwd_weather_warnings"], "sensor", "current_warning_level"):
        found[CONF_WARNING] = w
    return found, notes
