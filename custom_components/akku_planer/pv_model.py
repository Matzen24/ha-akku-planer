"""Selbstlernendes PV-Modell (reines numpy, ohne HA).

Idee: Die tatsächliche PV-Leistung ist näherungsweise eine nicht-negative
Kombination der Einstrahlung auf verschiedene Himmelsrichtungen/Neigungen.
Das Gewicht je virtueller Fläche entspricht einer „effektiven kWp“. So werden
beliebig ausgerichtete Dach- und Wandmodule, Verschattung und Verluste ohne
manuelle Eingabe der Geometrie abgebildet.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .solar import VIRTUAL_PLANES


def nnls(a: np.ndarray, b: np.ndarray, max_iter: int = 500, tol: float = 1e-10) -> np.ndarray:
    """Nicht-negative kleinste Quadrate (Lawson-Hanson)."""
    m, n = a.shape
    x = np.zeros(n)
    passive = np.zeros(n, dtype=bool)
    w = a.T @ (b - a @ x)
    it = 0
    while (~passive).any() and w[~passive].max() > tol and it < max_iter:
        it += 1
        idx = np.where(~passive)[0][np.argmax(w[~passive])]
        passive[idx] = True
        while passive.any():
            s = np.zeros(n)
            s[passive] = np.linalg.lstsq(a[:, passive], b, rcond=None)[0]
            if s[passive].min() > 0:
                x = s
                break
            mask = passive & (s <= 0)
            denom = x[mask] - s[mask]
            ratios = np.where(denom > 0, x[mask] / np.where(denom > 0, denom, 1.0), np.inf)
            alpha = float(np.min(ratios)) if ratios.size else 0.0
            if not np.isfinite(alpha):
                alpha = 0.0
            x = x + alpha * (s - x)
            x[mask & (x <= tol)] = 0.0
            passive &= x > tol
        w = a.T @ (b - a @ x)
        if not passive.any():
            # Neu aufgenommene Variable war nicht sinnvoll -> Abbruch statt Endlosschleife
            w[idx] = 0.0
            if w.max() <= tol:
                break
    return np.maximum(x, 0.0)


@dataclass
class PVModel:
    """Gelerntes Modell für eine PV-Quelle (z. B. AC-Sofar oder DC-MPPT)."""

    weights: list[float] = field(default_factory=list)  # kWp je virtueller Fläche
    cap_kw: float = 0.0          # Begrenzung (Wechselrichter-Clipping)
    fitted_hours: int = 0
    rmse_kw: float = 0.0
    planes: list[tuple[float, float]] = field(default_factory=lambda: list(VIRTUAL_PLANES))

    @property
    def is_fitted(self) -> bool:
        return bool(self.weights) and self.fitted_hours > 0

    @property
    def _n_planes(self) -> int:
        return len(self.planes)

    @property
    def high_sun_weights(self) -> list[float]:
        return self.weights[: self._n_planes]

    @property
    def total_kwp(self) -> float:
        """Effektive Leistung bei hoher Sonne (≈ installierte kWp × Wirkungsgrad)."""
        return float(sum(self.high_sun_weights))

    def fit(
        self,
        features: np.ndarray,
        actual_kw: np.ndarray,
        ridge: float = 0.05,
        sample_weight: np.ndarray | None = None,
    ) -> "PVModel":
        """Lernt die Gewichte.

        features: [Stunden × Spalten] aus ``plane_features`` (kW/m²),
        actual_kw: gemessene Mittelleistung je Stunde,
        sample_weight: z. B. höhere Gewichte für jüngere Tage (Saisonwechsel).
        """
        x = np.asarray(features, dtype=float)
        y = np.asarray(actual_kw, dtype=float)
        sw = np.ones(len(y)) if sample_weight is None else np.asarray(sample_weight, dtype=float)
        ok = np.isfinite(y) & np.isfinite(x).all(axis=1) & (y >= 0) & np.isfinite(sw)
        # Nur Stunden mit nennenswerter Einstrahlung (Nacht bringt keine Information)
        ok &= x.max(axis=1) > 0.02
        x, y, sw = x[ok], y[ok], sw[ok]
        if len(y) < 48:
            return self
        # Ausreißer (Ausfall, Abregelung bei vollem Akku) dämpfen: Stunden, in denen
        # deutlich weniger erzeugt wurde als ein erster Fit erwartet, werden verworfen.
        w0 = self._solve(x, y, sw, ridge)
        pred0 = x @ w0
        keep = ~((pred0 > 0.5) & (y < 0.35 * pred0))
        x, y, sw = x[keep], y[keep], sw[keep]
        w = self._solve(x, y, sw, ridge)
        pred = x @ w
        self.weights = [float(v) for v in w]
        self.cap_kw = float(np.nanmax(y) * 1.05) if len(y) else 0.0
        self.fitted_hours = int(len(y))
        self.rmse_kw = float(np.sqrt(np.mean((np.minimum(pred, self.cap_kw) - y) ** 2)))
        return self

    @staticmethod
    def _solve(x: np.ndarray, y: np.ndarray, sw: np.ndarray, ridge: float) -> np.ndarray:
        n = x.shape[1]
        root = np.sqrt(sw)
        # Ridge-Regularisierung als Zusatzzeilen -> stabil bei ähnlichen Flächen
        scale = ridge * np.sqrt(float(sw.sum())) * max(float(np.mean(x)), 1e-3)
        a = np.vstack([x * root[:, None], scale * np.eye(n)])
        b = np.concatenate([y * root, np.zeros(n)])
        return nnls(a, b)

    def predict(self, features: np.ndarray) -> np.ndarray:
        """Erwartete Leistung in kW je Stunde."""
        if not self.is_fitted or len(self.weights) != np.asarray(features).shape[1]:
            return np.zeros(len(features))
        pred = np.asarray(features, dtype=float) @ np.asarray(self.weights)
        if self.cap_kw > 0:
            pred = np.minimum(pred, self.cap_kw)
        return np.maximum(pred, 0.0)

    def describe(self) -> dict[str, float]:
        """Lesbare Übersicht der gelernten Flächen (nur relevante)."""
        names = {90.0: "Ost", 135.0: "Südost", 180.0: "Süd", 225.0: "Südwest", 270.0: "West"}
        out: dict[str, float] = {}
        for (tilt, az), w in zip(self.planes, self.high_sun_weights):
            if w < 0.05:
                continue
            if tilt == 0:
                label = "Flach"
            elif tilt >= 90:
                label = f"Wand {names.get(az, az)}"
            else:
                label = f"Dach {names.get(az, az)} {int(tilt)}°"
            out[label] = round(w, 2)
        low = self.weights[self._n_planes:]
        if low and self.total_kwp > 0:
            # Wie viel der Leistung bei tiefer Sonne noch ankommt (Verschattungsindikator)
            out["Tiefe Sonne (Anteil)"] = round(sum(low) / self.total_kwp, 2)
        return out

    def to_dict(self) -> dict:
        return {
            "weights": self.weights,
            "cap_kw": self.cap_kw,
            "fitted_hours": self.fitted_hours,
            "rmse_kw": self.rmse_kw,
            "planes": [list(p) for p in self.planes],
        }

    @classmethod
    def from_dict(cls, data: dict | None) -> "PVModel":
        if not data:
            return cls()
        return cls(
            weights=list(data.get("weights", [])),
            cap_kw=float(data.get("cap_kw", 0.0)),
            fitted_hours=int(data.get("fitted_hours", 0)),
            rmse_kw=float(data.get("rmse_kw", 0.0)),
            planes=[tuple(p) for p in data.get("planes", VIRTUAL_PLANES)],
        )
