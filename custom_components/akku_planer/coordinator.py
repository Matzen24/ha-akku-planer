"""Coordinator: holt Daten, lernt Modelle, plant und steuert (mit Schutzmechanismen)."""

from __future__ import annotations

import logging
import math
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.statistics import statistics_during_period
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN, UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import (
    CONF_BATTERY_POWER,
    CONF_CAPACITY_AH,
    CONF_CAPACITY_KWH,
    CONF_CHARGE_POWER,
    CONF_CHARGE_SWITCH,
    CONF_CONTROL,
    CONF_GRID_POWER,
    CONF_GRID_SOURCE,
    CONF_LOAD_POWER,
    CONF_PV_POWER,
    CONTROL_NONE,
    CONTROL_VICTRON,
    CONF_LOAD,
    CONF_MIN_SOC,
    CONF_PV_SOURCES,
    CONF_SLOT_DAYS,
    CONF_SLOT_DURATION,
    CONF_SLOT_SOC,
    CONF_SLOT_START,
    CONF_SOC,
    CONF_VOLTAGE,
    CONF_WARNING,
    DEFAULT_MODE,
    DEFAULTS,
    DISPLAY_DAYS,
    DOMAIN,
    FORECAST_DAYS,
    FORECAST_REFRESH_MINUTES,
    HORIZON_HOURS,
    LOAD_DAYS,
    MAX_WRITES_PER_DAY,
    MIN_SOC_HYSTERESIS,
    MODE_OBSERVE,
    MODEL_REFRESH_HOURS,
    SET_FLOOR,
    SET_RESERVE,
    SET_STORM_RESERVE,
    SETTING_DEFAULTS,
    SLOT_OFF,
    SLOT_ON,
    STORM_LEVEL,
    TRAINING_DAYS,
    TRAINING_HALF_LIFE_DAYS,
    UPDATE_MINUTES,
)
from .detect import async_energy_sources
from .forecast import WeatherSeries, fetch_training_weather, fetch_weather
from .load_model import LoadModel
from .planner import Plan, PlanInput, make_plan, simulate, text, weekday
from .pv_model import PVModel
from .solar import plane_features

_LOGGER = logging.getLogger(__name__)
STORAGE_VERSION = 1


class AkkuPlanerCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Zentrale Logik des Akku-Planers."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(minutes=UPDATE_MINUTES),
            config_entry=entry,
        )
        self.entry = entry
        self._store: Store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self.settings: dict[str, float] = dict(SETTING_DEFAULTS)
        self.mode: str = DEFAULT_MODE
        self.automatic: bool = True
        self.pv_models: dict[str, PVModel] = {}
        self.load_model = LoadModel()
        self.weather: WeatherSeries | None = None
        self._weather_at: datetime | None = None
        self._model_at: datetime | None = None
        self._writes: dict[str, int] = {}
        self._slot_active = False
        self._slot_target: float | None = None
        self.daily_forecast: dict[str, float] = {}   # Datum -> P50-Prognose (kWh), morgens festgehalten
        self.daily_actual: dict[str, float] = {}
        self._actuals_day: str | None = None
        self.last_action: str = "–"

    # ------------------------------------------------------------------ Konfig
    def cfg(self, key: str) -> Any:
        merged = {**DEFAULTS, **self.entry.data, **self.entry.options}
        return merged.get(key)

    # ------------------------------------------------------------- Speicherung
    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.settings.update(data.get("settings", {}))
        self.mode = data.get("mode", DEFAULT_MODE)
        self.automatic = data.get("automatic", True)
        self.pv_models = {k: PVModel.from_dict(v) for k, v in data.get("pv_models", {}).items()}
        self.load_model = LoadModel.from_dict(data.get("load_model"))
        if ts := data.get("model_at"):
            self._model_at = dt_util.parse_datetime(ts)
        self._writes = data.get("writes", {})
        self._slot_active = data.get("slot_active", False)
        self._slot_target = data.get("slot_target")
        self.daily_forecast = data.get("daily_forecast", {})
        self.daily_actual = data.get("daily_actual", {})

    def _save(self) -> None:
        self._store.async_delay_save(self._serialize, 5)

    def _serialize(self) -> dict:
        return {
            "settings": self.settings,
            "mode": self.mode,
            "automatic": self.automatic,
            "pv_models": {k: m.to_dict() for k, m in self.pv_models.items()},
            "load_model": self.load_model.to_dict(),
            "model_at": self._model_at.isoformat() if self._model_at else None,
            "writes": self._writes,
            "slot_active": self._slot_active,
            "slot_target": self._slot_target,
            "daily_forecast": dict(list(self.daily_forecast.items())[-30:]),
            "daily_actual": dict(list(self.daily_actual.items())[-30:]),
        }

    async def async_set_setting(self, key: str, value: float) -> None:
        self.settings[key] = float(value)
        self._save()
        await self.async_request_refresh()

    async def async_set_mode(self, mode: str) -> None:
        self.mode = mode
        self._save()
        await self.async_request_refresh()

    async def async_set_automatic(self, on: bool) -> None:
        self.automatic = on
        if not on:
            await self._disable_charge()
        self._save()
        await self.async_request_refresh()

    async def async_retrain(self) -> None:
        self._model_at = None
        self._weather_at = None
        await self.async_request_refresh()

    # ---------------------------------------------------------------- Helfer
    def _num_state(self, entity_id: str | None) -> float | None:
        if not entity_id:
            return None
        st = self.hass.states.get(entity_id)
        if st is None or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN, ""):
            return None
        try:
            return float(st.state)
        except ValueError:
            return None

    def capacity_kwh(self) -> float:
        fixed = float(self.cfg(CONF_CAPACITY_KWH) or 0)
        if fixed > 0:
            return fixed
        ah = self._num_state(self.cfg(CONF_CAPACITY_AH))
        volt = self._num_state(self.cfg(CONF_VOLTAGE))
        if ah and volt:
            return ah * volt / 1000.0
        return 20.0

    def grid_available(self) -> bool:
        ent = self.cfg(CONF_GRID_SOURCE)
        if not ent:
            return True
        st = self.hass.states.get(ent)
        if st is None:
            return True
        if ent.startswith("binary_sensor."):
            return st.state != "off"
        # Victron Cerbo reports "not_connected" on grid loss; unknown -> do not block
        return st.state not in ("not_connected", "disconnected", "grid_lost", "no_grid", "off_grid")

    @property
    def lang(self) -> str:
        return self.hass.config.language or "en"

    @property
    def control(self) -> str:
        return self.cfg(CONF_CONTROL) or CONTROL_NONE

    def entity_map(self) -> dict[str, Any]:
        """Entity ids for the bundled cards (entity ids differ by language and system)."""
        reg = er.async_get(self.hass)
        own = {}
        for platform, key in (
            ("sensor", "target_min_soc"), ("sensor", "reason"), ("sensor", "forecast_days"),
            ("sensor", "pv_tomorrow"), ("sensor", "pv_today_remaining"), ("sensor", "pv_model"),
            ("sensor", "refill"), ("sensor", "drain"), ("sensor", "soc_at_refill"), ("sensor", "accuracy"),
            ("number", "reserve_soc"), ("number", "floor_soc"), ("number", "storm_reserve_soc"),
            ("select", "mode"), ("switch", "automatic"), ("binary_sensor", "grid_charge"),
            ("binary_sensor", "storm"), ("button", "retrain"),
        ):
            own[key] = reg.async_get_entity_id(platform, DOMAIN, f"{self.entry.entry_id}_{key}")
        return {
            **own,
            "soc": self.cfg(CONF_SOC),
            "min_soc": self.cfg(CONF_MIN_SOC) if self.control != CONTROL_NONE else None,
            "pv_power": self.cfg(CONF_PV_POWER),
            "pv_sources": list(self.cfg(CONF_PV_SOURCES) or []),
            "load_power": self.cfg(CONF_LOAD_POWER) or self.cfg(CONF_LOAD),
            "battery_power": self.cfg(CONF_BATTERY_POWER),
            "grid_power": self.cfg(CONF_GRID_POWER),
            "control": self.control,
        }

    def storm_level(self) -> float:
        lvl = self._num_state(self.cfg(CONF_WARNING))
        return lvl or 0.0

    async def _hourly_stats(self, entity_ids: list[str], days: int) -> dict[str, list[tuple[float, float]]]:
        """Hourly average power in W per entity.

        Works with power sensors (statistic "mean") and with energy meters (statistic "change",
        e.g. the sensors of the Energy dashboard). Units are normalised by the recorder.
        """
        ids = [e for e in dict.fromkeys(entity_ids) if e]
        if not ids:
            return {}
        end = dt_util.utcnow().replace(minute=0, second=0, microsecond=0)
        start = end - timedelta(days=days)
        result = await get_instance(self.hass).async_add_executor_job(
            statistics_during_period,
            self.hass, start, end, set(ids), "hour",
            {"power": UnitOfPower.WATT, "energy": UnitOfEnergy.KILO_WATT_HOUR}, {"mean", "change"},
        )
        out: dict[str, list[tuple[float, float]]] = {}
        for eid in ids:
            rows = []
            for r in result.get(eid, []):
                s = r.get("start")
                if isinstance(s, datetime):
                    s = s.timestamp()
                if s is None:
                    continue
                if r.get("mean") is not None:
                    rows.append((float(s), float(r["mean"])))
                elif r.get("change") is not None:
                    # kWh within one hour == average kW -> W
                    rows.append((float(s), float(r["change"]) * 1000.0))
            out[eid] = rows
        return out

    async def _derived_load(self, days: int) -> list[tuple[float, float]]:
        """House consumption from the Energy dashboard: solar + grid import - export + battery out - in."""
        energy = await async_energy_sources(self.hass)
        if not energy.can_derive_load:
            return []
        stats = await self._hourly_stats(energy.load_statistics, days)
        sign = {e: 1.0 for e in energy.solar_energy + energy.grid_from + energy.battery_from}
        sign.update({e: -1.0 for e in energy.grid_to + energy.battery_to})
        hours: dict[float, float] = {}
        seen_grid: set[float] = set()
        for eid, rows in stats.items():
            for ts, w in rows:
                hours[ts] = hours.get(ts, 0.0) + sign.get(eid, 0.0) * w
                if eid in energy.grid_from:
                    seen_grid.add(ts)
        # Only hours with a grid reading are complete
        return sorted((ts, max(0.0, w)) for ts, w in hours.items() if ts in seen_grid)

    # ------------------------------------------------------------- Training
    async def _train(self) -> None:
        lat, lon = self.hass.config.latitude, self.hass.config.longitude
        pv_ids: list[str] = list(self.cfg(CONF_PV_SOURCES) or [])
        load_id: str | None = self.cfg(CONF_LOAD) or None
        stats = await self._hourly_stats(pv_ids + ([load_id] if load_id else []), max(TRAINING_DAYS, LOAD_DAYS))
        load_rows = stats.get(load_id, []) if load_id else await self._derived_load(LOAD_DAYS)

        w = await fetch_training_weather(
            async_get_clientsession(self.hass), lat, lon, past_days=TRAINING_DAYS + 1
        )
        idx = {int(t): i for i, t in enumerate(w.ts) if np.isfinite(w.ghi[i])}
        now_ts = dt_util.utcnow().timestamp()
        # Models of PV sources that were removed from the configuration must not count any more
        self.pv_models = {k: m for k, m in self.pv_models.items() if k in pv_ids}
        for eid in pv_ids:
            rows = stats.get(eid, [])
            sel, y = [], []
            for start_ts, mean_w in rows:
                # Statistik [S, S+1h) <-> Open-Meteo-Zeitstempel S+1h (Mittel der Vorstunde)
                i = idx.get(int(start_ts + 3600))
                if i is None:
                    continue
                sel.append(i)
                y.append(max(mean_w, 0.0) / 1000.0)
            if len(sel) < 48:
                _LOGGER.warning("Not enough training data for %s yet (%d hours)", eid, len(sel))
                continue
            s = np.array(sel)
            feats = plane_features(w.ts[s], lat, lon, w.ghi[s], w.dni[s], w.dhi[s], w.temp[s])
            # Jüngere Tage zählen mehr (Saison: Sonnenbahn und Verschattung ändern sich)
            age_days = (now_ts - w.ts[s]) / 86400.0
            weights = 0.5 ** (age_days / TRAINING_HALF_LIFE_DAYS)
            model = PVModel().fit(feats, np.array(y), sample_weight=weights)
            if model.is_fitted:
                self.pv_models[eid] = model
                _LOGGER.info("PV model %s: %.1f kWp eff., RMSE %.2f kW, %s",
                             eid, model.total_kwp, model.rmse_kw, model.describe())

        cutoff = dt_util.utcnow().timestamp() - LOAD_DAYS * 86400
        times = [dt_util.as_local(dt_util.utc_from_timestamp(t)) for t, _ in load_rows if t >= cutoff]
        vals = [v / 1000.0 for t, v in load_rows if t >= cutoff]
        self.load_model.fit(times, vals)

        self._store_actuals(stats, pv_ids)
        self._model_at = dt_util.utcnow()
        self._save()

    def _store_actuals(self, stats: dict[str, list[tuple[float, float]]], pv_ids: list[str]) -> None:
        """Tatsächliche PV-Tagesenergie abgeschlossener Tage für den Prognosevergleich."""
        actual: dict[str, float] = {}
        for eid in pv_ids:
            for start_ts, mean_w in stats.get(eid, []):
                d = dt_util.as_local(dt_util.utc_from_timestamp(start_ts)).date().isoformat()
                actual[d] = actual.get(d, 0.0) + max(mean_w, 0.0) / 1000.0
        today = dt_util.now().date().isoformat()
        for d, v in actual.items():
            if d < today and d in self.daily_forecast:
                self.daily_actual[d] = round(v, 2)
        self._actuals_day = today

    async def _update_actuals(self) -> None:
        """Einmal pro Tag (nach Mitternacht) die Ist-Werte der Vortage nachtragen."""
        pv_ids: list[str] = list(self.cfg(CONF_PV_SOURCES) or [])
        if not pv_ids:
            return
        stats = await self._hourly_stats(pv_ids, 8)
        self._store_actuals(stats, pv_ids)
        self._save()

    # ------------------------------------------------------------- Prognose
    def _pv_forecast(self, start_utc: float, hours: int) -> dict[str, np.ndarray]:
        """PV je Stunde [H, H+1h) in kWh für P10/P50/P90."""
        w = self.weather
        lat, lon = self.hass.config.latitude, self.hass.config.longitude
        targets = np.array([start_utc + 3600 * (k + 1) for k in range(hours)])
        idx = {int(t): i for i, t in enumerate(w.ts)}
        sel = np.array([idx.get(int(t), -1) for t in targets])
        valid = sel >= 0
        out = {q: np.zeros(hours) for q in ("p10", "p50", "p90")}
        if not valid.any() or not self.pv_models:
            return out
        s = sel[valid]
        feats = plane_features(w.ts[s], lat, lon, w.ghi[s], w.dni[s], w.dhi[s], w.temp[s])
        base = np.zeros(len(s))
        pv_ids = set(self.cfg(CONF_PV_SOURCES) or [])
        for eid, model in self.pv_models.items():
            if eid in pv_ids:
                base += model.predict(feats)
        for q, fac in (("p10", w.q10), ("p50", w.q50), ("p90", w.q90)):
            f = fac[s] if fac.size else np.ones(len(s))
            out[q][valid] = base * f
        return out

    # ------------------------------------------------------------ Hauptlauf
    async def _async_update_data(self) -> dict[str, Any]:
        now = dt_util.utcnow()
        try:
            if self.weather is None or self._weather_at is None or \
                    now - self._weather_at > timedelta(minutes=FORECAST_REFRESH_MINUTES):
                session = async_get_clientsession(self.hass)
                self.weather = await fetch_weather(
                    session, self.hass.config.latitude, self.hass.config.longitude,
                    forecast_days=FORECAST_DAYS,
                )
                self._weather_at = now
        except Exception as err:  # noqa: BLE001
            if self.weather is None:
                raise UpdateFailed(f"Open-Meteo not reachable: {err}") from err
            _LOGGER.warning("Open-Meteo request failed, using previous data: %s", err)

        removed = set(self.pv_models) - set(self.cfg(CONF_PV_SOURCES) or [])
        if self._model_at is None or now - self._model_at > timedelta(hours=MODEL_REFRESH_HOURS) or removed \
                or not self.pv_models:
            try:
                await self._train()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Training failed")

        if self._actuals_day != dt_util.now().date().isoformat():
            try:
                await self._update_actuals()
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Reading actual PV values for the accuracy check failed")

        # --- Anzeige-Raster: heute 00:00 bis Ende Tag +3 (4 Tage) ---
        local_now = dt_util.now()
        hour0 = local_now.replace(minute=0, second=0, microsecond=0)
        day0 = dt_util.start_of_local_day(local_now)
        disp_start_utc = dt_util.as_utc(day0).timestamp()
        disp_hours = [dt_util.as_local(dt_util.utc_from_timestamp(disp_start_utc + 3600 * k))
                      for k in range(DISPLAY_DAYS * 24 + 2)]
        disp_hours = [h for h in disp_hours if (h.date() - day0.date()).days < DISPLAY_DAYS]
        pv_disp = self._pv_forecast(disp_start_utc, len(disp_hours))
        load_disp = np.array([self.load_model.predict_kw(h) for h in disp_hours])

        # --- Planungs-Raster: ab aktueller Stunde, HORIZON_HOURS ---
        i0 = next((i for i, h in enumerate(disp_hours) if h >= hour0), 0)
        n_plan = min(HORIZON_HOURS, len(disp_hours) - i0)
        hours = disp_hours[i0:i0 + n_plan]
        pv = {q: pv_disp[q][i0:i0 + n_plan].copy() for q in pv_disp}
        load = load_disp[i0:i0 + n_plan].copy()
        frac = 1.0 - (local_now.minute * 60 + local_now.second) / 3600.0
        for arr in (pv["p10"], pv["p50"], pv["p90"], load):
            arr[0] *= frac

        soc = self._num_state(self.cfg(CONF_SOC))
        cap = self.capacity_kwh()
        storm = self.storm_level() >= STORM_LEVEL

        plan = make_plan(PlanInput(
            hours=hours,
            pv_p10_kwh=pv["p10"].tolist(),
            pv_p50_kwh=pv["p50"].tolist(),
            load_kwh=load.tolist(),
            soc=soc if soc is not None else 50.0,
            capacity_kwh=cap,
            reserve=self.settings[SET_RESERVE],
            floor=self.settings[SET_FLOOR],
            storm_reserve=self.settings[SET_STORM_RESERVE],
            storm_active=storm,
            mode=self.mode,
            charge_power_kw=float(self.cfg(CONF_CHARGE_POWER) or 3.0),
            lang=self.lang,
        ))

        # Tagessummen
        def day_sum(hrs: list[datetime], arr: np.ndarray, day: date) -> float:
            return float(sum(v for h, v in zip(hrs, arr) if h.date() == day))

        today, tomorrow = hour0.date(), hour0.date() + timedelta(days=1)

        # Erwarteter SoC-Verlauf (P50) über den ganzen Anzeigezeitraum ab jetzt
        net50_disp = (pv_disp["p50"] - load_disp)[i0:]
        net50_disp[0] *= frac
        soc_now = soc if soc is not None else 50.0
        soc_path = simulate(soc_now, net50_disp.tolist(), cap, min(plan.target_min_soc, soc_now))

        days = []
        for d in range(DISPLAY_DAYS):
            day = today + timedelta(days=d)
            entry = {
                "datum": day.isoformat(),
                "tag": text(self.lang, "today") if d == 0 else text(self.lang, "tomorrow") if d == 1
                else weekday(self.lang, day.weekday()),
                "pv_p10": round(day_sum(disp_hours, pv_disp["p10"], day), 1),
                "pv_p50": round(day_sum(disp_hours, pv_disp["p50"], day), 1),
                "pv_p90": round(day_sum(disp_hours, pv_disp["p90"], day), 1),
                "verbrauch": round(day_sum(disp_hours, load_disp, day), 1),
            }
            entry["ueberschuss_p50"] = round(entry["pv_p50"] - entry["verbrauch"], 1)
            days.append(entry)

        hourly = []
        for k, h in enumerate(disp_hours):
            row = {
                "t": int(h.timestamp() * 1000),
                "p10": round(float(pv_disp["p10"][k]), 2),
                "p50": round(float(pv_disp["p50"][k]), 2),
                "p90": round(float(pv_disp["p90"][k]), 2),
                "last": round(float(load_disp[k]), 2),
            }
            if k >= i0:
                row["soc"] = soc_path[k - i0]
            hourly.append(row)

        forecast = {
            "today_remaining": {q: round(day_sum(hours, pv[q], today), 2) for q in pv},
            "tomorrow": {q: round(day_sum(disp_hours, pv_disp[q], tomorrow), 2) for q in pv_disp},
            "days": days,
            "hourly": hourly,
        }
        # Ganztagesprognose (P50) einmal am Vormittag für den Genauigkeitsvergleich festhalten
        key = today.isoformat()
        if key not in self.daily_forecast and local_now.hour < 10:
            self.daily_forecast[key] = days[0]["pv_p50"]
            self._save()

        if soc is None:
            plan.reason = text(self.lang, "soc_unknown") + plan.reason

            # Typical right after a restart: the inverter does not report yet -> recalculate in 1 min
            async def _retry(_now: datetime) -> None:
                await self.async_request_refresh()

            async_call_later(self.hass, 60, _retry)
        elif self.control == CONTROL_NONE:
            self.last_action = text(self.lang, "no_control")
        elif self.automatic and self.mode != MODE_OBSERVE:
            if self.grid_available():
                await self._actuate(plan)
            else:
                self.last_action = text(self.lang, "grid_loss")

        return {
            "plan": plan,
            "soc": soc,
            "capacity_kwh": round(cap, 2),
            "forecast": forecast,
            "storm_level": self.storm_level(),
            "grid_available": self.grid_available(),
            "accuracy": self.accuracy(),
        }

    def accuracy(self) -> dict[str, Any]:
        days = sorted(d for d in self.daily_actual if d in self.daily_forecast)[-14:]
        errs = []
        detail = []
        for d in days:
            act, fc = self.daily_actual[d], self.daily_forecast[d]
            detail.append({"datum": d, "prognose": fc, "ist": act})
            if act > 0.5 and d in days[-7:]:
                errs.append(abs(fc - act) / act)
        mape = round(100 * (1 - min(1.0, sum(errs) / len(errs))), 1) if errs else None
        return {"score": mape, "days": detail}

    # --------------------------------------------------------------- Aktor
    def _writes_today(self) -> int:
        return self._writes.get(dt_util.now().date().isoformat(), 0)

    def _count_write(self) -> None:
        key = dt_util.now().date().isoformat()
        self._writes = {key: self._writes.get(key, 0) + 1}
        self._save()

    async def _actuate(self, plan: Plan) -> None:
        min_soc_ent = self.cfg(CONF_MIN_SOC)
        current = self._num_state(min_soc_ent)
        target = plan.target_min_soc
        if current is not None and min_soc_ent:
            diff = target - current
            urgent = plan.decision == "unwetter" and diff > 0
            if (abs(diff) >= MIN_SOC_HYSTERESIS or urgent) and                     (self._writes_today() < MAX_WRITES_PER_DAY or urgent):
                domain = min_soc_ent.split(".", 1)[0]  # number or input_number
                await self.hass.services.async_call(
                    domain, "set_value", {"entity_id": min_soc_ent, "value": target}, blocking=True,
                )
                self._count_write()
                self.last_action = text(self.lang, "set_min_soc", time=f"{dt_util.now():%H:%M}",
                                        a=f"{current:.0f}", b=f"{target:.0f}")
                _LOGGER.info("Akku-Planer: %s (%s)", self.last_action, plan.reason)

        if plan.grid_charge:
            await self._enable_charge(plan)
        elif self._slot_active:
            await self._disable_charge()

    def _slot_ok(self) -> bool:
        return self.control == CONTROL_VICTRON and all(
            self.cfg(k) for k in (CONF_SLOT_START, CONF_SLOT_DURATION, CONF_SLOT_SOC, CONF_SLOT_DAYS))

    def _switch_ok(self) -> bool:
        return self.control != CONTROL_VICTRON and bool(self.cfg(CONF_CHARGE_SWITCH))

    async def _enable_charge(self, plan: Plan) -> None:
        if self._slot_active and self._slot_target == plan.charge_target_soc:
            return
        svc = self.hass.services
        if self._slot_ok():
            start = dt_util.now().replace(second=0, microsecond=0)
            start -= timedelta(minutes=start.minute % 15)
            await svc.async_call("time", "set_value",
                                 {"entity_id": self.cfg(CONF_SLOT_START), "time": start.strftime("%H:%M:00")},
                                 blocking=True)
            await svc.async_call("number", "set_value",
                                 {"entity_id": self.cfg(CONF_SLOT_DURATION),
                                  "value": min(1440, plan.charge_hours * 60 + 15)}, blocking=True)
            await svc.async_call("number", "set_value",
                                 {"entity_id": self.cfg(CONF_SLOT_SOC), "value": math.ceil(plan.charge_target_soc)},
                                 blocking=True)
            await svc.async_call("select", "select_option",
                                 {"entity_id": self.cfg(CONF_SLOT_DAYS), "option": SLOT_ON}, blocking=True)
        elif self._switch_ok():
            if self._slot_active:  # switch already on, only the target changed
                self._slot_target = plan.charge_target_soc
                return
            await svc.async_call("homeassistant", "turn_on", {"entity_id": self.cfg(CONF_CHARGE_SWITCH)},
                                 blocking=True)
        else:
            return
        self._slot_active = True
        self._slot_target = plan.charge_target_soc
        self.last_action = text(self.lang, "charge_on", time=f"{dt_util.now():%H:%M}",
                                t=f"{plan.charge_target_soc:.0f}")
        _LOGGER.info("Akku-Planer: %s", self.last_action)
        self._save()

    async def _disable_charge(self) -> None:
        if not self._slot_active:
            return
        svc = self.hass.services
        if self._slot_ok():
            await svc.async_call("select", "select_option",
                                 {"entity_id": self.cfg(CONF_SLOT_DAYS), "option": SLOT_OFF}, blocking=True)
            await svc.async_call("number", "set_value",
                                 {"entity_id": self.cfg(CONF_SLOT_DURATION), "value": 0}, blocking=True)
        elif self._switch_ok():
            await svc.async_call("homeassistant", "turn_off", {"entity_id": self.cfg(CONF_CHARGE_SWITCH)},
                                 blocking=True)
        self._slot_active = False
        self._slot_target = None
        self.last_action = text(self.lang, "charge_off", time=f"{dt_util.now():%H:%M}")
        self._save()
