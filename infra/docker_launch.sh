#!/bin/bash
# Reference only — how the prod backend container is launched on the GPU host.
# This is NOT part of the from-git workspace setup (use infra/setup.sh + infra/run_all.sh).
# Kept to document the production runtime: image `hearmeout:v2`, GPU device 4, and the
# host dir /home/shbs/hear_me_out mounted as /workspace (so /workspace == that host dir).
# See docs/ARCHITECTURE.md.
docker run --gpus '"device=4"' -d \
  --name student-gpu-env \
  -p 130.237.3.103:8888:8888 \
  -p 130.237.3.103:8000:8000 \
  -p 130.237.3.103:5001:5001 \
  -p 130.237.3.103:5002:5002 \
  --user root \
  -e NB_UID=$(id -u) \
  -e NB_GID=$(id -g) \
  -e CHOWN_HOME=yes \
  -e CHOWN_HOME_OPTS='-R' \
  -v /home/shbs/hear_me_out:/workspace \
  hearmeout:v2
