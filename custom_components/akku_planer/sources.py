"""Pure helpers for system detection (no Home Assistant imports, unit tested)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class EnergySources:
    """Statistic ids from the Energy dashboard (only local entities, no external statistics)."""

    solar_energy: list[str] = field(default_factory=list)
    solar_power: list[str] = field(default_factory=list)
    grid_from: list[str] = field(default_factory=list)
    grid_to: list[str] = field(default_factory=list)
    grid_power: list[str] = field(default_factory=list)
    battery_from: list[str] = field(default_factory=list)
    battery_to: list[str] = field(default_factory=list)
    battery_power_charge_positive: list[str] = field(default_factory=list)

    @property
    def can_derive_load(self) -> bool:
        return bool(self.grid_from) and bool(self.solar_energy or self.battery_from)

    @property
    def load_statistics(self) -> list[str]:
        return [*self.solar_energy, *self.grid_from, *self.grid_to, *self.battery_from, *self.battery_to]


def _local(stat_id: Any) -> str | None:
    """Only entity based statistics (sensor.x), not external ones (tibber:x)."""
    if isinstance(stat_id, str) and "." in stat_id and ":" not in stat_id:
        return stat_id
    return None


def parse_energy_sources(sources: list[dict[str, Any]]) -> EnergySources:
    """Pure function, unit tested: turn energy_sources prefs into lists of entity ids."""
    out = EnergySources()

    def add(lst: list[str], val: Any) -> None:
        if (v := _local(val)) and v not in lst:
            lst.append(v)

    for src in sources or []:
        typ = src.get("type")
        pc = src.get("power_config") or {}
        if typ == "solar":
            add(out.solar_energy, src.get("stat_energy_from"))
            add(out.solar_power, src.get("stat_rate"))
        elif typ == "grid":
            # Old format: flow_from / flow_to lists
            for f in src.get("flow_from") or []:
                add(out.grid_from, f.get("stat_energy_from"))
            for f in src.get("flow_to") or []:
                add(out.grid_to, f.get("stat_energy_to"))
            add(out.grid_from, src.get("stat_energy_from"))
            add(out.grid_to, src.get("stat_energy_to"))
            add(out.grid_power, pc.get("stat_rate") or src.get("stat_rate"))
        elif typ == "battery":
            add(out.battery_from, src.get("stat_energy_from"))
            add(out.battery_to, src.get("stat_energy_to"))
            # HA convention: stat_rate > 0 = discharging. An "inverted" sensor is charge-positive.
            add(out.battery_power_charge_positive, pc.get("stat_rate_inverted"))
    return out


_VENDOR_PLATFORMS = (
    "victron_mqtt", "victron", "victron_ble", "huawei_solar", "solaredge", "solaredge_modbus_multi", "sma",
    "fronius", "goodwe", "solax_modbus", "sungrow", "growatt_server", "foxess", "solarman", "sigen",
    "enphase_envoy", "tesla_fleet", "powerwall", "sonnenbatterie", "e3dc_rscp", "kostal_plenticore",
    "senec", "deye", "sofar", "zendure_ha", "anker_solix", "ecoflow_cloud",
)


def pick_soc(candidates: list[tuple[str, str, str | None]], battery_devices: set[str]) -> str | None:
    """Choose the battery state of charge.

    candidates: (entity_id, platform, device_id) of sensors with device_class battery and unit %.
    Pure function, unit tested.
    """
    def score(c: tuple[str, str, str | None]) -> int:
        eid, platform, dev = c
        s = 0
        if dev and dev in battery_devices:
            s += 100
        if platform in _VENDOR_PLATFORMS:
            s += 50
        if re.search(r"(^|_)(soc|state_of_charge|ladezustand|batterieladung)($|_)", eid.split(".", 1)[1]):
            s += 30
        if re.search(r"(phone|iphone|ipad|watch|pixel|galaxy|tablet|remote|fernbedienung|sensor_battery)", eid):
            s -= 200
        return s

    best = max(candidates, key=score, default=None)
    return best[0] if best and score(best) > 0 else None
