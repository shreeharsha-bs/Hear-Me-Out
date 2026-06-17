# Hear-Me-Out — Backend Architecture

A speech-to-speech evaluation and bias-discovery platform (KTH). The backend is three
services plus a React/Vite frontend, all driven from this git repo and a parameterized
workspace folder.

## Services

| Service | Port | Device | Entry | Role |
|---|---|---|---|---|
| **PersonaPlex** | 8000 | GPU | `personaplex_entry.py` → `moshi.server.main` | Audio-native speech↔speech LM (NVIDIA `personaplex` moshi fork). |
| **app-api** | 5001 | GPU | `uvicorn src.app:create_app --factory` | Application backend: serves the built frontend + REST. *(formerly "vc-api")* |
| **MeanVC** | 5002 | CPU | `infra/meanvc_server.py` (aiohttp) | Real-time **streaming** voice conversion + the PersonaPlex chat-proxy. |

All three are launched by **`infra/run_all.sh`** and front a self-signed SSL cert (browser
mic capture requires HTTPS).

### PersonaPlex (8000)
The conversational model. There is **no separate ASR** — it ingests audio, encodes it with the
Mimi neural codec into discrete tokens, and the transformer LM responds directly in token space
(its `0x02` text stream is the model's own inner-monologue, not a transcript of the user). Single
global `asyncio.Lock` → **one conversation at a time**.

WebSocket `/api/chat`; binary protocol tags: `0x00` handshake, `0x01` Opus audio, `0x02`
transcript text.

### app-api (5001) — two kinds of "VC" live here vs MeanVC
The general FastAPI backend. Serves `frontend/dist` and these REST endpoints:
- `GET /api/health`
- `POST /api/transcribe` — faster-whisper (CUDA, with CPU OOM fallback). Long-audio safe.
- `POST /api/voice-conversion` — **offline** VC via the **Seed-VC** subprocess (`seed-vc/inference.py`). Powers the **Convert** tab.
- `POST /api/metrics-comparison` — `tools/metrics.py`; `?output=json` returns metrics (radar/cards), default returns a PNG. Powers the **Metrics** tab + chat **voice-change** modal.
- `GET /recordings/{file}`

So app-api's VC is **Seed-VC, offline, file→file**. MeanVC (5002) is the **streaming** engine for
live conversation. They are different models for different jobs, not duplicates.

### MeanVC (5002)
Lightweight single-step streaming VC (16 kHz internal, ~200 ms chunks). Endpoints:
- `POST /api/meanvc/load-target` — register a target voice (speaker embedding + prompt mel).
- `GET /api/meanvc/stream` (WS) — browser-mediated VC (legacy/fallback).
- `GET /api/meanvc/chat-proxy` (WS) — **server-side bridge**: receives raw mic PCM, converts each
  chunk, resamples 16k→24k, Opus-encodes (1920-sample frames), and forwards to PersonaPlex over
  localhost. Relays PersonaPlex's `0x00/0x01/0x02` back to the browser, plus the converted user
  PCM tagged `0x03` (for downloads + the live monitor). Eliminates the browser round-trip.

> Note: the released MeanVC checkpoint's content encoder is Chinese-oriented, so English
> intelligibility is weaker — relevant when interpreting Convert-tab vs streaming quality.

## Data path with VC on (Chat tab)
```
mic PCM ─▶ MeanVC chat-proxy(5002) ─convert→24k→Opus→localhost─▶ PersonaPlex(8000)
                  │                                                    │
                  └─ 0x03 converted PCM ─▶ browser (monitor/downloads) └─ 0x00/0x01/0x02 relayed ─▶ browser
```

## Configuration (all env-driven — no hardcoded paths in app code)

`src/app.py` and `infra/meanvc_server.py` read everything from env; `infra/run_all.sh` sets them
from `WORKSPACE` (default `/workspace`, override for any folder):

| Env var | Set to | Used by |
|---|---|---|
| `FRONTEND_PATH` | `$WORKSPACE/Hear-Me-Out/frontend/dist` | app-api (static) |
| `WHISPER_MODEL` | `small` (default) | app-api transcription |
| `VC_CHECKPOINT_PATH` / `VC_MODEL_CONFIG` | seed-vc ckpt / config | app-api offline VC |
| `MEANVC_CKPT_DIR` | `$WORKSPACE/models/meanvc` | MeanVC |
| `MEANVC_SV_CKPT` | `$WORKSPACE/models/meanvc-sv/wavlm_large_finetune.pth` | MeanVC speaker verification |
| `SPEAKER_VERIFICATION_ROOT` | `$WORKSPACE` | MeanVC (`src.runtime.speaker_verification`) |
| `SSL_DIR` | `$WORKSPACE/ssl` | all (TLS) |
| `PERSONAPLEX_PROXY_HOST/PORT` | `127.0.0.1` / `8000` | MeanVC chat-proxy → PersonaPlex |

## Production runtime
On the GPU host the stack runs inside a Docker container (`hearmeout:v2`), with the host dir
`/home/shbs/hear_me_out` mounted as `/workspace`. See `infra/docker_launch.sh` (reference only).

## Shared-GPU constraint
PersonaPlex 7B, seed-vc, faster-whisper, and the metrics models all share **one** GPU. Heavy
post-conversation work (diarization transcription + voice-change metrics) is **serialized** and
`/api/transcribe` has a **CPU OOM fallback** to avoid CUDA out-of-memory. If you add load
(longer convos, concurrency, or a GPU streaming VC like X-VC), give the analysis/VC stages their
own GPU or move them to CPU.
