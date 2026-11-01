"""Pack Grader server.

Reads charger AC current from the ESP32 over USB (one amps value per line,
about 50 per second), stores packs in SQLite, and predicts pack health from
the plug-in current curve by comparing it with a reference library and the
labeled packs (weighted nearest neighbours).

Run:  .venv/Scripts/python -m uvicorn main:app --port 8000
With no ESP32 connected it runs a simulator so the platform can be demoed.
"""

import hashlib
import json
import math
import os
import random
import sqlite3
import threading
import time
import uuid
from collections import deque
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

HERE = Path(__file__).parent
DB_PATH = HERE / "packs.db"
WEB_DIR = HERE.parent / "web"

RATE_HZ = 50                      # current values per second from the ESP32
CAPTURE_S = float(os.environ.get("CAPTURE_SECONDS", "30"))
PLUG_THRESHOLD_A = 0.3            # a jump above this counts as plug-in
WAIT_TIMEOUT_S = 120              # give up waiting for a plug-in after this
SERIAL_PORT = os.environ.get("SERIAL_PORT")  # e.g. COM5; auto-detected if unset
FORCE_SIM = os.environ.get("SIMULATE") == "1"

# The 21 sample times (seconds after plug-in), dense early, sparse later.
# Same idea as the paper's 21 voltage points, applied to current.
FEATURE_TIMES = [0.02, 0.04, 0.06, 0.1, 0.14, 0.2, 0.3, 0.4, 0.6, 0.8, 1,
                 1.5, 2, 3, 4, 6, 8, 12, 16, 22, 30]


def grade_for(health: float) -> str:
    if health >= 0.8:
        return "A"
    if health >= 0.6:
        return "B"
    return "Reject"


# ---------------------------------------------------------------- database

def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


with db() as con:
    con.execute("""
        CREATE TABLE IF NOT EXISTS packs (
            id TEXT PRIMARY KEY,
            model TEXT,
            rated_v REAL,
            rated_ah REAL,
            created REAL,
            updated REAL,
            status TEXT,          -- new | labeled | predicted
            health REAL,
            grade TEXT,
            kwh REAL,
            features TEXT,        -- JSON list of 21 values
            curve TEXT            -- JSON list, the full plug-in curve
        )""")


def pack_out(row) -> dict:
    d = dict(row)
    d["rated_kwh"] = round(d["rated_v"] * d["rated_ah"] / 1000, 3)
    d.pop("features", None)
    curve = json.loads(d.pop("curve") or "[]")
    d["curve"] = curve[::5]  # 10 points a second is plenty to draw
    return d


# ---------------------------------------------------------------- current source

class Source:
    """Feeds current values to listeners, from the ESP32 or a simulator."""

    def __init__(self):
        self.kind = "simulator"
        self.port = None
        self.listeners = []
        self.lock = threading.Lock()
        self.latest = 0.0
        self.recent = deque(maxlen=RATE_HZ * 10)  # last 10 s, for the live readout
        self.on_command = None  # set below; handles "CMD ..." lines from the ESP32
        # simulator state
        self.sim_health = None
        self.sim_t0 = None

    def subscribe(self):
        buf = []
        with self.lock:
            self.listeners.append(buf)
        return buf

    def unsubscribe(self, buf):
        with self.lock:
            if buf in self.listeners:
                self.listeners.remove(buf)

    def push(self, amps: float):
        self.latest = amps
        self.recent.append(amps)
        with self.lock:
            for buf in self.listeners:
                buf.append(amps)

    def start(self):
        port = None if FORCE_SIM else (SERIAL_PORT or self._find_port())
        if port:
            try:
                import serial
                # Keep DTR/RTS low so opening the port does not reset the ESP32.
                ser = serial.Serial()
                ser.port, ser.baudrate, ser.timeout = port, 115200, 1
                ser.dtr = ser.rts = False
                ser.open()
                self.kind, self.port = "esp32", port
                threading.Thread(target=self._read_serial, args=(ser,), daemon=True).start()
                return
            except Exception as exc:  # fall back to the simulator
                print(f"Could not open {port}: {exc}. Using the simulator.")
        threading.Thread(target=self._simulate, daemon=True).start()

    @staticmethod
    def _find_port():
        try:
            from serial.tools import list_ports
        except ImportError:
            return None
        for p in list_ports.comports():
            text = f"{p.description} {p.manufacturer or ''}".lower()
            if any(k in text for k in ("cp210", "ch340", "ch910", "usb serial", "uart", "esp32")):
                return p.device
        return None

    def _read_serial(self, ser):
        # Drop the first 2 s: boot text and stale buffered lines.
        settle = time.time() + 2
        while True:
            line = ser.readline().decode(errors="ignore").strip()
            if line.startswith("CMD") and time.time() >= settle and self.on_command:
                self.on_command(line)  # "CMD LABEL 0.85" or "CMD PREDICT"
                continue
            try:
                amps = float(line)
            except ValueError:
                continue  # skip lines such as "mid = 1650.0 mV"
            if time.time() < settle or not 0 <= amps < 100:
                continue
            self.push(amps)

    # The simulator draws a charger plug-in curve whose shape depends on a
    # hidden health: a worn pack steps higher and keeps rising for longer.
    def sim_plug(self, health):
        self.sim_health, self.sim_t0 = health, time.time()

    def sim_unplug(self):
        self.sim_health, self.sim_t0 = None, None

    def _simulate(self):
        period = 1 / RATE_HZ
        nxt = time.time()
        while True:
            if self.sim_t0 is None:
                amps = abs(random.gauss(0.01, 0.006))
            else:
                h = self.sim_health
                t = time.time() - self.sim_t0
                wear = 1 - h
                step = 1.55 + 0.9 * wear
                rise = 0.12 + 0.8 * wear
                tau = 3 + 14 * wear
                amps = step + rise * (1 - math.exp(-t / tau)) + random.gauss(0, 0.012)
            self.push(round(amps, 3))
            nxt += period
            time.sleep(max(0, nxt - time.time()))


source = Source()


def hidden_health(pack_id: str) -> float:
    """Simulator only: a stable made-up health per pack, 0.5 to 0.97."""
    h = int(hashlib.sha1(pack_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return round(0.5 + 0.47 * h, 3)


# ---------------------------------------------------------------- capture jobs

class Job:
    def __init__(self, pack_id):
        self.id = uuid.uuid4().hex[:10]
        self.pack_id = pack_id
        self.state = "waiting"      # waiting | capturing | done | failed
        self.values = []
        self.error = None


jobs: dict[str, Job] = {}
busy = threading.Lock()


def run_capture(job: Job):
    n_target = int(CAPTURE_S * RATE_HZ)
    buf = source.subscribe()
    try:
        if source.kind == "simulator":
            threading.Timer(1.2, source.sim_plug, args=(hidden_health(job.pack_id),)).start()
        start = time.time()
        seen = 0
        recent = []
        while job.state == "waiting":
            if time.time() - start > WAIT_TIMEOUT_S:
                job.state, job.error = "failed", "No plug-in seen. Plug the charger in and try again."
                return
            new = buf[seen:]
            seen += len(new)
            recent.extend(new)
            # Plug-in = 3 values in a row above the threshold after a quiet
            # baseline. One stray spike does not count.
            for i in range(10, len(recent) - 2):
                base = sum(recent[i - 10:i]) / 10
                if base < PLUG_THRESHOLD_A / 2 and min(recent[i:i + 3]) > PLUG_THRESHOLD_A:
                    job.values = recent[i:]
                    job.state = "capturing"
                    break
            else:
                del recent[:-12]  # keep enough history for the next check
            time.sleep(0.05)
        while len(job.values) < n_target:
            new = buf[seen:]
            seen += len(new)
            job.values.extend(new)
            time.sleep(0.05)
        job.values = job.values[:n_target]
        job.state = "done"
    finally:
        source.unsubscribe(buf)
        if source.kind == "simulator":
            source.sim_unplug()
        busy.release()


def features(curve: list[float]) -> list[float]:
    """21 values at fixed times after plug-in, each averaged over 5 samples."""
    arr = np.asarray(curve, dtype=float)
    scale = CAPTURE_S / 30
    out = []
    for t in FEATURE_TIMES:
        i = min(int(round(t * scale * RATE_HZ)), len(arr) - 1)
        lo, hi = max(i - 2, 0), min(i + 3, len(arr))
        out.append(float(arr[lo:hi].mean()))
    return out


# ---------------------------------------------------------------- prediction

# Reference library: example packs with known health that every prediction
# compares against, alongside the packs labeled here. These are SYNTHETIC,
# drawn from the same curve model as the demo ESP32 firmware, so they stand in
# for real labeled packs until those exist.

MODEL_NAME = "Nearest neighbours (k = 5)"
K = 5
N_REFERENCES = 24

with db() as con:
    con.execute("""
        CREATE TABLE IF NOT EXISTS reference (
            id TEXT PRIMARY KEY,
            health REAL,
            features TEXT
        )""")


def synthetic_curve(health: float, rng: np.random.Generator) -> list[float]:
    """Same formula as the firmware: a worn pack steps higher and rises longer."""
    t = np.arange(int(CAPTURE_S * RATE_HZ)) / RATE_HZ
    wear = 1 - health
    step = 1.55 + 0.9 * wear
    rise = 0.12 + 0.8 * wear
    tau = 3 + 14 * wear
    # Pack-to-pack spread, so references are not perfect copies of the formula.
    step *= rng.normal(1, 0.015)
    tau *= rng.normal(1, 0.05)
    return list(step + rise * (1 - np.exp(-t / tau)) + rng.normal(0, 0.012, t.size))


def seed_references():
    with db() as con:
        if con.execute("SELECT COUNT(*) FROM reference").fetchone()[0]:
            return
        rng = np.random.default_rng(7)
        healths = np.round(np.linspace(0.50, 0.97, N_REFERENCES) + rng.normal(0, 0.01, N_REFERENCES), 3)
        con.executemany(
            "INSERT INTO reference (id, health, features) VALUES (?,?,?)",
            [(f"REF-{i + 1:02d}", float(h), json.dumps(features(synthetic_curve(h, rng))))
             for i, h in enumerate(healths)])


def library(exclude: str | None = None) -> list[dict]:
    """Every example the model can compare against: references + labeled packs."""
    with db() as con:
        refs = con.execute("SELECT id, health, features FROM reference").fetchall()
        labs = con.execute(
            "SELECT id, health, features FROM packs WHERE status='labeled' AND id != ?",
            (exclude or "",)).fetchall()
    return ([{"id": r["id"], "health": r["health"], "x": json.loads(r["features"]), "kind": "reference"} for r in refs]
            + [{"id": r["id"], "health": r["health"], "x": json.loads(r["features"]), "kind": "label"} for r in labs])


def predict_health(x: list[float], lib: list[dict]) -> tuple[float, list[dict]]:
    """Average the health of the K closest curves, weighted by closeness.

    Returns the prediction and, for every library example, its similarity
    (0 to 1) and whether it was one of the K used, so the page can show it.
    """
    X = np.asarray([e["x"] for e in lib])
    y = np.asarray([e["health"] for e in lib])
    mu, sd = X.mean(0), X.std(0) + 1e-9
    d = np.linalg.norm((X - mu) / sd - (np.asarray(x) - mu) / sd, axis=1)
    k = min(K, len(y))
    idx = np.argsort(d)[:k]
    w = 1 / (d[idx] + 1e-6)
    health = float((w * y[idx]).sum() / w.sum())
    scale = d[idx[-1]] + 1e-9
    used = set(idx.tolist())
    out = [{"id": e["id"], "kind": e["kind"], "health": round(float(e["health"]), 3),
            "similarity": round(float(np.exp(-(d[i] / scale) ** 2)), 3), "used": i in used,
            "weight": round(float(w[list(idx).index(i)] / w.sum()), 3) if i in used else 0}
           for i, e in enumerate(lib)]
    return health, out


# ---------------------------------------------------------------- API

app = FastAPI(title="Pack Grader")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Lets a page on GitHub Pages (public HTTPS) call this laptop server.
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.on_event("startup")
def _start():
    source.start()
    seed_references()


class NewPack(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    model: str = Field(default="", max_length=60)
    rated_v: float = Field(gt=0)
    rated_ah: float = Field(gt=0)


class LabelIn(BaseModel):
    job_id: str
    kwh: float = Field(gt=0)


class PredictIn(BaseModel):
    job_id: str


@app.get("/api/status")
def status():
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM packs WHERE status='labeled'").fetchone()[0]
        refs = con.execute("SELECT COUNT(*) FROM reference").fetchone()[0]
    return {
        "server": True,
        "source": source.kind,
        "port": source.port,
        "model": MODEL_NAME,
        "labeled": n,
        "references": refs,
        "capture_seconds": CAPTURE_S,
        "amps": source.latest,
    }


@app.get("/api/live")
def live():
    """Latest current and the last 10 s (every 5th value) for the readout."""
    values = list(source.recent)[::5]
    return {"amps": source.latest, "values": values, "source": source.kind, "port": source.port}


@app.get("/api/packs")
def list_packs():
    with db() as con:
        rows = con.execute("SELECT * FROM packs ORDER BY created").fetchall()
    return [pack_out(r) for r in rows]


@app.post("/api/packs")
def add_pack(p: NewPack):
    pid = p.id.strip().upper()
    now = time.time()
    try:
        with db() as con:
            con.execute(
                "INSERT INTO packs (id, model, rated_v, rated_ah, created, updated, status) "
                "VALUES (?,?,?,?,?,?, 'new')",
                (pid, p.model.strip(), p.rated_v, p.rated_ah, now, now))
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"{pid} is already registered")
    return get_pack(pid)


@app.get("/api/packs/{pid}")
def get_pack(pid: str):
    with db() as con:
        row = con.execute("SELECT * FROM packs WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(404, "Pack not found")
    return pack_out(row)


@app.delete("/api/packs/{pid}")
def delete_pack(pid: str):
    with db() as con:
        con.execute("DELETE FROM packs WHERE id=?", (pid,))
    return {"deleted": pid}


@app.post("/api/packs/{pid}/capture")
def start_capture(pid: str):
    pack = get_pack(pid)
    if not busy.acquire(blocking=False):
        raise HTTPException(409, "A capture is already running")
    job = Job(pack["id"])
    jobs[job.id] = job
    threading.Thread(target=run_capture, args=(job,), daemon=True).start()
    return {"job_id": job.id}


@app.get("/api/capture/{job_id}")
def capture_state(job_id: str, since: int = 0):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Capture not found")
    out = {
        "state": job.state,
        "error": job.error,
        "count": len(job.values),
        "total": int(CAPTURE_S * RATE_HZ),
        "values": job.values[since:],
    }
    if job.state == "done" and source.kind == "simulator":
        pack = get_pack(job.pack_id)
        out["suggested_kwh"] = round(hidden_health(job.pack_id) * pack["rated_kwh"], 3)
    return out


def _finished_curve(job_id: str, pid: str) -> list[float]:
    job = jobs.get(job_id)
    if not job or job.pack_id != pid or job.state != "done":
        raise HTTPException(400, "Record a plug-in curve first")
    return job.values


@app.post("/api/packs/{pid}/label")
def label(pid: str, body: LabelIn):
    pack = get_pack(pid)
    curve = _finished_curve(body.job_id, pack["id"])
    health = min(body.kwh / pack["rated_kwh"], 1.2)
    with db() as con:
        con.execute(
            "UPDATE packs SET status='labeled', health=?, grade=?, kwh=?, features=?, curve=?, "
            "updated=? WHERE id=?",
            (health, grade_for(health), body.kwh, json.dumps(features(curve)),
             json.dumps(curve), time.time(), pack["id"]))
    return get_pack(pack["id"])


@app.post("/api/packs/{pid}/predict")
def predict(pid: str, body: PredictIn):
    pack = get_pack(pid)
    curve = _finished_curve(body.job_id, pack["id"])
    lib = library(exclude=pack["id"])
    if not lib:
        raise HTTPException(400, "No reference or labeled packs to compare with")
    health, matches = predict_health(features(curve), lib)
    health = float(np.clip(health, 0, 1.2))
    with db() as con:
        con.execute(
            "UPDATE packs SET status='predicted', health=?, grade=?, curve=?, updated=? WHERE id=?",
            (health, grade_for(health), json.dumps(curve), time.time(), pack["id"]))
    out = get_pack(pack["id"])
    out["model_used"] = MODEL_NAME
    out["labels_used"] = len(lib)
    out["library"] = matches
    return out


# ---------------------------------------------------------------- ESP32 commands
# The BOOT button on the ESP32 sends "CMD LABEL <health>" (long press) or
# "CMD PREDICT" (short press), then the plug-in curve. The server registers the
# next demo pack, records the curve, and labels or predicts it. The page
# follows along through /api/active.

DEMO_V, DEMO_AH = 60.0, 30.0
active = {"seq": 0}


def next_pack_id() -> str:
    with db() as con:
        ids = [r[0] for r in con.execute("SELECT id FROM packs")]
    nums = [int(i[2:]) for i in ids if i.startswith("P-") and i[2:].isdigit()]
    return f"P-{max(nums, default=0) + 1:02d}"


def run_command(line: str):
    parts = line.split()
    mode = parts[1].lower() if len(parts) > 1 else ""
    if mode not in ("label", "predict"):
        print(f"Unknown command: {line}")
        return
    try:
        true_health = float(parts[2]) if mode == "label" else None
    except (IndexError, ValueError):
        print(f"LABEL needs a health, e.g. CMD LABEL 0.85: {line}")
        return
    if not busy.acquire(blocking=False):
        print("Command ignored: a capture is already running")
        return
    pid = next_pack_id()
    add_pack(NewPack(id=pid, model="Demo pack", rated_v=DEMO_V, rated_ah=DEMO_AH))
    job = Job(pid)
    jobs[job.id] = job
    active.update(seq=active["seq"] + 1, job_id=job.id, pack_id=pid, mode=mode,
                  state="capturing", result=None, error=None)
    run_capture(job)  # blocks until the curve is in; releases `busy`
    try:
        if job.state != "done":
            raise HTTPException(400, job.error or "Capture failed")
        if mode == "label":
            kwh = true_health * DEMO_V * DEMO_AH / 1000
            result = label(pid, LabelIn(job_id=job.id, kwh=kwh))
        else:
            result = predict(pid, PredictIn(job_id=job.id))
        active.update(state="done", result=result)
    except HTTPException as exc:
        active.update(state="failed", error=exc.detail)


def on_command(line: str):
    threading.Thread(target=run_command, args=(line,), daemon=True).start()


source.on_command = on_command


class CommandIn(BaseModel):
    line: str = Field(pattern=r"^CMD (LABEL [0-9.]+|PREDICT)$")


@app.post("/api/command")
def command(body: CommandIn):
    """Same as the ESP32 sending a CMD line. Used for testing and as a backup."""
    on_command(body.line)
    return {"ok": True}


@app.get("/api/active")
def get_active():
    return active


# The web page, for running everything locally on one port.
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
