#!/bin/bash
# ============================================================================
# Hear-Me-Out: setup for a fresh Ubuntu 22.04 GPU server (uv per-service).
# Stands up PersonaPlex, app-api, MeanVC (+ optional X-VC) under a workspace,
# each as its own uv project (own venv/Python/torch).
#
# Interactive:  bash infra/setup.sh
# Non-interactive / CI / curl | bash:
#               HF_TOKEN=hf_xxx WORKSPACE=/workspace bash infra/setup.sh -y
# Models-only (existing setup): bash infra/setup.sh --models-only
# Include X-VC engine:          bash infra/setup.sh --xvc
#
# All prompts have defaults (env vars override them); no TTY => uses defaults.
# ============================================================================
set -eo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
log()  { echo -e "${GREEN}[setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; exit 1; }
hr()   { echo -e "${DIM}────────────────────────────────────────────────────${NC}"; }

# ---------------------------------------------------------------------------
# Args + interactive config
# ---------------------------------------------------------------------------
MODELS_ONLY=false
NONINTERACTIVE="${NONINTERACTIVE:-0}"
INSTALL_SYSTEM=true
INSTALL_XVC="${INSTALL_XVC:-false}"
for a in "$@"; do
  case "$a" in
    --models-only)            MODELS_ONLY=true ;;
    --xvc)                    INSTALL_XVC=true ;;
    -y|--yes|--non-interactive) NONINTERACTIVE=1 ;;
    -h|--help) echo "Usage: setup.sh [--models-only] [--xvc] [-y|--yes]"; exit 0 ;;
    *) warn "Unknown arg: $a" ;;
  esac
done
[ -t 0 ] || NONINTERACTIVE=1   # no TTY -> non-interactive

# ask VAR "Prompt" "default"  — text input with shown default
ask() {
  local __var="$1" __prompt="$2" __cur __reply; __cur="${!__var:-$3}"
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "$__cur"; return; fi
  read -r -p "$(printf "${CYAN}?${NC} ${BOLD}%s${NC} ${DIM}[%s]${NC} " "$__prompt" "$__cur")" __reply
  printf -v "$__var" '%s' "${__reply:-$__cur}"
}
# ask_secret VAR "Prompt"  — hidden input, keeps existing if blank
ask_secret() {
  local __var="$1" __prompt="$2" __cur __reply; __cur="${!__var:-}"
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "$__cur"; return; fi
  local __hint="(blank to skip)"; [ -n "$__cur" ] && __hint="(enter to keep existing)"
  read -r -s -p "$(printf "${CYAN}?${NC} ${BOLD}%s${NC} ${DIM}%s${NC} " "$__prompt" "$__hint")" __reply; echo
  printf -v "$__var" '%s' "${__reply:-$__cur}"
}
# ask_yn VAR "Prompt" "Y|N"  — yes/no, sets VAR to true/false
ask_yn() {
  local __var="$1" __prompt="$2" __def="$3" __reply __hint
  [ "${__def^^}" = "Y" ] && __hint="Y/n" || __hint="y/N"
  if [ "$NONINTERACTIVE" = "1" ]; then
    [ "${__def^^}" = "Y" ] && printf -v "$__var" 'true' || printf -v "$__var" 'false'; return
  fi
  read -r -p "$(printf "${CYAN}?${NC} ${BOLD}%s${NC} ${DIM}[%s]${NC} " "$__prompt" "$__hint")" __reply
  case "${__reply:-$__def}" in [Yy]*) printf -v "$__var" 'true' ;; *) printf -v "$__var" 'false' ;; esac
}

echo
echo -e "${BOLD}╭──────────────────────────────────────────────╮${NC}"
echo -e "${BOLD}│        Hear-Me-Out — backend setup           │${NC}"
echo -e "${BOLD}╰──────────────────────────────────────────────╯${NC}"
[ "$NONINTERACTIVE" = "1" ] && log "Non-interactive: using defaults / env values." || echo -e "${DIM}Press Enter to accept the [default].${NC}"
echo

# Workspace defaults to the current directory — cd into your target folder first.
WORKSPACE="${WORKSPACE:-$(pwd)}"
REPO_URL="${REPO_URL:-https://github.com/syedfahimabrar/Hear-Me-Out.git}"

ask        WORKSPACE "Workspace directory" "$WORKSPACE"
ask        REPO_URL  "Git repo URL"        "$REPO_URL"
ask_secret HF_TOKEN  "Hugging Face token (gated PersonaPlex model)"
if ! $MODELS_ONLY; then
  ask_yn   MODELS_ONLY    "Models-only? (skip system/clones/deps)"      "N"
fi
if ! $MODELS_ONLY; then
  ask_yn   INSTALL_SYSTEM "Install system apt packages? (needs sudo)"   "Y"
fi
if ! $MODELS_ONLY; then
  ask_yn   INSTALL_XVC    "Also install the X-VC engine? (own venv, GPU)" "N"
fi

# Fixed upstreams (not prompted)
MEANVC_URL="https://github.com/ASLP-lab/MeanVC.git"   # cloned for its speaker_verification source
XVC_URL="https://github.com/Jerrister/X-VC.git"
XVC_COMMIT="49df8c591eafc48b096e466d96f9839f9c0dd739"

# Derived paths. Export so helper scripts (generate-ssl.sh, download-meanvc-sv.sh)
# and `uv run` downloads honor the chosen workspace.
export WORKSPACE
export HF_TOKEN
# Progress bars (tqdm / hf_hub / hf_transfer) can't render in the captured-output
# pane — they just "shiver". Disable them; the step spinner shows liveness instead.
export HF_HUB_DISABLE_PROGRESS_BARS=1
export TQDM_DISABLE=1
REPO_DIR="$WORKSPACE/Hear-Me-Out"
MODELS_DIR="$WORKSPACE/models"
MEANVC_DIR="$WORKSPACE/MeanVC"
XVC_DIR="$WORKSPACE/X-VC"
SERVICES="$REPO_DIR/services"

echo; hr
echo -e "  ${BOLD}Workspace${NC}    : $WORKSPACE"
echo -e "  ${BOLD}Repo${NC}         : $REPO_URL"
echo -e "  ${BOLD}HF token${NC}     : $([ -n "$HF_TOKEN" ] && echo set || echo "${YELLOW}not set — PersonaPlex model will be skipped${NC}")"
echo -e "  ${BOLD}Models-only${NC}  : $MODELS_ONLY"
$MODELS_ONLY || echo -e "  ${BOLD}System pkgs${NC}  : $INSTALL_SYSTEM"
$MODELS_ONLY || echo -e "  ${BOLD}X-VC engine${NC}  : $INSTALL_XVC"
hr
if [ "$NONINTERACTIVE" != "1" ]; then
  read -r -p "$(printf "${CYAN}?${NC} ${BOLD}Proceed?${NC} ${DIM}[Y/n]${NC} ")" __go
  case "${__go:-Y}" in [Yy]*) ;; *) err "Aborted by user." ;; esac
fi

$MODELS_ONLY && [ ! -d "$SERVICES/app_api/.venv" ] && err "services not synced (run full setup first)."

# ===========================================================================
# Phase functions. Each is self-contained (no shared venv); they run as
# backgrounded steps under the TUI. Per-service deps come from `uv sync`.
# ===========================================================================
phase_system() {
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends \
      build-essential pkg-config git wget curl ca-certificates \
      ffmpeg libsndfile1 libopus-dev libsoxr-dev openssl nodejs npm
}

phase_workspace() {
  if mkdir -p "$WORKSPACE" 2>/dev/null; then :
  elif $INSTALL_SYSTEM; then sudo mkdir -p "$WORKSPACE" && sudo chown -R "$(whoami)" "$WORKSPACE"
  else echo "ERROR: cannot create $WORKSPACE without sudo"; return 1; fi
  mkdir -p "$MODELS_DIR"/{seed-vc,meanvc,meanvc-sv}
}

phase_clone() {
  # Hear-Me-Out (with the seed-vc submodule).
  [ -d "$REPO_DIR" ] && echo "Hear-Me-Out exists" || git clone --recursive "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" submodule update --init --recursive 2>/dev/null || true
  # MeanVC — cloned only for its speaker_verification source (copied in phase_runtime).
  [ -d "$MEANVC_DIR" ] && echo "MeanVC exists" || git clone "$MEANVC_URL" "$MEANVC_DIR"
  # X-VC — cloned + run from source by services/xvc/server.py (added to sys.path).
  if $INSTALL_XVC; then
    [ -d "$XVC_DIR" ] && echo "X-VC exists" || git clone "$XVC_URL" "$XVC_DIR"
    ( cd "$XVC_DIR" && git checkout "$XVC_COMMIT" 2>/dev/null || true )
    mkdir -p "$XVC_DIR/ckpts" "$XVC_DIR/pretrained"
  fi
  # PersonaPlex's moshi is NOT cloned — services/personaplex pulls it via uv git source.
}

phase_sync() {
  # Each service resolves into its own venv (uv picks the right Python + torch).
  echo "uv sync: app_api ..."      ; ( cd "$SERVICES/app_api"     && uv sync )
  echo "uv sync: meanvc ..."       ; ( cd "$SERVICES/meanvc"      && uv sync )
  echo "uv sync: personaplex (pulls moshi from git) ..." ; ( cd "$SERVICES/personaplex" && uv sync )
  if $INSTALL_XVC; then
    echo "uv sync: xvc (py3.10, torch 2.5.1) ..." ; ( cd "$SERVICES/xvc" && uv sync )
  fi
}

phase_models() {
  local APP="uv run --project $SERVICES/app_api python"
  if [ -n "$HF_TOKEN" ]; then
    echo "Downloading PersonaPlex-7B model (10-20 min)..."
    $APP -c "from huggingface_hub import snapshot_download, hf_hub_download; snapshot_download('nvidia/personaplex-7b-v1'); hf_hub_download('nvidia/personaplex-7b-v1','voices.tgz'); print('PersonaPlex model ready.')"
  else
    echo "WARN: HF_TOKEN not set — skipping gated PersonaPlex model."
  fi
  local SEEDVC_CKPT="$MODELS_DIR/seed-vc/DiT_uvit_tat_xlsr_ema.pth"
  if [ ! -f "$SEEDVC_CKPT" ]; then
    echo "Downloading Seed-VC checkpoint..."
    $APP -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copy(hf_hub_download('Plachta/Seed-VC','DiT_uvit_tat_xlsr_ema.pth'),'$SEEDVC_CKPT'); print('Seed-VC checkpoint ready.')"
  else echo "Seed-VC checkpoint present."; fi
  local model
  for model in meanvc_200ms.pt fastu2++.pt model_200ms.safetensors vocos.pt; do
    if [ ! -f "$MODELS_DIR/meanvc/$model" ]; then
      echo "Downloading MeanVC: $model..."
      $APP -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copy(hf_hub_download('ASLP-lab/MeanVC','$model'),'$MODELS_DIR/meanvc/$model')"
    fi
  done
  echo "MeanVC checkpoints ready."
  uv run --project "$SERVICES/app_api" bash "$REPO_DIR/infra/download-meanvc-sv.sh" \
    || echo "WARN: SV model download failed; place wavlm_large_finetune.pth in $MODELS_DIR/meanvc-sv/ manually."

  if $INSTALL_XVC; then
    local XVCP="uv run --project $SERVICES/xvc python"
    [ -f "$XVC_DIR/ckpts/xvc.pt" ] || { echo "Downloading X-VC checkpoint..."; \
      $XVCP -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copy(hf_hub_download('chenxie95/X-VC','xvc.pt'),'$XVC_DIR/ckpts/xvc.pt'); print('xvc.pt ready')"; }
    $XVCP -c "from huggingface_hub import snapshot_download; snapshot_download('zai-org/glm-4-voice-tokenizer'); print('glm tokenizer cached')" \
      || echo "WARN: glm tokenizer pre-cache failed (fetched at runtime)."
    local ERES="$XVC_DIR/pretrained/speech_eres2net_sv_en_voxceleb_16k"
    if [ ! -d "$ERES" ] || [ -z "$(ls -A "$ERES" 2>/dev/null)" ]; then
      echo "Downloading ERes2Net speaker encoder (modelscope)..."
      $XVCP -c "
import os, shutil
from modelscope import snapshot_download
p = snapshot_download('iic/speech_eres2net_sv_en_voxceleb_16k')
os.makedirs('$ERES', exist_ok=True)
for n in os.listdir(p):
    s = os.path.join(p, n); d = os.path.join('$ERES', n)
    (shutil.copytree(s, d, dirs_exist_ok=True) if os.path.isdir(s) else shutil.copy(s, d))
print('ERes2Net ready')" || echo "WARN: ERes2Net download failed; place it at $ERES manually."
    fi
  fi
}

phase_runtime() {
  if ! $MODELS_ONLY; then
    # MeanVC runtime imports src.runtime.speaker_verification (SPEAKER_VERIFICATION_ROOT=$WORKSPACE).
    mkdir -p "$WORKSPACE/src/runtime/speaker_verification"
    cp "$MEANVC_DIR/src/runtime/speaker_verification/"*.py \
       "$WORKSPACE/src/runtime/speaker_verification/" 2>/dev/null || true
    touch "$WORKSPACE/src/__init__.py" "$WORKSPACE/src/runtime/__init__.py"
  fi
  bash "$REPO_DIR/infra/generate-ssl.sh" || true
}

# ===========================================================================
# Build the ordered step list from the chosen options.
# ===========================================================================
STEP_FNS=(); STEP_LABELS=(); STEP_STATE=()
add_step() { STEP_FNS+=("$1"); STEP_LABELS+=("$2"); STEP_STATE+=("pending"); }
if ! $MODELS_ONLY; then
  $INSTALL_SYSTEM && add_step phase_system "Install system packages"
  add_step phase_workspace "Create workspace"
  add_step phase_clone     "Clone repos + submodules"
  add_step phase_sync      "Resolve per-service deps (uv sync)"
fi
add_step phase_models  "Download models"
add_step phase_runtime "Runtime setup (SSL, speaker-verification)"

# ===========================================================================
# Renderer + runner. TUI = fixed header + in-place checklist; otherwise plain.
# ===========================================================================
TUI=0
[ "$NONINTERACTIVE" != "1" ] && [ -t 1 ] && command -v tput >/dev/null 2>&1 && TUI=1
INVOKE_DIR="$(pwd)"
SETUP_LOG="$INVOKE_DIR/hmo-setup-$(date +%Y%m%d-%H%M%S).log"
: > "$SETUP_LOG" 2>/dev/null || SETUP_LOG="$(mktemp "${TMPDIR:-/tmp}/hmo-setup.XXXXXX.log")"
PANE_LINES=8
SPIN_CH=""; RENDERED=0

print_header() {
  echo -e "${BOLD}╭──────────────────────────────────────────────╮${NC}"
  echo -e "${BOLD}│        Hear-Me-Out — installing backend      │${NC}"
  echo -e "${BOLD}╰──────────────────────────────────────────────╯${NC}"
  echo -e "  ${DIM}workspace${NC}  $WORKSPACE"
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo -e "  ${DIM}gpu${NC}        $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  fi
  echo -e "  ${DIM}log${NC}        $SETUP_LOG"
  echo
}

render() {  # redraw checklist + an N-line scrolling output pane, in place (TUI only)
  local i icon cols j n line; local -a paneln
  cols=$(tput cols 2>/dev/null || echo 80)
  [ "$RENDERED" = "1" ] && tput cuu $(( ${#STEP_FNS[@]} + 1 + PANE_LINES ))
  RENDERED=1
  for i in "${!STEP_FNS[@]}"; do
    case "${STEP_STATE[$i]}" in
      pending) icon="${DIM}○${NC}" ;;
      run)     icon="${CYAN}${SPIN_CH:-•}${NC}" ;;
      ok)      icon="${GREEN}✓${NC}" ;;
      fail)    icon="${RED}✗${NC}" ;;
    esac
    tput el; echo -e "  $icon ${STEP_LABELS[$i]}"
  done
  tput el; echo -e "  ${DIM}┄┄ output ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${NC}"
  mapfile -t paneln < <(tail -n "$PANE_LINES" "$SETUP_LOG" 2>/dev/null | tr -d '\r')
  n=${#paneln[@]}
  for (( j=0; j<PANE_LINES; j++ )); do
    tput el
    if [ "$j" -lt "$n" ]; then
      line="$(printf '%s' "${paneln[$j]}" | tr -dc '[:print:]\t')"
      echo -e "    ${DIM}${line:0:$((cols-6))}${NC}"
    else
      echo
    fi
  done
}

run_tui() {
  tput clear; print_header
  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null || true' EXIT
  local i pid rc s spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  for i in "${!STEP_FNS[@]}"; do
    STEP_STATE[$i]="run"
    ( set -e; "${STEP_FNS[$i]}" ) >>"$SETUP_LOG" 2>&1 &
    pid=$!; s=0
    while kill -0 "$pid" 2>/dev/null; do
      SPIN_CH="${spin:$((s % 10)):1}"; s=$((s + 1))
      render; sleep 0.1
    done
    rc=0; wait "$pid" || rc=$?
    [ "$rc" = "0" ] && STEP_STATE[$i]="ok" || STEP_STATE[$i]="fail"
    SPIN_CH=""; render
    if [ "$rc" != "0" ]; then
      tput cnorm 2>/dev/null || true
      echo; echo -e "${RED}✗ Failed: ${STEP_LABELS[$i]}${NC}  ${DIM}(last 25 log lines)${NC}"
      tail -n 25 "$SETUP_LOG"
      echo -e "${DIM}Full log: $SETUP_LOG${NC}"
      exit 1
    fi
  done
  tput cnorm 2>/dev/null || true
}

run_plain() {
  print_header
  local i
  for i in "${!STEP_FNS[@]}"; do
    log "[$((i + 1))/${#STEP_FNS[@]}] ${STEP_LABELS[$i]}"
    "${STEP_FNS[$i]}" 2>&1 | tee -a "$SETUP_LOG" || err "Failed: ${STEP_LABELS[$i]} (see $SETUP_LOG)"
  done
}

# Prime sudo before the TUI hides output, so any password prompt is visible now.
if ! $MODELS_ONLY && $INSTALL_SYSTEM; then sudo -v 2>/dev/null || true; fi

# Ensure uv is available (in the main shell, so every step subshell inherits it).
if ! command -v uv >/dev/null 2>&1; then
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
command -v uv >/dev/null 2>&1 || err "uv not found on PATH after install."

echo
if [ "$TUI" = "1" ]; then run_tui; else run_plain; fi

echo
echo -e "${GREEN}✓ Setup complete!${NC}"
echo -e "  ${BOLD}workspace${NC}  $WORKSPACE"
echo -e "  ${BOLD}deps${NC}       per-service uv envs under services/*/.venv"
echo -e "  ${BOLD}start${NC}      bash $REPO_DIR/infra/run_all.sh"
echo -e "  ${BOLD}ports${NC}      PersonaPlex :8000   app-api :5001   MeanVC/X-VC :5002"
echo -e "  ${BOLD}log${NC}        $SETUP_LOG"
[ -n "$HF_TOKEN" ] || echo -e "  ${YELLOW}note${NC}       HF_TOKEN was not set — rerun with a token to fetch PersonaPlex."
echo
