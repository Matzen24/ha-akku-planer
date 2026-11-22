"""Setup through the UI: detect the system, confirm, choose how the battery is controlled."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_BATTERY_POWER,
    CONF_CAPACITY_AH,
    CONF_CAPACITY_KWH,
    CONF_CHARGE_POWER,
    CONF_CHARGE_SWITCH,
    CONF_CONTROL,
    CONF_GRID_POWER,
    CONF_GRID_SOURCE,
    CONF_LOAD,
    CONF_LOAD_POWER,
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
    CONTROL_TYPES,
    CONTROL_VICTRON,
    DEFAULTS,
    DOMAIN,
)
from .detect import async_detect, async_energy_sources

ENTITY_KEYS = {
    CONF_SOC, CONF_CAPACITY_AH, CONF_VOLTAGE, CONF_LOAD, CONF_MIN_SOC, CONF_GRID_SOURCE, CONF_WARNING,
    CONF_SLOT_START, CONF_SLOT_DURATION, CONF_SLOT_SOC, CONF_SLOT_DAYS, CONF_CHARGE_SWITCH,
    CONF_BATTERY_POWER, CONF_GRID_POWER, CONF_PV_POWER, CONF_LOAD_POWER,
}


def _ent(domain: str | list[str], multiple: bool = False) -> selector.EntitySelector:
    return selector.EntitySelector(selector.EntitySelectorConfig(domain=domain, multiple=multiple))


def _opt(v: dict[str, Any], key: str) -> vol.Optional:
    val = v.get(key)
    return vol.Optional(key, description={"suggested_value": val}) if val not in (None, "", []) else vol.Optional(key)


def _system_schema(v: dict[str, Any]) -> vol.Schema:
    return vol.Schema({
        vol.Required(CONF_SOC, description={"suggested_value": v.get(CONF_SOC)}): _ent("sensor"),
        vol.Required(CONF_PV_SOURCES, default=v.get(CONF_PV_SOURCES) or []): _ent("sensor", multiple=True),
        _opt(v, CONF_LOAD): _ent("sensor"),
        vol.Optional(CONF_CAPACITY_KWH, default=float(v.get(CONF_CAPACITY_KWH) or 0)): selector.NumberSelector(
            selector.NumberSelectorConfig(min=0, max=500, step=0.1, unit_of_measurement="kWh",
                                          mode=selector.NumberSelectorMode.BOX)
        ),
        _opt(v, CONF_CAPACITY_AH): _ent("sensor"),
        _opt(v, CONF_VOLTAGE): _ent("sensor"),
        vol.Required(CONF_CONTROL, default=v.get(CONF_CONTROL) or CONTROL_NONE): selector.SelectSelector(
            selector.SelectSelectorConfig(options=CONTROL_TYPES, translation_key="control_type",
                                          mode=selector.SelectSelectorMode.LIST)
        ),
        _opt(v, CONF_WARNING): _ent("sensor"),
        _opt(v, CONF_PV_POWER): _ent("sensor"),
        _opt(v, CONF_LOAD_POWER): _ent("sensor"),
        _opt(v, CONF_BATTERY_POWER): _ent("sensor"),
        _opt(v, CONF_GRID_POWER): _ent("sensor"),
    })


def _control_schema(v: dict[str, Any], control: str) -> vol.Schema:
    fields: dict[Any, Any] = {
        vol.Required(CONF_MIN_SOC, description={"suggested_value": v.get(CONF_MIN_SOC)}): _ent(["number", "input_number"]),
        _opt(v, CONF_GRID_SOURCE): _ent(["sensor", "binary_sensor"]),
    }
    if control == CONTROL_VICTRON:
        fields.update({
            vol.Required(CONF_SLOT_START, description={"suggested_value": v.get(CONF_SLOT_START)}): _ent("time"),
            vol.Required(CONF_SLOT_DURATION, description={"suggested_value": v.get(CONF_SLOT_DURATION)}): _ent("number"),
            vol.Required(CONF_SLOT_SOC, description={"suggested_value": v.get(CONF_SLOT_SOC)}): _ent("number"),
            vol.Required(CONF_SLOT_DAYS, description={"suggested_value": v.get(CONF_SLOT_DAYS)}): _ent("select"),
        })
    else:
        fields[_opt(v, CONF_CHARGE_SWITCH)] = _ent(["switch", "input_boolean"])
    fields[vol.Optional(CONF_CHARGE_POWER, default=float(v.get(CONF_CHARGE_POWER) or 3.0))] = selector.NumberSelector(
        selector.NumberSelectorConfig(min=0.5, max=50, step=0.5, unit_of_measurement="kW")
    )
    return vol.Schema(fields)


async def _validate_system(flow, data: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    if not data.get(CONF_PV_SOURCES):
        errors[CONF_PV_SOURCES] = "no_pv"
    if not float(data.get(CONF_CAPACITY_KWH) or 0) > 0 and not (data.get(CONF_CAPACITY_AH) and data.get(CONF_VOLTAGE)):
        errors[CONF_CAPACITY_KWH] = "no_capacity"
    if not data.get(CONF_LOAD):
        energy = await async_energy_sources(flow.hass)
        if not energy.can_derive_load:
            errors[CONF_LOAD] = "no_load"
    return errors


def _clean(data: dict[str, Any]) -> dict[str, Any]:
    """Drop empty optional entity fields so that removed values really disappear."""
    return {k: v for k, v in data.items() if not (k in ENTITY_KEYS and v in (None, ""))}


class AkkuPlanerConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 2

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self._notes: list[str] = []

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        errors: dict[str, str] = {}
        if user_input is None:
            found, self._notes = await async_detect(self.hass)
            self._data = {**DEFAULTS, **found}
        else:
            self._data.update(user_input)
            errors = await _validate_system(self, user_input)
            if not errors:
                if user_input[CONF_CONTROL] == CONTROL_NONE:
                    return self._finish()
                return await self.async_step_control()
        return self.async_show_form(
            step_id="user",
            data_schema=_system_schema(self._data),
            errors=errors,
            description_placeholders={"detected": _summary(self._data, self._notes)},
        )

    async def async_step_control(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._data.update(user_input)
            return self._finish()
        return self.async_show_form(step_id="control",
                                    data_schema=_control_schema(self._data, self._data[CONF_CONTROL]))

    def _finish(self) -> ConfigFlowResult:
        return self.async_create_entry(title="Akku-Planer", data=_clean(self._data))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return AkkuPlanerOptionsFlow()


class AkkuPlanerOptionsFlow(OptionsFlow):
    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if not self._data:
            self._data = {**DEFAULTS, **self.config_entry.data, **self.config_entry.options}
        if user_input is not None:
            # Fields left empty are not part of user_input -> remove them
            for k in ENTITY_KEYS - {CONF_MIN_SOC, CONF_GRID_SOURCE, CONF_CHARGE_SWITCH, CONF_SLOT_START,
                                    CONF_SLOT_DURATION, CONF_SLOT_SOC, CONF_SLOT_DAYS}:
                self._data.pop(k, None)
            self._data.update(user_input)
            errors = await _validate_system(self, user_input)
            if not errors:
                if user_input[CONF_CONTROL] == CONTROL_NONE:
                    return self.async_create_entry(data=_clean(self._data))
                return await self.async_step_control()
        return self.async_show_form(step_id="init", data_schema=_system_schema(self._data), errors=errors)

    async def async_step_control(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            for k in (CONF_GRID_SOURCE, CONF_CHARGE_SWITCH):
                self._data.pop(k, None)
            self._data.update(user_input)
            return self.async_create_entry(data=_clean(self._data))
        return self.async_show_form(step_id="control",
                                    data_schema=_control_schema(self._data, self._data[CONF_CONTROL]))


def _summary(data: dict[str, Any], notes: list[str]) -> str:
    """Short, language neutral list of what was detected (shown in the form description)."""
    lines = []
    if data.get(CONF_PV_SOURCES):
        lines.append(f"☀ PV: {len(data[CONF_PV_SOURCES])}")
    if data.get(CONF_SOC):
        lines.append(f"🔋 {data[CONF_SOC]}")
    if "load:energy" in notes:
        lines.append("🏠 Energy dashboard ✓")
    ctl = data.get(CONF_CONTROL)
    if ctl == CONTROL_VICTRON:
        lines.append("⚙ Victron ESS ✓")
    elif ctl == CONTROL_NUMBER:
        lines.append(f"⚙ {data.get(CONF_MIN_SOC)}")
    return "\n".join(lines) if lines else "–"
