"""Schalter: Automatik an/aus."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import AkkuPlanerEntity


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([AutomaticSwitch(entry.runtime_data, "automatic")])


class AutomaticSwitch(AkkuPlanerEntity, SwitchEntity):
    _attr_icon = "mdi:robot"

    @property
    def is_on(self) -> bool:
        return self.coordinator.automatic

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_set_automatic(True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_set_automatic(False)
        self.async_write_ha_state()
