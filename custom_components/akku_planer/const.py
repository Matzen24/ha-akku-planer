"""Constants for Akku-Planer."""

from __future__ import annotations

DOMAIN = "akku_planer"

# --- Config keys (entities) ---
CONF_CONTROL = "control_type"
CONF_SOC = "soc_entity"
CONF_CAPACITY_AH = "capacity_ah_entity"
CONF_VOLTAGE = "voltage_entity"
CONF_CAPACITY_KWH = "capacity_kwh"
CONF_LOAD = "load_entity"            # optional: empty = derived from the Energy dashboard
CONF_PV_SOURCES = "pv_entities"      # power (W/kW) or energy (Wh/kWh) sensors, one per PV source
CONF_MIN_SOC = "min_soc_entity"
CONF_GRID_SOURCE = "grid_source_entity"
CONF_WARNING = "warning_entity"
CONF_SLOT_START = "slot_start_entity"
CONF_SLOT_DURATION = "slot_duration_entity"
CONF_SLOT_SOC = "slot_soc_entity"
CONF_SLOT_DAYS = "slot_days_entity"
CONF_CHARGE_SWITCH = "charge_switch_entity"   # generic: switch/input_boolean that forces grid charging
CONF_CHARGE_POWER = "grid_charge_power_kw"
CONF_BATTERY_POWER = "battery_power_entity"   # display only (cards)
CONF_GRID_POWER = "grid_power_entity"         # display only (cards)
CONF_PV_POWER = "pv_power_entity"             # display only (cards)
CONF_LOAD_POWER = "load_power_entity"         # display only (cards)

# --- Control types ---
CONTROL_VICTRON = "victron"   # Victron ESS: minimum SoC + scheduled charge slot
CONTROL_NUMBER = "number"     # any number entity for minimum SoC (+ optional charge switch)
CONTROL_NONE = "none"         # forecast + recommendation only, nothing is written
CONTROL_TYPES = [CONTROL_VICTRON, CONTROL_NUMBER, CONTROL_NONE]

# Defaults that are not system specific. Entities are detected during setup.
DEFAULTS: dict[str, object] = {
    CONF_CONTROL: CONTROL_NONE,
    CONF_CAPACITY_KWH: 0.0,  # 0 = Ah x V
    CONF_PV_SOURCES: [],
    CONF_CHARGE_POWER: 3.0,
}

# Values the very first (unpublished, version 1) config entries relied on implicitly.
LEGACY_V1_DEFAULTS: dict[str, object] = {
    CONF_SOC: "sensor.victron_mqtt_battery_512_battery_soc",
    CONF_CAPACITY_AH: "sensor.victron_mqtt_battery_512_battery_installed_capacity",
    CONF_VOLTAGE: "sensor.victron_mqtt_battery_512_battery_voltage",
    CONF_PV_SOURCES: [
        "sensor.victron_mqtt_pvinverter_32_pvinverter_power_total",
        "sensor.victron_mqtt_system_0_system_dc_pv_power",
    ],
    CONF_MIN_SOC: "number.victron_mqtt_system_0_system_ess_min_soc_limit",
    CONF_GRID_SOURCE: "sensor.victron_mqtt_system_0_system_ac_active_input_source",
    CONF_SLOT_START: "time.victron_mqtt_system_0_system_ess_schedule_charge_1_start",
    CONF_SLOT_DURATION: "number.victron_mqtt_system_0_system_ess_schedule_charge_1_duration",
    CONF_SLOT_SOC: "number.victron_mqtt_system_0_system_ess_schedule_charge_1_soc",
    CONF_SLOT_DAYS: "select.victron_mqtt_system_0_system_ess_schedule_charge_1_days",
}

# --- Settings (number entities) ---
SET_RESERVE = "reserve_soc"
SET_FLOOR = "floor_soc"
SET_STORM_RESERVE = "storm_reserve_soc"
SETTING_DEFAULTS = {SET_RESERVE: 50.0, SET_FLOOR: 15.0, SET_STORM_RESERVE: 80.0}

# --- Modes ---
MODE_AUTO = "auto"
MODE_RESERVE = "always_reserve"
MODE_FULL = "full_use"
MODE_OBSERVE = "observe"
MODES = [MODE_OBSERVE, MODE_AUTO, MODE_RESERVE, MODE_FULL]
DEFAULT_MODE = MODE_OBSERVE  # start in shadow mode

# --- Control parameters ---
UPDATE_MINUTES = 15
FORECAST_REFRESH_MINUTES = 60
MODEL_REFRESH_HOURS = 24
TRAINING_DAYS = 45
TRAINING_HALF_LIFE_DAYS = 10.0  # backtest: best trade-off between data volume and season change
LOAD_DAYS = 28
HORIZON_HOURS = 48        # planning: only the next 48 h decide the reserve
DISPLAY_DAYS = 4          # display: today + 3 days
FORECAST_DAYS = 5         # Open-Meteo request (a little more than DISPLAY_DAYS)
MIN_SOC_STEP = 5          # minimum SoC is rounded to steps of 5
MIN_SOC_HYSTERESIS = 5    # only write from this difference on
MAX_WRITES_PER_DAY = 6
GRID_CHARGE_MARGIN = 3    # % below target from which grid charging starts
STORM_LEVEL = 3           # warning level from which the storm reserve applies

SLOT_ON = "every_day"
SLOT_OFF = "disabled_every_day"

# Frontend (bundled Lovelace cards)
FRONTEND_URL = "/akku_planer_static"
FRONTEND_CARDS = (
    "akku-planer-card.js",
    "akku-planer-control-card.js",
    "akku-planer-forecast-card.js",
    "akku-planer-kpi-card.js",
)
