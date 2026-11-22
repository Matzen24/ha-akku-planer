"""Sensors of Akku-Planer."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, UnitOfEnergy
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import AkkuPlanerCoordinator
from .entity import AkkuPlanerEntity


@dataclass(frozen=True, kw_only=True)
class PlanerSensorDescription(SensorEntityDescription):
    value: Callable[[AkkuPlanerCoordinator, dict], Any]
    attrs: Callable[[AkkuPlanerCoordinator, dict], dict] | None = None


def _plan(d: dict):
    return d["plan"]


SENSORS: tuple[PlanerSensorDescription, ...] = (
    PlanerSensorDescription(
        key="target_min_soc",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        icon="mdi:battery-lock",
        value=lambda c, d: _plan(d).target_min_soc,
        attrs=lambda c, d: {
            "entscheidung": _plan(d).decision,
            "netzladung": _plan(d).grid_charge,
            "netzladung_ziel": _plan(d).charge_target_soc,
            "netzladung_stunden": _plan(d).charge_hours,
            "letzte_aktion": c.last_action,
            "modus": c.mode,
            "automatik": c.automatic,
            "steuerung": c.control,
            # entity ids for the bundled dashboard cards
            "akku_planer": c.entity_map(),
        },
    ),
    PlanerSensorDescription(
        key="reason",
        icon="mdi:text-box-outline",
        value=lambda c, d: _plan(d).reason[:255],
        attrs=lambda c, d: {"volltext": _plan(d).reason},
    ),
    PlanerSensorDescription(
        key="pv_tomorrow",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        icon="mdi:solar-power-variant",
        value=lambda c, d: d["forecast"]["tomorrow"]["p50"],
        attrs=lambda c, d: {"p10_sicher": d["forecast"]["tomorrow"]["p10"],
                            "p90_optimistisch": d["forecast"]["tomorrow"]["p90"]},
    ),
    PlanerSensorDescription(
        key="pv_today_remaining",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        icon="mdi:solar-power",
        value=lambda c, d: d["forecast"]["today_remaining"]["p50"],
        attrs=lambda c, d: {"p10_sicher": d["forecast"]["today_remaining"]["p10"],
                            "p90_optimistisch": d["forecast"]["today_remaining"]["p90"]},
    ),
    PlanerSensorDescription(
        key="forecast_days",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        icon="mdi:weather-partly-cloudy",
        # Zustand = PV-Summe (P50) der 4 Tage; Details für Diagramme in den Attributen
        value=lambda c, d: round(sum(x["pv_p50"] for x in d["forecast"]["days"]), 1),
        attrs=lambda c, d: {"tage": d["forecast"]["days"], "stunden": d["forecast"]["hourly"]},
    ),
    PlanerSensorDescription(
        key="refill",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        icon="mdi:battery-charging-high",
        value=lambda c, d: _plan(d).refill_kwh_p10,
        attrs=lambda c, d: {
            "beginn": _plan(d).refill_start.isoformat() if _plan(d).refill_start else None,
            "ende": _plan(d).refill_end.isoformat() if _plan(d).refill_end else None,
            "p50": _plan(d).refill_kwh_p50,
        },
    ),
    PlanerSensorDescription(
        key="drain",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        icon="mdi:home-lightning-bolt",
        value=lambda c, d: _plan(d).drain_kwh,
    ),
    PlanerSensorDescription(
        key="soc_at_refill",
        native_unit_of_measurement=PERCENTAGE,
        device_class=SensorDeviceClass.BATTERY,
        value=lambda c, d: _plan(d).soc_at_refill,
        attrs=lambda c, d: {"verlauf_p10": _plan(d).soc_trajectory[:36]},
    ),
    PlanerSensorDescription(
        key="accuracy",
        native_unit_of_measurement=PERCENTAGE,
        icon="mdi:bullseye-arrow",
        value=lambda c, d: d["accuracy"]["score"],
        attrs=lambda c, d: {"tage": d["accuracy"]["days"]},
    ),
    PlanerSensorDescription(
        key="pv_model",
        native_unit_of_measurement="kWp",
        icon="mdi:solar-panel-large",
        value=lambda c, d: round(sum(m.total_kwp for m in c.pv_models.values()), 2) or None,
        attrs=lambda c, d: {
            eid: {"flaechen_kwp": m.describe(), "rmse_kw": round(m.rmse_kw, 3),
                  "trainingsstunden": m.fitted_hours, "max_kw": round(m.cap_kw, 2)}
            for eid, m in c.pv_models.items()
        } | {"kapazitaet_kwh": d["capacity_kwh"], "verbrauchsmodell_stunden": c.load_model.samples},
    ),
)


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: AkkuPlanerCoordinator = entry.runtime_data
    async_add_entities(PlanerSensor(coordinator, desc) for desc in SENSORS)


class PlanerSensor(AkkuPlanerEntity, SensorEntity):
    entity_description: PlanerSensorDescription
    # Große Listen nicht in die Recorder-Datenbank schreiben
    _unrecorded_attributes = frozenset({"stunden", "tage", "verlauf_p10", "volltext", "akku_planer"})

    def __init__(self, coordinator: AkkuPlanerCoordinator, desc: PlanerSensorDescription) -> None:
        super().__init__(coordinator, desc.key)
        self.entity_description = desc

    @property
    def native_value(self):
        if not self.coordinator.data:
            return None
        return self.entity_description.value(self.coordinator, self.coordinator.data)

    @property
    def extra_state_attributes(self) -> dict | None:
        if not self.coordinator.data or not self.entity_description.attrs:
            return None
        return self.entity_description.attrs(self.coordinator, self.coordinator.data)
