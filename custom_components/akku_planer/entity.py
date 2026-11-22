"""Gemeinsame Basisklasse."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import AkkuPlanerCoordinator


class AkkuPlanerEntity(CoordinatorEntity[AkkuPlanerCoordinator]):
    _attr_has_entity_name = True

    def __init__(self, coordinator: AkkuPlanerCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name="Akku-Planer",
            manufacturer="Akku-Planer",
            model="Forecast based battery planner",
            entry_type=DeviceEntryType.SERVICE,
        )
