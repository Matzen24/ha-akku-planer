"""Decision logic: how far may the battery be discharged? (plain Python, no Home Assistant)

Idea
----
* The backup reserve (e.g. 50 %) is the normal case.
* If the sun will refill the battery *for sure* (P10 forecast) before it is needed,
  the battery may be discharged down to the floor (e.g. 15 %) - the energy taken
  from the reserve reliably comes back.
* Partial refill -> continuously in between.
* Storm warning -> higher reserve, charge immediately.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

from .const import (
    GRID_CHARGE_MARGIN,
    MIN_SOC_STEP,
    MODE_AUTO,
    MODE_FULL,
    MODE_OBSERVE,
    MODE_RESERVE,
)

CHARGE_EFF = 0.95
DISCHARGE_EFF = 0.95
SURPLUS_THRESHOLD_KWH = 0.05

WEEKDAYS = {
    "de": ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"],
    "en": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
}
WEEKDAYS_DE = WEEKDAYS["de"]  # backwards compatibility

TEXTS = {
    "de": {
        "storm": "Unwetterwarnung aktiv -> Reserve {t} % halten und nachladen",
        "reserve": "Modus 'Immer Reserve' -> {t} %",
        "full": "Modus 'Voll nutzen' -> bis {t} %",
        "bad": "Keine Akku-Nachladung in Sicht (P10) -> Notstromreserve {r} % halten",
        "sunny": "Ab {when} sicher {kwh} kWh Überschuss -> Akku darf bis {f} % genutzt werden",
        "partial": "Ab {when} nur {kwh} kWh sicherer Überschuss -> Mindest-SoC {t} %",
        "grid": "; Netz lädt {kwh} kWh nach (~{h} h)",
        "observe": "[Schattenbetrieb] ",
        "today": "Heute",
        "tomorrow": "Morgen",
        "soc_unknown": "SoC unbekannt – keine Steuerung. ",
        "grid_loss": "Netzausfall erkannt – keine Änderungen",
        "set_min_soc": "{time} Mindest-SoC {a} → {b} %",
        "charge_on": "{time} Netzladung bis {t} % gestartet",
        "charge_off": "{time} Netzladung beendet",
        "no_control": "Nur Empfehlung – Steuerung ist nicht eingerichtet",
    },
    "en": {
        "storm": "Storm warning active -> keep {t} % reserve and recharge",
        "reserve": "Mode 'always keep reserve' -> {t} %",
        "full": "Mode 'use full battery' -> down to {t} %",
        "bad": "No recharge in sight (P10) -> keep {r} % backup reserve",
        "sunny": "From {when} a safe surplus of {kwh} kWh -> battery may be used down to {f} %",
        "partial": "From {when} only {kwh} kWh safe surplus -> minimum SoC {t} %",
        "grid": "; grid recharges {kwh} kWh (~{h} h)",
        "observe": "[Observe only] ",
        "today": "Today",
        "tomorrow": "Tomorrow",
        "soc_unknown": "SoC unknown – no control. ",
        "grid_loss": "Grid loss detected – no changes",
        "set_min_soc": "{time} minimum SoC {a} → {b} %",
        "charge_on": "{time} grid charging to {t} % started",
        "charge_off": "{time} grid charging finished",
        "no_control": "Recommendation only – no control configured",
    },
}


def lang_of(language: str | None) -> str:
    return "de" if (language or "").lower().startswith("de") else "en"


def text(lang: str, key: str, **kw) -> str:
    return TEXTS[lang_of(lang)][key].format(**kw)


def weekday(lang: str, idx: int) -> str:
    return WEEKDAYS[lang_of(lang)][idx]


def _num(v: float, lang: str, d: int = 1) -> str:
    s = f"{v:.{d}f}"
    return s.replace(".", ",") if lang_of(lang) == "de" else s


@dataclass
class PlanInput:
    hours: list[datetime]          # start of each hour (local); [0] = current hour
    pv_p10_kwh: list[float]        # cautious PV forecast per hour
    pv_p50_kwh: list[float]        # likely PV forecast per hour
    load_kwh: list[float]          # consumption forecast per hour
    soc: float                     # current SoC in %
    capacity_kwh: float
    reserve: float                 # % backup reserve for bad weather
    floor: float                   # % lowest limit (sun will come for sure)
    storm_reserve: float           # % with storm warning
    storm_active: bool = False
    mode: str = MODE_AUTO
    charge_power_kw: float = 3.0
    lang: str = "de"


@dataclass
class Plan:
    target_min_soc: float
    grid_charge: bool = False
    charge_target_soc: float = 0.0
    charge_hours: int = 0
    charge_start_index: int | None = None
    refill_start: datetime | None = None
    refill_end: datetime | None = None
    refill_kwh_p10: float = 0.0
    refill_kwh_p50: float = 0.0
    drain_kwh: float = 0.0
    soc_at_refill: float | None = None
    soc_trajectory: list[float] = field(default_factory=list)
    decision: str = ""
    reason: str = ""


def _round_up(value: float, step: int = MIN_SOC_STEP) -> float:
    return float(math.ceil(value / step - 1e-9) * step)


def find_refill_window(net: list[float]) -> tuple[int | None, int | None]:
    """First period in which PV permanently exceeds consumption."""
    n = len(net)
    start = None
    for i in range(n):
        nxt_ok = i + 1 >= n or net[i + 1] > SURPLUS_THRESHOLD_KWH
        if net[i] > SURPLUS_THRESHOLD_KWH and nxt_ok:
            start = i
            break
    if start is None:
        return None, None
    end = n
    for j in range(start + 1, n):
        nxt_neg = j + 1 >= n or net[j + 1] <= 0
        if net[j] <= 0 and nxt_neg:
            end = j
            break
    return start, end


def simulate(soc: float, net: list[float], cap: float, floor: float) -> list[float]:
    """SoC course in % (end of each hour); the battery is not discharged below floor."""
    out = []
    s = soc
    for e in net:
        if e >= 0:
            s += e * CHARGE_EFF / cap * 100.0
        else:
            s += e / DISCHARGE_EFF / cap * 100.0
        s = min(100.0, max(floor, s))
        out.append(round(s, 1))
    return out


def make_plan(inp: PlanInput) -> Plan:
    lang = lang_of(inp.lang)
    cap = max(inp.capacity_kwh, 0.1)
    floor = max(0.0, min(inp.floor, 100.0))
    reserve = max(floor, min(inp.reserve, 100.0))
    net10 = [p - l for p, l in zip(inp.pv_p10_kwh, inp.load_kwh)]
    net50 = [p - l for p, l in zip(inp.pv_p50_kwh, inp.load_kwh)]

    start, end = find_refill_window(net10)
    refill10 = refill50 = drain = 0.0
    if start is not None:
        refill10 = max(0.0, sum(net10[start:end]))
        refill50 = max(0.0, sum(net50[start:end]))
        drain = max(0.0, -sum(net10[:start]))
    else:
        drain = max(0.0, -sum(net10))
    refill_pct = refill10 * CHARGE_EFF / cap * 100.0

    # --- target minimum SoC ---
    if inp.storm_active and inp.mode != MODE_FULL:
        target = max(reserve, inp.storm_reserve)
        decision = "unwetter"
        reason = text(lang, "storm", t=f"{target:.0f}")
    elif inp.mode == MODE_RESERVE:
        target = reserve
        decision = "reserve_fest"
        reason = text(lang, "reserve", t=f"{target:.0f}")
    elif inp.mode == MODE_FULL:
        target = floor
        decision = "voll_fest"
        reason = text(lang, "full", t=f"{target:.0f}")
    else:  # auto / observe
        if start is None:
            target = reserve
            decision = "schlecht"
            reason = text(lang, "bad", r=f"{reserve:.0f}")
        else:
            target = max(floor, reserve - refill_pct)
            when = (
                f"{weekday(lang, inp.hours[start].weekday())[:2]} {inp.hours[start]:%H:%M}"
                if start < len(inp.hours) else "?"
            )
            if target <= floor + 1e-6:
                decision = "sonnig"
                reason = text(lang, "sunny", when=when, kwh=_num(refill10, lang), f=f"{floor:.0f}")
            else:
                decision = "teilweise"
                reason = text(lang, "partial", when=when, kwh=_num(refill10, lang), t=f"{_round_up(target):.0f}")
    target = min(100.0, _round_up(target))
    # After rounding up the full reserve is needed after all -> name it that way
    if decision == "teilweise" and target >= _round_up(reserve):
        decision = "schlecht"

    plan = Plan(
        target_min_soc=target,
        refill_start=inp.hours[start] if start is not None and start < len(inp.hours) else None,
        refill_end=inp.hours[end - 1] if start is not None and end and end - 1 < len(inp.hours) else None,
        refill_kwh_p10=round(refill10, 2),
        refill_kwh_p50=round(refill50, 2),
        drain_kwh=round(drain, 2),
        decision=decision,
        reason=reason,
    )

    traj = simulate(inp.soc, net10, cap, min(target, inp.soc))
    plan.soc_trajectory = traj
    if start is not None and start > 0:
        plan.soc_at_refill = traj[start - 1]
    elif start == 0:
        plan.soc_at_refill = round(inp.soc, 1)

    # --- grid recharge ---
    if inp.mode != MODE_FULL and inp.soc < target - GRID_CHARGE_MARGIN:
        deficit_kwh = (target - inp.soc) / 100.0 * cap / CHARGE_EFF
        # If the sun comes within the next hours and covers the deficit (P50),
        # nothing is charged from the grid.
        pv_soon = start is not None and start <= 2 and refill50 * CHARGE_EFF >= deficit_kwh
        if not pv_soon or inp.storm_active:
            plan.grid_charge = True
            plan.charge_target_soc = target
            plan.charge_hours = max(1, math.ceil(deficit_kwh / max(inp.charge_power_kw, 0.5) + 0.25))
            plan.charge_start_index = 0
            plan.reason += text(lang, "grid", kwh=_num(deficit_kwh, lang), h=plan.charge_hours)

    if inp.mode == MODE_OBSERVE:
        plan.reason = text(lang, "observe") + plan.reason
    return plan
