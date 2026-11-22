"""Verbrauchsprognose aus Stundenmittelwerten (reines Python/numpy, ohne HA)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import numpy as np


@dataclass
class LoadModel:
    """Stundenprofil nach Wochentag × Stunde, gemischt mit dem Tagesprofil."""

    weekday_hour: list[list[float]] = field(default_factory=lambda: [[float("nan")] * 24 for _ in range(7)])
    hour: list[float] = field(default_factory=lambda: [float("nan")] * 24)
    fallback_kw: float = 1.0
    samples: int = 0

    def fit(self, local_times: list[datetime], mean_kw: list[float], half_life_days: float = 10.0) -> "LoadModel":
        """local_times: Beginn der Stunde (lokale Zeit), mean_kw: mittlere Leistung in kW."""
        if not local_times:
            return self
        newest = max(local_times)
        wh_sum = np.zeros((7, 24))
        wh_w = np.zeros((7, 24))
        h_sum = np.zeros(24)
        h_w = np.zeros(24)
        vals = []
        for t, v in zip(local_times, mean_kw):
            if v is None or not np.isfinite(v) or v < 0:
                continue
            age = (newest - t).total_seconds() / 86400.0
            w = 0.5 ** (age / half_life_days)  # jüngere Tage zählen mehr
            wh_sum[t.weekday(), t.hour] += w * v
            wh_w[t.weekday(), t.hour] += w
            h_sum[t.hour] += w * v
            h_w[t.hour] += w
            vals.append(v)
        if not vals:
            return self
        with np.errstate(invalid="ignore", divide="ignore"):
            wh = wh_sum / wh_w
            hr = h_sum / h_w
        self.weekday_hour = [[float(x) for x in row] for row in wh]
        self.hour = [float(x) for x in hr]
        self.fallback_kw = float(np.mean(vals))
        self.samples = len(vals)
        return self

    def predict_kw(self, local_start: datetime) -> float:
        """Erwartete mittlere Leistung (kW) in der Stunde ab local_start."""
        h = self.hour[local_start.hour]
        wh = self.weekday_hour[local_start.weekday()][local_start.hour]
        h = h if np.isfinite(h) else self.fallback_kw
        if np.isfinite(wh):
            return 0.5 * wh + 0.5 * h
        return h

    def to_dict(self) -> dict:
        # JSON kennt kein NaN -> als None speichern
        def clean(v: float) -> float | None:
            return None if v is None or not np.isfinite(v) else round(float(v), 4)

        return {
            "weekday_hour": [[clean(v) for v in row] for row in self.weekday_hour],
            "hour": [clean(v) for v in self.hour],
            "fallback_kw": self.fallback_kw,
            "samples": self.samples,
        }

    @classmethod
    def from_dict(cls, data: dict | None) -> "LoadModel":
        if not data:
            return cls()

        def restore(v: float | None) -> float:
            return float("nan") if v is None else float(v)

        wh = data.get("weekday_hour") or [[None] * 24 for _ in range(7)]
        hr = data.get("hour") or [None] * 24
        return cls(
            weekday_hour=[[restore(v) for v in row] for row in wh],
            hour=[restore(v) for v in hr],
            fallback_kw=float(data.get("fallback_kw", 1.0)),
            samples=int(data.get("samples", 0)),
        )
