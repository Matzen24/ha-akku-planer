"""Detection helpers: Energy dashboard parsing and state-of-charge choice."""

from datetime import datetime

from custom_components.akku_planer.planner import PlanInput, make_plan
from custom_components.akku_planer.sources import parse_energy_sources, pick_power, pick_soc

PREFS = [
    {"type": "grid", "stat_energy_from": "sensor.grid_in", "stat_energy_to": "sensor.grid_out",
     "power_config": {"stat_rate": "sensor.grid_power"}},
    {"type": "gas", "stat_energy_from": "sensor.gas"},
    {"type": "solar", "stat_energy_from": "sensor.pv_ac_total", "stat_rate": "sensor.pv_ac_power"},
    {"type": "solar", "stat_energy_from": "sensor.mppt1_total"},
    {"type": "solar", "stat_energy_from": "tibber:external_stat"},
    {"type": "battery", "stat_energy_from": "sensor.bat_out", "stat_energy_to": "sensor.bat_in",
     "power_config": {"stat_rate_inverted": "sensor.bat_power"}},
]


def test_parse_energy_sources():
    e = parse_energy_sources(PREFS)
    assert e.solar_energy == ["sensor.pv_ac_total", "sensor.mppt1_total"]  # external statistic skipped
    assert e.solar_power == ["sensor.pv_ac_power"]
    assert e.grid_from == ["sensor.grid_in"] and e.grid_to == ["sensor.grid_out"]
    assert e.grid_power == ["sensor.grid_power"]
    assert e.battery_from == ["sensor.bat_out"] and e.battery_to == ["sensor.bat_in"]
    assert e.battery_power_charge_positive == ["sensor.bat_power"]
    assert e.can_derive_load
    assert "sensor.gas" not in e.load_statistics


def test_parse_old_grid_format_and_empty():
    e = parse_energy_sources([{"type": "grid", "flow_from": [{"stat_energy_from": "sensor.a"}],
                               "flow_to": [{"stat_energy_to": "sensor.b"}]}])
    assert e.grid_from == ["sensor.a"] and e.grid_to == ["sensor.b"]
    assert not e.can_derive_load  # no solar and no battery
    assert not parse_energy_sources([]).can_derive_load


def test_pick_soc_prefers_battery_device_and_ignores_phones():
    cands = [
        ("sensor.iphone_battery_level", "mobile_app", "phone"),
        ("sensor.inverter_battery_soc", "victron_mqtt", "bat"),
        ("sensor.door_sensor_battery", "zha", "door"),
    ]
    assert pick_soc(cands, {"bat"}) == "sensor.inverter_battery_soc"
    assert pick_soc(cands, set()) == "sensor.inverter_battery_soc"
    assert pick_soc([("sensor.remote_battery", "zha", "x")], set()) is None


def test_plan_english_text():
    hours = [datetime(2026, 6, 1, h) for h in range(24)]
    pv = [0.0] * 8 + [3.0] * 8 + [0.0] * 8
    plan = make_plan(PlanInput(hours=hours, pv_p10_kwh=pv, pv_p50_kwh=pv, load_kwh=[0.5] * 24, soc=60,
                               capacity_kwh=20, reserve=50, floor=15, storm_reserve=80, lang="en-GB"))
    assert plan.decision == "sonnig"
    assert "safe surplus" in plan.reason and "Mo 08:00" in plan.reason


POWER = [
    ("sensor.victron_mqtt_system_0_system_grid_power_l1_2", "victron_mqtt", "sys"),
    ("sensor.victron_mqtt_grid_30_grid_power", "victron_mqtt", "grid"),
    ("sensor.victron_mqtt_system_0_system_dc_battery_power", "victron_mqtt", "sys"),
    ("sensor.victron_mqtt_battery_512_battery_power", "victron_mqtt", "bat"),
    ("sensor.victron_mqtt_system_0_system_dc_pv_power", "victron_mqtt", "sys"),
    ("sensor.pv1_power", "solarman", "pv1"),
    ("sensor.waschmaschine_power", "shelly", "wm"),
]


def test_pick_power_totals_and_battery_device():
    assert pick_power("grid", POWER) == "sensor.victron_mqtt_grid_30_grid_power"  # per-phase skipped
    assert pick_power("battery", POWER, "bat") == "sensor.victron_mqtt_battery_512_battery_power"
    assert pick_power("battery", [("sensor.ess_setpoint_battery_power", "x", None)]) is None
    assert pick_power("grid", [("sensor.waschmaschine_power", "shelly", "wm")]) is None


def test_pick_power_pv_only_when_unambiguous():
    assert pick_power("pv", POWER, unique=True) is None  # several inverters -> the card adds them up
    assert pick_power("pv", [("sensor.solar_power", "fronius", "inv")], unique=True) == "sensor.solar_power"
