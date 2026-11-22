from datetime import datetime, timedelta, timezone

import numpy as np

from custom_components.akku_planer.load_model import LoadModel
from custom_components.akku_planer.pv_model import PVModel, nnls
from custom_components.akku_planer.solar import VIRTUAL_PLANES, plane_features, sun_position

LAT, LON = 52.5, 13.4  # Berlin


def test_sun_position_summer_noon():
    t = datetime(2026, 6, 21, 11, 8, tzinfo=timezone.utc).timestamp()
    zen, az = sun_position(np.array([t]), LAT, LON)
    assert abs(zen[0] - (LAT - 23.44)) < 1.0
    assert abs(az[0] - 180) < 3


def test_sun_position_morning_east_and_night():
    morning = datetime(2026, 6, 21, 4, 0, tzinfo=timezone.utc).timestamp()
    night = datetime(2026, 12, 21, 22, 0, tzinfo=timezone.utc).timestamp()
    zen, az = sun_position(np.array([morning, night]), LAT, LON)
    assert 45 < az[0] < 100      # morgens im Nordosten/Osten
    assert zen[1] > 90           # nachts unter dem Horizont


def test_nnls_matches_known_solution():
    rng = np.random.default_rng(1)
    a = rng.random((200, 5))
    x_true = np.array([2.0, 0.0, 1.5, 0.0, 0.7])
    b = a @ x_true
    x = nnls(a, b)
    assert np.allclose(x, x_true, atol=1e-6)


def test_nnls_never_negative():
    rng = np.random.default_rng(2)
    a = rng.random((100, 4))
    b = a @ np.array([1.0, -2.0, 0.5, 0.0]) + 3
    assert (nnls(a, b) >= 0).all()


def _synthetic_weather(days=40, start=datetime(2026, 4, 1, tzinfo=timezone.utc)):
    ts = np.array([(start + timedelta(hours=h)).timestamp() for h in range(days * 24)])
    zen, _ = sun_position(ts - 1800, LAT, LON)
    cosz = np.clip(np.cos(np.radians(zen)), 0, None)
    rng = np.random.default_rng(3)
    clear = 1000 * cosz
    cloudiness = np.repeat(rng.uniform(0.1, 1.0, days), 24)
    ghi = clear * cloudiness
    dni = np.where(cosz > 0.05, 900 * cloudiness ** 2, 0)
    dhi = np.clip(ghi - dni * cosz, 0, None)
    temp = np.full_like(ghi, 15.0)
    return ts, ghi, dni, dhi, temp


def test_pv_model_learns_orientation():
    ts, ghi, dni, dhi, temp = _synthetic_weather()
    plain = plane_features(ts, LAT, LON, ghi, dni, dhi, temp, low_sun_deg=None)
    feats = plane_features(ts, LAT, LON, ghi, dni, dhi, temp)
    assert feats.shape[1] == 2 * plain.shape[1]
    # "Wahre" Anlage: 8 kWp Ost 30°, 4 kWp Wand Süd
    true_w = np.zeros(len(VIRTUAL_PLANES))
    true_w[VIRTUAL_PLANES.index((30.0, 90.0))] = 8.0
    true_w[VIRTUAL_PLANES.index((90.0, 180.0))] = 4.0
    y = plain @ true_w
    age = np.arange(len(y))[::-1] / 24.0
    model = PVModel().fit(feats, y, ridge=0.001, sample_weight=0.5 ** (age / 10))
    assert model.is_fitted
    assert abs(model.total_kwp - 12.0) < 1.0
    pred = model.predict(feats)
    daily_true = y.reshape(-1, 24).sum(axis=1)
    daily_pred = pred.reshape(-1, 24).sum(axis=1)
    assert np.mean(np.abs(daily_pred - daily_true) / np.maximum(daily_true, 1)) < 0.05


def test_pv_model_roundtrip():
    m = PVModel(weights=[1.0] * (2 * len(VIRTUAL_PLANES)), cap_kw=5, fitted_hours=100)
    assert m.total_kwp == len(VIRTUAL_PLANES)
    assert "Tiefe Sonne (Anteil)" in m.describe()
    m2 = PVModel.from_dict(m.to_dict())
    assert m2.weights == m.weights and m2.cap_kw == 5


def test_load_model_profile_and_json_safe():
    start = datetime(2026, 11, 1)
    times = [start + timedelta(hours=h) for h in range(21 * 24)]
    vals = [2.0 if t.hour == 18 else 0.5 for t in times]
    lm = LoadModel().fit(times, vals)
    assert abs(lm.predict_kw(datetime(2026, 11, 25, 18)) - 2.0) < 1e-6
    assert abs(lm.predict_kw(datetime(2026, 11, 25, 3)) - 0.5) < 1e-6
    import json
    json.dumps(lm.to_dict())  # kein NaN
    assert LoadModel.from_dict(lm.to_dict()).predict_kw(datetime(2026, 11, 25, 18)) == lm.predict_kw(
        datetime(2026, 11, 25, 18)
    )
