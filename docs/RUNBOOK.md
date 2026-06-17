# Hear-Me-Out — Runbook (set up & run from git)

The git repo is the single source of truth. A fresh backend in any folder is one clone + one
script. See `docs/ARCHITECTURE.md` for what the services are.

## Prerequisites
- Ubuntu 22.04 + NVIDIA GPU (CUDA 12.1), Python 3.11.
- A Hugging Face token with access to the gated `nvidia/personaplex-7b-v1`
  (accept the license at https://huggingface.co/nvidia/personaplex-7b-v1).

## Fresh setup into any workspace folder
`infra/setup.sh` is self-bootstrapping and `WORKSPACE`-parameterized — curl it and run; set
`WORKSPACE` to stand up a parallel, independent environment (e.g. `/home/jovyan/workspace`).

```bash
export HF_TOKEN=hf_xxx
curl -fsSL https://raw.githubusercontent.com/syedfahimabrar/Hear-Me-Out/main/infra/setup.sh -o setup.sh
WORKSPACE=/home/jovyan/workspace bash setup.sh
```
This installs system packages, creates the venv (`$WORKSPACE/hearmeout-venv`), clones the repo
(with the `seed-vc` submodule) + PersonaPlex (pinned commit) + MeanVC, installs deps (from
`infra/requirements-frozen.txt` if committed, else the curated list, then freezes), downloads
all models, copies the speaker-verification module, generates SSL, and deploys
`personaplex_entry.py` + `run_all.sh`. Override the source with `REPO_URL=...` if needed.

Models only (deps/venv already present):
```bash
WORKSPACE=/workspace2 HF_TOKEN=hf_xxx bash infra/setup.sh --models-only
```

## Run
```bash
WORKSPACE=/workspace2 bash $WORKSPACE/Hear-Me-Out/infra/run_all.sh
# PersonaPlex :8000   app-api :5001   MeanVC :5002   (all SSL)
```
`FRONTEND_CHOICE=new|old` skips the interactive prompt. The script auto-builds the Vite frontend
if `frontend/dist` is missing.

## Deploy a code change (existing workspace)
**Never edit files under the live workspace directly — go through git.**
```bash
# local: commit + push
cd $WORKSPACE/Hear-Me-Out && git pull
bash infra/build-frontend.sh        # only if frontend changed (reinstalls deps if package*.json changed)
# restart the relevant service (re-run run_all.sh, or restart just app-api/MeanVC)
```
- Frontend-only change → rebuild + hard-refresh, no backend restart.
- Backend (`src/app.py`, `infra/meanvc_server.py`, `tools/metrics.py`) → restart the service.

## Dependency notes
- `tools/metrics.py` needs `pyphen` + `audiobox_aesthetics` (both in `setup.sh`). Missing `pyphen`
  500s the Metrics tab; missing `audiobox_aesthetics` falls back to mock aesthetic scores.
- `audiobox_aesthetics` requires `safetensors>=0.5.3`, which violates moshi's *declared* `<0.5`
  pin — cosmetic; the load API/format is stable and PersonaPlex runs fine on 0.8.
- `infra/requirements-frozen.txt` is the committed lockfile. Regenerate with
  `pip freeze > infra/requirements-frozen.txt` from the working venv and commit when deps change.

## Acceptance test (full from-git reproducibility)
1. `WORKSPACE=/workspace2 HF_TOKEN=… bash infra/setup.sh` completes with no manual steps.
2. `WORKSPACE=/workspace2 bash …/run_all.sh` → all three ports up under `/workspace2`.
3. `/api/health` OK; a non-VC conversation; a VC conversation (target upload → chat-proxy); the
   Metrics tab shows **real** aesthetics; the chat voice-change modal works.
4. `git -C /workspace/personaplex rev-parse HEAD` == `PERSONAPLEX_COMMIT` and the tree is clean
   (the fork is reproduced by clone, not locally modified).

## Prod cleanup (manual, one-time)
- Delete stray `/workspace/can_you_see_this.txt`.
- Old root `/workspace/run_all.sh` (no-SSL) is superseded by `infra/run_all.sh` (which `setup.sh`
  redeploys); drop it.
- Leave `read.sh` / `write.sh` / `mcp.shc` — those are the prodserver MCP filesystem bridge,
  not application code; do not vendor them into the repo.
