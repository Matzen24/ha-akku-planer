"""Wetter-/Strahlungsdaten von Open-Meteo (kostenlos, ohne API-Key).

* Deterministisch (inkl. Vergangenheit für das Training): GHI, DNI, DHI, Temperatur.
* Ensemble (ICON-EPS, ~40 Mitglieder): Streuung der Globalstrahlung -> P10/P50/P90.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import numpy as np

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
HOURLY_VARS = "shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m,cloud_cover"


@dataclass
class WeatherSeries:
    ts: np.ndarray                     # Unix-Sekunden UTC (Ende der Mittelungsstunde)
    ghi: np.ndarray
    dni: np.ndarray
    dhi: np.ndarray
    temp: np.ndarray
    cloud: np.ndarray
    # Faktoren relativ zur deterministischen GHI je Stunde (aus Ensemble)
    q10: np.ndarray = field(default_factory=lambda: np.array([]))
    q50: np.ndarray = field(default_factory=lambda: np.array([]))
    q90: np.ndarray = field(default_factory=lambda: np.array([]))

    def slice_from(self, ts_start: float) -> "WeatherSeries":
        m = self.ts >= ts_start
        return WeatherSeries(
            self.ts[m], self.ghi[m], self.dni[m], self.dhi[m], self.temp[m], self.cloud[m],
            self.q10[m] if self.q10.size else self.q10,
            self.q50[m] if self.q50.size else self.q50,
            self.q90[m] if self.q90.size else self.q90,
        )


def _arr(values: list | None, n: int) -> np.ndarray:
    if values is None:
        return np.full(n, np.nan)
    return np.array([np.nan if v is None else float(v) for v in values], dtype=float)


def parse_forecast(data: dict[str, Any], suffix: str = "") -> WeatherSeries:
    h = data["hourly"]
    ts = np.array(h["time"], dtype=float)
    n = len(ts)
    return WeatherSeries(
        ts=ts,
        ghi=_arr(h.get("shortwave_radiation" + suffix), n),
        dni=_arr(h.get("direct_normal_irradiance" + suffix), n),
        dhi=_arr(h.get("diffuse_radiation" + suffix), n),
        temp=_arr(h.get("temperature_2m" + suffix), n),
        cloud=_arr(h.get("cloud_cover" + suffix), n),
    )


def apply_ensemble(series: WeatherSeries, data: dict[str, Any] | None) -> WeatherSeries:
    """Berechnet Quantil-Faktoren aus dem Ensemble; ohne Ensemble: Heuristik über Bewölkung."""
    n = len(series.ts)
    q10 = np.ones(n)
    q50 = np.ones(n)
    q90 = np.ones(n)
    used = np.zeros(n, dtype=bool)
    if data and "hourly" in data:
        h = data["hourly"]
        ens_ts = np.array(h["time"], dtype=float)
        members = [
            _arr(v, len(ens_ts)) for k, v in h.items()
            if k.startswith("shortwave_radiation") and isinstance(v, list)
        ]
        if members:
            m = np.vstack(members)
            idx = {t: i for i, t in enumerate(ens_ts)}
            for i, t in enumerate(series.ts):
                j = idx.get(t)
                if j is None:
                    continue
                col = m[:, j]
                col = col[np.isfinite(col)]
                if col.size < 5:
                    continue
                ref = np.mean(col)
                if ref < 20:  # Dämmerung/Nacht: Faktor egal
                    continue
                p10, p50, p90 = np.percentile(col, [10, 50, 90])
                q10[i], q50[i], q90[i] = p10 / ref, p50 / ref, p90 / ref
                used[i] = True
    # Fallback: Unsicherheit wächst mit Bewölkung und Vorlaufzeit
    cloud = np.nan_to_num(series.cloud, nan=50.0) / 100.0
    fallback_low = 1.0 - (0.25 + 0.45 * cloud)
    q10 = np.where(used, q10, fallback_low)
    q90 = np.where(used, q90, 1.0 + 0.3 * cloud)
    series.q10 = np.clip(q10, 0.0, 1.0)
    series.q50 = np.clip(q50, 0.2, 1.5)
    series.q90 = np.clip(q90, 1.0, 2.5)
    return series


def _common(lat: float, lon: float) -> dict[str, str]:
    # 2 Nachkommastellen (~1 km) reichen für Wettermodelle völlig aus
    return {"latitude": f"{lat:.2f}", "longitude": f"{lon:.2f}", "timezone": "UTC", "timeformat": "unixtime"}


async def _get(session, url: str, params: dict) -> dict:
    async with asyncio.timeout(60):
        resp = await session.get(url, params=params)
        resp.raise_for_status()
        return await resp.json()


async def fetch_training_weather(session, lat: float, lon: float, past_days: int) -> WeatherSeries:
    """Vergangene *Vortages*prognosen (Previous-Runs-API).

    Das Modell wird auf genau den Daten trainiert, die es später auch bekommt
    (Prognose vom Vortag) – so lernt es den systematischen Fehler der Wettervorhersage
    gleich mit (Backtest: kleinerer Tagesfehler als Training auf Ist-Wetter).
    """
    vars_ = ",".join(v + "_previous_day1" for v in HOURLY_VARS.split(","))
    params = {**_common(lat, lon), "hourly": vars_, "past_days": str(past_days), "forecast_days": "1"}
    data = await _get(session, PREVIOUS_RUNS_URL, params)
    return parse_forecast(data, "_previous_day1")


async def fetch_weather(session, lat: float, lon: float, forecast_days: int = 3) -> WeatherSeries:
    """Holt die deterministische Vorhersage und das Ensemble."""
    common = _common(lat, lon)
    det_params = {**common, "hourly": HOURLY_VARS, "past_days": "1", "forecast_days": str(forecast_days)}
    ens_params = {**common, "hourly": "shortwave_radiation", "models": "icon_seamless",
                  "forecast_days": str(forecast_days)}

    async def get(url: str, params: dict) -> dict:
        return await _get(session, url, params)

    det = await get(FORECAST_URL, det_params)
    series = parse_forecast(det)
    try:
        ens = await get(ENSEMBLE_URL, ens_params)
    except Exception:  # noqa: BLE001 - Ensemble ist optional
        ens = None
    return apply_ensemble(series, ens)
