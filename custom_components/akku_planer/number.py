"""Einstellwerte: Reserve, Boden, Unwetter-Reserve."""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.const import PERCENTAGE, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import SET_FLOOR, SET_RESERVE, SET_STORM_RESERVE
from .entity import AkkuPlanerEntity


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    async_add_entities(SettingNumber(c, key) for key in (SET_RESERVE, SET_FLOOR, SET_STORM_RESERVE))


class SettingNumber(AkkuPlanerEntity, NumberEntity):
    _attr_native_min_value = 5
    _attr_native_max_value = 100
    _attr_native_step = 1
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_mode = NumberMode.SLIDER
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator, key: str) -> None:
        super().__init__(coordinator, key)
        self._key = key

    @property
    def native_value(self) -> float:
        return self.coordinator.settings[self._key]

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.async_set_setting(self._key, value)
        self.async_write_ha_state()
