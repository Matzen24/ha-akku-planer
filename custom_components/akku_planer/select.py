"""Auswahl: Betriebsart."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import MODES
from .entity import AkkuPlanerEntity


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([ModeSelect(entry.runtime_data, "mode")])


class ModeSelect(AkkuPlanerEntity, SelectEntity):
    _attr_options = MODES
    _attr_icon = "mdi:tune-variant"

    @property
    def current_option(self) -> str:
        return self.coordinator.mode

    async def async_select_option(self, option: str) -> None:
        await self.coordinator.async_set_mode(option)
        self.async_write_ha_state()
