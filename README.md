# Hear Me Out: Interactive evaluation and bias discovery platform for speech-to-speech conversational AI

Try it live: https://testing-moshi--hearmeout-web-dev.modal.run/

**Hear Me Out** is an interactive evaluation and bias discovery platform for speech-to-speech conversational AI. These speech-to-speech models process spoken language directly from audio, without first converting it to text. They promise more natural, expressive, and emotionally aware interactions by retaining prosody, intonation, and other vocal cues throughout the conversation.

<img width="1648" alt="hearmeout-BD" src="https://github.com/user-attachments/assets/b282ad4a-354f-4452-ada2-59fafae65629" />

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Setup](#setup)
- [Running](#running)
- [Configuration](#configuration)
- [Deploying a change](#deploying-a-change)

## Features

**Hear Me Out** enables users to experience interactions with conversational models in ways that aren't typically accessible with regular benchmarking systems. Key features include:

- **Speech-to-Speech Models**: Users can choose from a variety of models that retain vocal cues like prosody and intonation.
- **Real-Time Voice Conversion**: Step into someone else’s voice – literally – and investigate how conversational AI systems interpret and respond to various speaker identities and expressions.
- **Side-by-Side Comparisons**: Ask a question with your own voice, then re-ask using a transformed voice. Compare the AI’s responses to observe differences in tone, phrasing, or behavior.
- **Insights Through Data**: Visualize metrics like speech rate, sentiment analysis, and more.

<img width="1381" alt="Screenshot 2025-03-31 at 13 19 18" src="https://github.com/user-attachments/assets/42c5cd60-0fe1-4e58-b198-ff12698e3b3a" />

Through this immersive experience, we hope users will gain insights into identity, voice, and AI behavior. Ultimately, we aim to surface meaningful questions and inspire future research that promotes fairness and inclusivity with **Hear Me Out**.


## Architecture

The backend is three services, set up and run entirely from this repo.

| Service | Port | Device | Role |
|---|---|---|---|
| **PersonaPlex** | 8000 | GPU | Audio-native speech↔speech LM (NVIDIA `personaplex` moshi fork). Ingests audio via the Mimi codec and responds in token space — no separate ASR. WebSocket `/api/chat` (binary tags: `0x00` handshake, `0x01` Opus audio, `0x02` transcript). |
| **app-api** | 5001 | GPU | FastAPI app — serves the built frontend + REST: `/api/transcribe` (faster-whisper), `/api/voice-conversion` (offline Seed-VC subprocess), `/api/metrics-comparison`. |
| **MeanVC** | 5002 | CPU | Real-time streaming voice conversion + the server-side chat-proxy that converts mic audio and forwards it to PersonaPlex over localhost. |

All run behind self-signed SSL (browser mic capture requires HTTPS), launched by `infra/run_all.sh`. On the production host they run inside a Docker container (`infra/docker_launch.sh`, reference only).

## Setup

`infra/setup.sh` is self-bootstrapping and interactive: it clones the repo (with the `seed-vc` submodule) + PersonaPlex (pinned commit) + MeanVC, builds the venv, installs pinned deps (`infra/requirements-frozen.txt`), downloads all models, generates SSL, and wires up the workspace. It shows a fixed-header progress UI and writes a full log to the directory you run it from.

```bash
export HF_TOKEN=hf_xxxxx   # access to gated nvidia/personaplex-7b-v1
curl -fsSL https://raw.githubusercontent.com/syedfahimabrar/Hear-Me-Out/main/infra/setup.sh -o setup.sh
bash setup.sh              # prompts for workspace (default: current dir), repo, token, etc.
```

- **Workspace** defaults to the current directory — `cd` into your target folder first, or set `WORKSPACE=/path`.
- **Non-interactive** (CI / `curl | bash`): pass `-y` and preset env, e.g. `HF_TOKEN=… WORKSPACE=/workspace bash setup.sh -y`.
- **Models-only** refresh on an existing setup: `bash setup.sh --models-only`.
- **Rootless container** (no sudo): answer **"Install system apt packages? → n"**.

## Running

```bash
cd <workspace> && bash Hear-Me-Out/infra/run_all.sh
# PersonaPlex :8000   app-api :5001   MeanVC :5002   (all SSL)
```

`run_all.sh` auto-detects the workspace from its own location; override with `WORKSPACE=…`. Set `FRONTEND_CHOICE=new|old` to skip the frontend prompt.

## Configuration

`src/app.py` and `infra/meanvc_server.py` are fully env-driven; `run_all.sh` derives these from `WORKSPACE` (`<ws>`):

| Env var | Default | Used by |
|---|---|---|
| `FRONTEND_PATH` | `<ws>/Hear-Me-Out/frontend/dist` | app-api (static) |
| `WHISPER_MODEL` | `small` | app-api transcription |
| `VC_CHECKPOINT_PATH` / `VC_MODEL_CONFIG` | seed-vc ckpt / config | app-api offline VC |
| `MEANVC_CKPT_DIR` | `<ws>/models/meanvc` | MeanVC |
| `MEANVC_SV_CKPT` | `<ws>/models/meanvc-sv/wavlm_large_finetune.pth` | MeanVC speaker verification |
| `SPEAKER_VERIFICATION_ROOT` | `<ws>` | MeanVC |
| `SSL_DIR` | `<ws>/ssl` | all (TLS) |
| `PERSONAPLEX_PROXY_HOST` / `PERSONAPLEX_PROXY_PORT` | `127.0.0.1` / `8000` | MeanVC chat-proxy → PersonaPlex |

## Deploying a change

Edit locally, commit, push — then on the server:

```bash
cd <workspace>/Hear-Me-Out && git pull
bash infra/build-frontend.sh     # only if the frontend changed
# restart the affected service (re-run run_all.sh, or restart app-api / MeanVC)
```

A frontend-only change needs a rebuild + hard refresh, no backend restart. A backend change (`src/app.py`, `infra/meanvc_server.py`, `tools/metrics.py`) needs the service restarted.

