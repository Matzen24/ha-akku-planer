"""Sonnenstand und Einstrahlung auf geneigte Flächen (reines numpy, ohne HA).

Konventionen:
- Zeit: Unix-Sekunden (UTC).
- Azimut: Grad ab Nord im Uhrzeigersinn (90 = Ost, 180 = Süd, 270 = West).
- Neigung: 0 = flach, 90 = senkrechte Wand.
"""

from __future__ import annotations

import numpy as np

SOLAR_CONSTANT = 1367.0
ALBEDO = 0.2
LOW_SUN_DEG = 15.0

# Virtuelle Flächen, gegen die das PV-Modell lernt: (Neigung, Azimut)
VIRTUAL_PLANES: list[tuple[float, float]] = [
    (0.0, 180.0),
    (30.0, 90.0), (30.0, 135.0), (30.0, 180.0), (30.0, 225.0), (30.0, 270.0),
    (90.0, 90.0), (90.0, 135.0), (90.0, 180.0), (90.0, 225.0), (90.0, 270.0),
]


def sun_position(ts: np.ndarray, lat: float, lon: float) -> tuple[np.ndarray, np.ndarray]:
    """Zenit- und Azimutwinkel der Sonne in Grad (NOAA-Näherung, Genauigkeit < 0,5°)."""
    ts = np.asarray(ts, dtype=float)
    days = ts / 86400.0
    # Tag im Jahr und Uhrzeit (UTC)
    year_frac_days = (days + 0.5) % 365.2425  # nur für den Winkel gamma relevant
    hours_utc = (ts % 86400.0) / 3600.0
    gamma = 2.0 * np.pi / 365.0 * (year_frac_days - 1 + (hours_utc - 12) / 24)

    eqtime = 229.18 * (
        0.000075 + 0.001868 * np.cos(gamma) - 0.032077 * np.sin(gamma)
        - 0.014615 * np.cos(2 * gamma) - 0.040849 * np.sin(2 * gamma)
    )
    decl = (
        0.006918 - 0.399912 * np.cos(gamma) + 0.070257 * np.sin(gamma)
        - 0.006758 * np.cos(2 * gamma) + 0.000907 * np.sin(2 * gamma)
        - 0.002697 * np.cos(3 * gamma) + 0.00148 * np.sin(3 * gamma)
    )
    true_solar_min = hours_utc * 60.0 + eqtime + 4.0 * lon
    ha = np.radians(true_solar_min / 4.0 - 180.0)

    phi = np.radians(lat)
    cos_zen = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
    cos_zen = np.clip(cos_zen, -1.0, 1.0)
    zen = np.arccos(cos_zen)

    sin_zen = np.maximum(np.sin(zen), 1e-6)
    cos_az = (np.sin(phi) * cos_zen - np.sin(decl)) / (np.cos(phi) * sin_zen)
    az = np.degrees(np.arccos(np.clip(cos_az, -1.0, 1.0)))
    # arccos liefert 0..180 ab Süd gemessen -> auf Nord-Bezug umrechnen
    az = np.where(ha > 0, (180.0 + az) % 360.0, (180.0 - az) % 360.0)
    return np.degrees(zen), az


def poa_irradiance(
    zen_deg: np.ndarray,
    sun_az_deg: np.ndarray,
    ghi: np.ndarray,
    dni: np.ndarray,
    dhi: np.ndarray,
    tilt_deg: float,
    plane_az_deg: float,
) -> np.ndarray:
    """Einstrahlung auf eine Fläche (W/m²) nach Hay-Davies."""
    zen = np.radians(zen_deg)
    tilt = np.radians(tilt_deg)
    cos_zen = np.cos(zen)
    cos_inc = cos_zen * np.cos(tilt) + np.sin(zen) * np.sin(tilt) * np.cos(
        np.radians(sun_az_deg - plane_az_deg)
    )
    cos_inc = np.maximum(cos_inc, 0.0)
    sun_up = cos_zen > 0.02

    beam = np.where(sun_up, dni * cos_inc, 0.0)
    ai = np.clip(dni / SOLAR_CONSTANT, 0.0, 1.0)
    rb = np.where(sun_up, cos_inc / np.maximum(cos_zen, 0.087), 0.0)
    sky = dhi * (ai * rb + (1.0 - ai) * (1.0 + np.cos(tilt)) / 2.0)
    ground = ghi * ALBEDO * (1.0 - np.cos(tilt)) / 2.0
    return np.maximum(beam + sky + ground, 0.0)


def temperature_factor(poa: np.ndarray, t_air: np.ndarray) -> np.ndarray:
    """Leistungsminderung durch Zelltemperatur (-0,4 %/K über 25 °C)."""
    t_cell = t_air + poa / 800.0 * 25.0
    return np.clip(1.0 - 0.004 * (t_cell - 25.0), 0.7, 1.1)


def plane_features(
    ts: np.ndarray,
    lat: float,
    lon: float,
    ghi: np.ndarray,
    dni: np.ndarray,
    dhi: np.ndarray,
    t_air: np.ndarray,
    planes: list[tuple[float, float]] | None = None,
    shift_seconds: float = -1800.0,
    low_sun_deg: float | None = LOW_SUN_DEG,
) -> np.ndarray:
    """Matrix [Stunden × Flächen] mit wirksamer Einstrahlung in kW/m².

    Open-Meteo-Strahlungswerte sind Mittel der *vorangegangenen* Stunde,
    daher wird der Sonnenstand zur Stundenmitte (Zeitstempel - 30 min) berechnet.

    Mit ``low_sun_deg`` wird jede Fläche in „tiefe Sonne“ (< Grenze) und „hohe Sonne“
    aufgeteilt (doppelte Spaltenzahl). So lernt das Modell Verschattung durch
    Bäume/Nachbarhäuser bei tiefem Sonnenstand (Backtest: -27 % Tagesfehler).
    """
    planes = planes or VIRTUAL_PLANES
    zen, az = sun_position(np.asarray(ts, dtype=float) + shift_seconds, lat, lon)
    ghi = np.nan_to_num(np.asarray(ghi, dtype=float))
    dni = np.nan_to_num(np.asarray(dni, dtype=float))
    dhi = np.nan_to_num(np.asarray(dhi, dtype=float))
    t_air = np.nan_to_num(np.asarray(t_air, dtype=float), nan=10.0)
    cols = []
    for tilt, paz in planes:
        poa = poa_irradiance(zen, az, ghi, dni, dhi, tilt, paz)
        cols.append(poa * temperature_factor(poa, t_air) / 1000.0)
    feats = np.column_stack(cols)
    if low_sun_deg is None:
        return feats
    low = ((90.0 - zen) < low_sun_deg)[:, None]
    return np.hstack([feats * ~low, feats * low])
