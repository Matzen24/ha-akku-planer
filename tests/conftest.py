"""Erlaubt das Testen der reinen Rechenmodule ohne installierte Home-Assistant-Pakete."""

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG_DIR = ROOT / "custom_components" / "akku_planer"

# Paket-Stubs anlegen, damit __init__.py (importiert homeassistant) nicht ausgeführt wird
for name, path in (("custom_components", ROOT / "custom_components"), ("custom_components.akku_planer", PKG_DIR)):
    if name not in sys.modules:
        mod = types.ModuleType(name)
        mod.__path__ = [str(path)]
        sys.modules[name] = mod
