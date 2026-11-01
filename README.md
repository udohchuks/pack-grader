# Pack Grader

Grade used e-motorcycle battery packs from the charger's plug-in current.
An SCT-013 clamp on the charger's AC cable feeds an ESP32; the ESP32 prints one
current value (amps) per line, about 50 per second, over USB.

- `web/` — the page (GitHub Pages). Register packs, label them, predict health.
- `server/` — FastAPI on the laptop. Reads the ESP32, stores packs in `packs.db`,
  predicts health with TabPFN (nearest neighbours until TabPFN is set up).

## Run locally

```bash
cd server
uv venv .venv --python 3.11
uv pip install --python .venv/Scripts/python.exe fastapi "uvicorn[standard]" pyserial numpy tabpfn
.venv/Scripts/python.exe -m uvicorn main:app --port 8000
```

Open http://localhost:8000. With no ESP32 plugged in, the server runs a simulator.

Settings (environment variables): `SERIAL_PORT=COM5` to pick the port,
`SIMULATE=1` to force the simulator, `CAPTURE_SECONDS=30` for the curve length,
`TABPFN_TOKEN=...` to enable TabPFN (accept its license at Prior Labs first).

## GitHub Pages

Publish the `web/` folder. The page then calls `http://localhost:8000`; click the
status pill in the top right to change the address. Chrome may ask to allow
access to your local network once.
