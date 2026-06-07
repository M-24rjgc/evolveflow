#!/bin/bash
# Generate self-signed certificates for development code signing
# DO NOT use these for production distribution

echo "Generating self-signed development certificates..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}"

# --- Windows: Generate a self-signed PFX ---
if command -v openssl &> /dev/null; then
  echo "Creating Windows self-signed certificate (PFX)..."
  openssl req -x509 -newkey rsa:4096 \
    -keyout "${OUT_DIR}/dev-key.pem" \
    -out "${OUT_DIR}/dev-cert.pem" \
    -days 365 -nodes \
    -subj "/CN=EvolveFlow Dev/O=EvolveFlow/C=US"

  openssl pkcs12 -export \
    -out "${OUT_DIR}/dev-cert.pfx" \
    -inkey "${OUT_DIR}/dev-key.pem" \
    -in "${OUT_DIR}/dev-cert.pem" \
    -passout pass:evolveflow

  echo "Windows: dev-cert.pfx created (password: evolveflow)"
  echo "  Import via: certutil -user -importpfx \"${OUT_DIR}/dev-cert.pfx\""
else
  echo "WARNING: OpenSSL not found. Skipping Windows PFX generation."
  echo "  Install OpenSSL from https://slproweb.com/products/Win32OpenSSL.html"
fi

# --- macOS: Instructions for self-signed identity ---
echo ""
echo "macOS: Use 'codesign -s -' for ad-hoc signing during development."
echo "  For a self-signed identity, run:"
echo "    security create-keychain -p temp dev.keychain"
echo "    security import ${OUT_DIR}/dev-cert.pfx -k ~/Library/Keychains/dev.keychain"
echo ""
echo "  For distribution, obtain an Apple Developer certificate via:"
echo "    https://developer.apple.com/programs/"

# --- Linux: No code signing needed ---
echo ""
echo "Linux: No code signing required for distribution."
echo "  AppImage/Flatpak packages do not require binary signing."

echo ""
echo "Done. These certs are for DEVELOPMENT only."
echo "Output directory: ${OUT_DIR}"
