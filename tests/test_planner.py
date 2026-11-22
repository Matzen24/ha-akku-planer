from datetime import datetime, timedelta

from custom_components.akku_planer.const import MODE_AUTO, MODE_FULL, MODE_OBSERVE, MODE_RESERVE
from custom_components.akku_planer.planner import PlanInput, find_refill_window, make_plan

CAP = 20.0


def _day_curve(peak_kwh: float) -> list[float]:
    """Einfache Tageskurve 8–16 Uhr."""
    curve = [0.0] * 24
    for h, f in zip(range(8, 17), [0.2, 0.5, 0.8, 1.0, 1.0, 0.9, 0.7, 0.4, 0.1]):
        curve[h] = peak_kwh * f
    return curve


def _inp(pv_tomorrow_peak: float, soc: float = 60, start_hour: int = 18, mode=MODE_AUTO, storm=False,
         pv_today_peak: float = 0.0):
    start = datetime(2026, 11, 19, start_hour)
    hours = [start + timedelta(hours=k) for k in range(48)]
    today = _day_curve(pv_today_peak)
    tomorrow = _day_curve(pv_tomorrow_peak)
    pv = []
    for h in hours:
        curve = today if h.date() == start.date() else tomorrow if h.date() == start.date() + timedelta(days=1) else [0] * 24
        pv.append(curve[h.hour])
    load = [1.0] * 48
    return PlanInput(hours=hours, pv_p10_kwh=pv, pv_p50_kwh=[p * 1.2 for p in pv], load_kwh=load, soc=soc,
                     capacity_kwh=CAP, reserve=50, floor=14, storm_reserve=80, storm_active=storm, mode=mode)


def test_sunny_tomorrow_allows_full_use():
    plan = make_plan(_inp(pv_tomorrow_peak=8.0))
    assert plan.decision == "sonnig"
    assert plan.target_min_soc == 15  # Boden 14 % -> auf 5er-Schritt aufgerundet
    assert not plan.grid_charge
    assert plan.refill_start.hour in (8, 9)


def test_bad_weather_keeps_reserve_and_grid_charges_when_low():
    plan = make_plan(_inp(pv_tomorrow_peak=0.5, soc=20))
    assert plan.decision == "schlecht"
    assert plan.target_min_soc == 50
    assert plan.grid_charge and plan.charge_target_soc == 50
    assert plan.charge_hours >= 2


def test_bad_weather_no_grid_charge_if_soc_already_above_reserve():
    plan = make_plan(_inp(pv_tomorrow_peak=0.5, soc=70))
    assert plan.target_min_soc == 50
    assert not plan.grid_charge


def test_partial_sun_interpolates():
    plan = make_plan(_inp(pv_tomorrow_peak=2.0))
    assert plan.decision == "teilweise"
    assert 15 < plan.target_min_soc < 50


def test_tiny_refill_rounded_to_reserve_is_labeled_bad():
    plan = make_plan(_inp(pv_tomorrow_peak=1.25))
    assert plan.target_min_soc == 50
    assert plan.decision == "schlecht"


def test_storm_overrides_sun():
    plan = make_plan(_inp(pv_tomorrow_peak=8.0, soc=40, storm=True))
    assert plan.decision == "unwetter"
    assert plan.target_min_soc == 80
    assert plan.grid_charge


def test_modes():
    assert make_plan(_inp(0.5, mode=MODE_FULL)).target_min_soc == 15
    assert make_plan(_inp(8.0, mode=MODE_RESERVE)).target_min_soc == 50
    assert make_plan(_inp(8.0, mode=MODE_OBSERVE)).reason.startswith("[Schattenbetrieb]")


def test_no_grid_charge_when_sun_is_about_to_refill():
    # Morgens 7 Uhr, SoC unter Reserve, aber in 1–2 h kommt viel Sonne
    plan = make_plan(_inp(pv_tomorrow_peak=0, pv_today_peak=8.0, soc=30, start_hour=7))
    assert plan.decision == "sonnig"
    assert not plan.grid_charge


def test_refill_window_detection():
    assert find_refill_window([-1, -1, 0.5, 1, 1, -0.5, -1]) == (2, 5)
    assert find_refill_window([-1, -1, -1]) == (None, None)
    # einzelne Ausreißerstunde zählt nicht
    assert find_refill_window([-1, 0.3, -1, -1]) == (None, None)
