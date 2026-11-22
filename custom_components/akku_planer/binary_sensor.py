"""Binärsensoren des Akku-Planers."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import AkkuPlanerEntity


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    async_add_entities([GridChargeSensor(c, "grid_charge"), StormSensor(c, "storm")])


class GridChargeSensor(AkkuPlanerEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.BATTERY_CHARGING

    @property
    def is_on(self) -> bool | None:
        d = self.coordinator.data
        return bool(d and d["plan"].grid_charge)


class StormSensor(AkkuPlanerEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.SAFETY

    @property
    def is_on(self) -> bool | None:
        d = self.coordinator.data
        return bool(d and d["plan"].decision == "unwetter")

    @property
    def extra_state_attributes(self) -> dict | None:
        d = self.coordinator.data
        return {"warnstufe": d["storm_level"], "netz_verfuegbar": d["grid_available"]} if d else None
