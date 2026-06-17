#!/bin/bash
# ============================================================================
# Hear-Me-Out: setup for a fresh Ubuntu 22.04 GPU server
# Stands up all services (PersonaPlex, app-api, MeanVC) under a workspace folder.
#
# Interactive:  bash infra/setup.sh            # prompts for workspace, repo, HF token, etc.
# Non-interactive / CI / curl | bash:
#               HF_TOKEN=hf_xxx WORKSPACE=/workspace bash infra/setup.sh -y
# Models-only (existing setup): bash infra/setup.sh --models-only
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
#   Flags: --models-only   (skip system/venv/repo/deps, just download models)
#          -y | --yes      (non-interactive: accept all defaults / env vars)
#   Any value can be preset via env (WORKSPACE=, REPO_URL=, HF_TOKEN=) and is
#   shown as the default. With no TTY (e.g. curl | bash) prompts are skipped.
# ---------------------------------------------------------------------------
MODELS_ONLY=false
NONINTERACTIVE="${NONINTERACTIVE:-0}"
INSTALL_SYSTEM=true
for a in "$@"; do
  case "$a" in
    --models-only)            MODELS_ONLY=true ;;
    -y|--yes|--non-interactive) NONINTERACTIVE=1 ;;
    -h|--help) echo "Usage: setup.sh [--models-only] [-y|--yes]"; exit 0 ;;
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

# Defaults (overridable via env), then prompt for each.
# Workspace defaults to the current directory — cd into your target folder first.
WORKSPACE="${WORKSPACE:-$(pwd)}"
REPO_URL="${REPO_URL:-https://github.com/syedfahimabrar/Hear-Me-Out.git}"

ask        WORKSPACE "Workspace directory" "$WORKSPACE"
ask        REPO_URL  "Git repo URL"        "$REPO_URL"
ask_secret HF_TOKEN  "Hugging Face token (gated PersonaPlex model)"
if ! $MODELS_ONLY; then
  ask_yn   MODELS_ONLY    "Models-only? (skip system/venv/repo/deps)"  "N"
fi
if ! $MODELS_ONLY; then
  ask_yn   INSTALL_SYSTEM "Install system apt packages? (needs sudo)"  "Y"
fi

# Fixed upstreams (not prompted)
PERSONAPLEX_URL="https://github.com/NVIDIA/personaplex.git"
MEANVC_URL="https://github.com/ASLP-lab/MeanVC.git"
PERSONAPLEX_COMMIT="3428dfd95309a7f3c84fd93259ded0f810d1ff91"

# Derived paths (after WORKSPACE is finalized). Export so the helper scripts
# (generate-ssl.sh, download-meanvc-sv.sh) honor the chosen workspace.
export WORKSPACE
export HF_TOKEN
REPO_DIR="$WORKSPACE/Hear-Me-Out"
VENV_DIR="$WORKSPACE/hearmeout-venv"
MODELS_DIR="$WORKSPACE/models"
PERSONAPLEX_DIR="$WORKSPACE/personaplex"
MEANVC_DIR="$WORKSPACE/MeanVC"
FROZEN="$REPO_DIR/infra/requirements-frozen.txt"

echo; hr
echo -e "  ${BOLD}Workspace${NC}    : $WORKSPACE"
echo -e "  ${BOLD}Repo${NC}         : $REPO_URL"
echo -e "  ${BOLD}HF token${NC}     : $([ -n "$HF_TOKEN" ] && echo set || echo "${YELLOW}not set — PersonaPlex model will be skipped${NC}")"
echo -e "  ${BOLD}Models-only${NC}  : $MODELS_ONLY"
$MODELS_ONLY || echo -e "  ${BOLD}System pkgs${NC}  : $INSTALL_SYSTEM"
hr
if [ "$NONINTERACTIVE" != "1" ]; then
  read -r -p "$(printf "${CYAN}?${NC} ${BOLD}Proceed?${NC} ${DIM}[Y/n]${NC} ")" __go
  case "${__go:-Y}" in [Yy]*) ;; *) err "Aborted by user." ;; esac
fi

$MODELS_ONLY && [ ! -f "$VENV_DIR/bin/activate" ] && err "venv not found at $VENV_DIR (run full setup first)."

# ===========================================================================
# Phase functions. Each is self-contained and re-activates the venv so it can
# run as a backgrounded step under the TUI without losing the environment.
# ===========================================================================
_venv() { [ -f "$VENV_DIR/bin/activate" ] && source "$VENV_DIR/bin/activate"; }

phase_system() {
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends \
      build-essential pkg-config git wget curl ca-certificates \
      python3 python3-dev python3-pip python3-venv \
      ffmpeg libsndfile1 libopus-dev libsoxr-dev openssl nodejs npm
}

phase_workspace() {
  if mkdir -p "$WORKSPACE" 2>/dev/null; then :
  elif $INSTALL_SYSTEM; then sudo mkdir -p "$WORKSPACE" && sudo chown -R "$(whoami)" "$WORKSPACE"
  else echo "ERROR: cannot create $WORKSPACE without sudo"; return 1; fi
  mkdir -p "$MODELS_DIR"/{seed-vc,meanvc,meanvc-sv}
}

phase_venv() {
  python3 -m venv "$VENV_DIR"
  source "$VENV_DIR/bin/activate"
  pip install --upgrade pip -q
  echo "Installing PyTorch 2.4.0 (cu121)..."
  pip install --no-cache-dir torch==2.4.0 torchaudio==2.4.0 \
      --index-url https://download.pytorch.org/whl/cu121
}

phase_clone() {
  _venv
  [ -d "$REPO_DIR" ] && echo "Hear-Me-Out exists" || git clone --recursive "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" submodule update --init --recursive 2>/dev/null || true
  if [ ! -d "$PERSONAPLEX_DIR" ]; then
    echo "Cloning PersonaPlex (NVIDIA)..."
    git clone "$PERSONAPLEX_URL" "$PERSONAPLEX_DIR"
    ( cd "$PERSONAPLEX_DIR" && git checkout "$PERSONAPLEX_COMMIT" )
  fi
  echo "Installing moshi (editable) from PersonaPlex..."
  pip install --no-cache-dir -e "$PERSONAPLEX_DIR/moshi"
  [ -d "$MEANVC_DIR" ] && echo "MeanVC exists" || git clone "$MEANVC_URL" "$MEANVC_DIR"
}

phase_deps() {
  _venv
  if [ -f "$FROZEN" ]; then
    echo "Installing pinned deps from infra/requirements-frozen.txt..."
    pip install --no-cache-dir -r "$FROZEN"
  else
    echo "Installing curated dependency set..."
    # safetensors>=0.5.3 is required by audiobox_aesthetics; moshi *declares* <0.5
    # but that's cosmetic (load API/format stable 0.4-0.8). pyphen + audiobox power
    # tools/metrics.py (Metrics tab + voice-change modal).
    pip install --no-cache-dir \
        numpy==1.26.4 scipy==1.13.1 einops==0.7.0 \
        "safetensors>=0.5.3" sentencepiece==0.2.0 \
        sounddevice==0.5.0 soundfile==0.12.1 "sphn>=0.1.4" \
        "huggingface-hub>=0.34" "hf-transfer>=0.1.8" \
        transformers sentence-transformers==3.3.1 accelerate \
        librosa==0.10.2 pydub==0.25.1 munch==4.0.0 \
        descript-audio-codec==1.0.0 bigvgan silero-vad \
        fastapi==0.115.5 "uvicorn[standard]==0.32.0" \
        python-multipart==0.0.18 starlette websockets \
        "aiohttp>=3.10" omegaconf matplotlib pyphen audiobox_aesthetics werkzeug gdown
    echo "Installing seed-vc dependencies..."
    pip install --no-cache-dir -r "$REPO_DIR/seed-vc/requirements.txt" || true
    pip freeze > "$FROZEN"
    echo "Lockfile written to infra/requirements-frozen.txt (commit it to pin versions)."
  fi
}

phase_models() {
  _venv
  if [ -n "$HF_TOKEN" ]; then
    echo "Downloading PersonaPlex-7B model (10-20 min)..."
    python3 -c "from huggingface_hub import snapshot_download, hf_hub_download; snapshot_download('nvidia/personaplex-7b-v1'); hf_hub_download('nvidia/personaplex-7b-v1','voices.tgz'); print('PersonaPlex model ready.')"
  else
    echo "WARN: HF_TOKEN not set — skipping gated PersonaPlex model."
    echo "      Accept license at https://huggingface.co/nvidia/personaplex-7b-v1 then rerun with a token."
  fi
  local SEEDVC_CKPT="$MODELS_DIR/seed-vc/DiT_uvit_tat_xlsr_ema.pth"
  if [ ! -f "$SEEDVC_CKPT" ]; then
    echo "Downloading Seed-VC checkpoint..."
    python3 -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copy(hf_hub_download('Plachta/Seed-VC','DiT_uvit_tat_xlsr_ema.pth'),'$SEEDVC_CKPT'); print('Seed-VC checkpoint ready.')"
  else echo "Seed-VC checkpoint present."; fi
  local model
  for model in meanvc_200ms.pt fastu2++.pt model_200ms.safetensors vocos.pt; do
    if [ ! -f "$MODELS_DIR/meanvc/$model" ]; then
      echo "Downloading MeanVC: $model..."
      python3 -c "from huggingface_hub import hf_hub_download; import shutil; shutil.copy(hf_hub_download('ASLP-lab/MeanVC','$model'),'$MODELS_DIR/meanvc/$model')"
    fi
  done
  echo "MeanVC checkpoints ready."
  bash "$REPO_DIR/infra/download-meanvc-sv.sh" || echo "WARN: SV model download failed; place wavlm_large_finetune.pth in $MODELS_DIR/meanvc-sv/ manually."
}

phase_runtime() {
  if ! $MODELS_ONLY; then
    mkdir -p "$WORKSPACE/src/runtime/speaker_verification"
    cp "$MEANVC_DIR/src/runtime/speaker_verification/"*.py \
       "$WORKSPACE/src/runtime/speaker_verification/" 2>/dev/null || true
    touch "$WORKSPACE/src/__init__.py" "$WORKSPACE/src/runtime/__init__.py"
  fi
  bash "$REPO_DIR/infra/generate-ssl.sh" || true
  cp "$REPO_DIR/infra/personaplex_entrypoint.py" "$WORKSPACE/personaplex_entry.py"; chmod +x "$WORKSPACE/personaplex_entry.py"
  cp "$REPO_DIR/infra/run_all.sh" "$WORKSPACE/run_all.sh"; chmod +x "$WORKSPACE/run_all.sh"
}

# ===========================================================================
# Build the ordered step list (label + function) from the chosen options.
# ===========================================================================
STEP_FNS=(); STEP_LABELS=(); STEP_STATE=()
add_step() { STEP_FNS+=("$1"); STEP_LABELS+=("$2"); STEP_STATE+=("pending"); }
if ! $MODELS_ONLY; then
  $INSTALL_SYSTEM && add_step phase_system "Install system packages"
  add_step phase_workspace "Create workspace"
  add_step phase_venv      "Python venv + PyTorch (cu121)"
  add_step phase_clone     "Clone repos + install moshi"
  add_step phase_deps      "Install Python dependencies"
fi
add_step phase_models  "Download models"
add_step phase_runtime "Runtime setup (SSL, entrypoints)"

# ===========================================================================
# Renderer + runner. TUI = fixed header + in-place checklist; otherwise plain.
# ===========================================================================
TUI=0
[ "$NONINTERACTIVE" != "1" ] && [ -t 1 ] && command -v tput >/dev/null 2>&1 && TUI=1
SETUP_LOG="$(mktemp "${TMPDIR:-/tmp}/hmo-setup.XXXXXX.log")"
SPIN_CH=""; LIVE_LINE=""; RENDERED=0

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

render() {  # redraw the checklist + live line in place (TUI only)
  local i icon cols; cols=$(tput cols 2>/dev/null || echo 80)
  [ "$RENDERED" = "1" ] && tput cuu $(( ${#STEP_FNS[@]} + 2 ))
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
  tput el; echo
  tput el; echo -e "    ${DIM}${LIVE_LINE:0:$((cols-6))}${NC}"
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
      LIVE_LINE="$(tail -n1 "$SETUP_LOG" 2>/dev/null | tr -d '\r' | tr -dc '[:print:]' || true)"
      render; sleep 0.1
    done
    rc=0; wait "$pid" || rc=$?
    [ "$rc" = "0" ] && STEP_STATE[$i]="ok" || STEP_STATE[$i]="fail"
    SPIN_CH=""; LIVE_LINE=""; render
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

echo
if [ "$TUI" = "1" ]; then run_tui; else run_plain; fi

echo
echo -e "${GREEN}✓ Setup complete!${NC}"
echo -e "  ${BOLD}workspace${NC}  $WORKSPACE"
echo -e "  ${BOLD}venv${NC}       $VENV_DIR"
echo -e "  ${BOLD}start${NC}      cd $WORKSPACE && bash run_all.sh"
echo -e "  ${BOLD}ports${NC}      PersonaPlex :8000   app-api :5001   MeanVC :5002"
[ -n "$HF_TOKEN" ] || echo -e "  ${YELLOW}note${NC}       HF_TOKEN was not set — rerun with a token to fetch PersonaPlex."
echo
