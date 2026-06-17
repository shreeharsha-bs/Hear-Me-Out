#!/bin/bash
# Generate self-signed SSL certificates for development
# Run this once on the server

WORKSPACE="${WORKSPACE:-/workspace}"
SSL_DIR="$WORKSPACE/ssl"

mkdir -p "$SSL_DIR"

openssl req -x509 -newkey rsa:2048 \
  -keyout "$SSL_DIR/key.pem" \
  -out "$SSL_DIR/cert.pem" \
  -days 3650 \
  -nodes \
  -subj "/CN=*" \
  -addext "subjectAltName=DNS:*,IP:0.0.0.0"

echo "SSL certificates generated in $SSL_DIR"
echo "cert.pem and key.pem are ready."