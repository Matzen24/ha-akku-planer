# Akku-Planer

**Forecast based minimum-SoC control for home batteries in Home Assistant** · [Deutsch ↓](#deutsch)

Akku-Planer decides every 15 minutes how far your home battery may be discharged:

- **Sun will surely come back** (cautious P10 forecast): the battery may be used down to the *floor* (default 15 %).
- **Bad weather ahead**: the *backup reserve* (default 50 %) stays in the battery. If the battery is below it, it is recharged from the grid (optional).
- **Storm warning** (optional, e.g. DWD level ≥ 3): the reserve rises to 80 % and charging starts at once.
- **Grid loss**: nothing is changed.

The PV forecast **learns your panel orientations by itself** from your own measurements – east/west roofs, wall panels and shading included. No kWp, tilt or azimuth to enter. Weather data comes from [Open-Meteo](https://open-meteo.com) (free, no API key).

## Requirements
- Home Assistant 2025.1 or newer
- A battery state-of-charge sensor
- PV production with long-term statistics – ideally set up in the **Energy dashboard**
- For control: a *minimum SoC* setting of your inverter as a `number` entity (e.g. Victron ESS via `victron_mqtt`). Without one, Akku-Planer runs as a recommendation only.

## Installation (HACS)
1. HACS → ⋮ → *Custom repositories* → add `https://github.com/Matzen24/ha-akku-planer`, category *Integration*.
2. Install **Akku-Planer**, restart Home Assistant.
3. *Settings → Devices & services → Add integration → Akku-Planer*.

Setup reads your **Energy dashboard** and entity registry and pre-fills everything it finds:

| What | Where it comes from |
|---|---|
| PV sources | solar sources of the Energy dashboard (one model per source) |
| House consumption | calculated from the Energy dashboard (solar + grid import − export + battery out − in), or any sensor you choose |
| State of charge | battery sensor of your inverter |
| Capacity | Ah × V sensors (Victron) or a fixed kWh value |
| Control | Victron ESS is detected automatically; any other `number` / `input_number` can be selected |
| Live power for the cards | Energy dashboard, otherwise battery / grid / PV power sensors of your inverter. Without a total PV sensor the card adds up the PV sources; house consumption is calculated from PV, grid and battery |

You only fill in what is missing. Akku-Planer always starts in **Observe only** mode and writes nothing. Watch *Reason*, *Planned minimum SoC* and *Forecast accuracy* for a week or two, then switch the mode to *Automatic*.

### Control types
| Type | What is written |
|---|---|
| **Victron ESS** | ESS minimum SoC + charge schedule slot 1 for grid recharging |
| **Other inverter** | any minimum-SoC `number`; optionally a switch that forces grid charging |
| **Recommendation only** | nothing – use the sensors in your own automations |

Safety: the minimum SoC is changed in 5 % steps and at most 6 times a day (flash wear), except for storm warnings. Turning *Automatic* off stops a running grid charge.

## Dashboard
Right after setup an **Akku-Planer** page appears in the sidebar with all cards – no dashboard editing,
no resources, no entity ids. You can hide it in the integration options (*Show the Akku-Planer page in the sidebar*).

The integration also ships the five Lovelace cards for your own dashboards; they find their entities automatically:

```yaml
type: custom:akku-planer-card          # animated battery, energy flow, forecast
type: custom:akku-planer-control-card  # mode, automatic, draggable limits
type: custom:akku-planer-forecast-card # 4-day hourly forecast
type: custom:akku-planer-kpi-card      # key figures
type: custom:akku-planer-analysis-card # SoC history, forecast vs. actual, learned PV model
```
Card texts are German for now. Any entity can be overridden with `entities: {soc: sensor.x, ...}`.

## Entities
Planned minimum SoC (attributes: decision, grid charge, last action) · Reason · PV forecast tomorrow / rest of today / 4 days (P10/P50/P90, hourly) · Safe recharge · Consumption until recharge · Expected SoC at recharge · Forecast accuracy 7 days · Learned PV power · Grid charging · Storm reserve active · Automatic · Mode · Backup reserve · Floor when sunny · Storm reserve · Retrain models.

## How the forecast works
Hourly irradiance (GHI/DNI/DHI) from Open-Meteo is projected onto a set of virtual planes (all directions, flat to vertical). A non-negative least squares fit against your measured production of the last 45 days gives an "effective kWp" per plane; recent days count more, low sun is learned separately (winter shading). The model is trained on *day-ahead* weather forecasts, so forecast errors are part of what it learns. Ensemble data gives the P10/P90 band. Planning uses the cautious P10.

## Tests
```
pip install -r requirements_test.txt
python -m pytest tests
```

---

<a name="deutsch"></a>
## Deutsch

Der Akku-Planer entscheidet alle 15 Minuten, wie weit der Hausakku entladen werden darf:

- **Sonne kommt sicher** (vorsichtige P10-Prognose): Der Akku darf bis zur *Untergrenze* (Standard 15 %) genutzt werden.
- **Schlechtes Wetter**: Die *Notstrom-Reserve* (Standard 50 %) bleibt drin. Liegt der Akku darunter, wird auf Wunsch aus dem Netz nachgeladen.
- **Unwetterwarnung** (optional, z. B. DWD ab Stufe 3): Die Reserve steigt auf 80 %, es wird sofort nachgeladen.
- **Stromausfall**: Es wird nichts verstellt.

Die PV-Prognose **lernt die Ausrichtung deiner Module selbst** aus den Messwerten, auch für Ost/West, Wandmodule und Verschattung. kWp, Neigung oder Ausrichtung musst du nicht eintragen.

**Installation:** HACS → ⋮ → *Benutzerdefinierte Repositories* → `https://github.com/Matzen24/ha-akku-planer` als *Integration* hinzufügen → installieren → neu starten → *Einstellungen → Geräte & Dienste → Integration hinzufügen → Akku-Planer*.

Die Einrichtung liest das **Energie-Dashboard** und füllt alles vor, was sie findet: PV-Quellen, Hausverbrauch (berechnet), Akku-Ladestand, Victron-Steuerung. Du ergänzt nur, was fehlt. Der Planer startet immer im Modus **Nur beobachten** und schreibt nichts. Nach ein bis zwei Wochen stellst du auf *Automatisch nach Prognose*.

**Dashboard:** Nach der Einrichtung erscheint in der Seitenleiste die Seite **Akku-Planer** mit allen Karten – ohne Dashboard bearbeiten, ohne Ressourcen, ohne Entitäten eintragen. In den Optionen der Integration lässt sie sich ausblenden. Die fünf Karten kannst du zusätzlich in eigene Dashboards einbauen.

**Steuerarten:** *Victron ESS* (Mindest-SoC + Ladeplan 1), *Andere Anlage* (beliebige Mindest-SoC-Einstellung, optional ein Schalter fürs Netzladen) oder *Nur Empfehlung* (nur Sensoren für eigene Automationen).

## License
MIT
