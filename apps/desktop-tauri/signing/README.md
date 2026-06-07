# Code Signing Configuration

This directory contains scripts and documentation for setting up code signing for EvolveFlow desktop builds.

## Overview

Code signing is required for:

- **Windows**: Avoiding SmartScreen warnings and allowing silent installation
- **macOS**: Gatekeeper acceptance and notarization
- **Linux**: Not strictly required, but AppImage/Flatpak may optionally be signed

## Windows Code Signing

### Option A: EV/OV Certificate (Recommended for Production)

1. Purchase an Extended Validation (EV) or Organization Validation (OV) code signing certificate from a trusted CA:

   - [DigiCert](https://www.digicert.com/code-signing/)
   - [Sectigo](https://sectigo.com/ssl-certificates/code-signing)
   - [GlobalSign](https://www.globalsign.com/en/code-signing-certificate)

2. Export the certificate as a PFX file (including the private key):

   ```powershell
   # In the certificate manager (certlm.msc), export with private key
   # Or use OpenSSL to convert if needed
   ```

3. Encode the PFX as a Base64 string for GitHub Actions:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | clip
   ```

4. Add to GitHub Secrets:

   - `WINDOWS_CERTIFICATE`: Base64-encoded PFX content
   - `WINDOWS_CERTIFICATE_PASSWORD`: PFX password

5. The release pipeline will:
   - Decode and import the certificate into the Windows certificate store
   - Sign the installer with `signtool.exe` (included with Windows SDK)
   - Timestamp the signature using DigiCert's timestamp server

### Option B: Azure Key Vault / Azure Trusted Signing (Cloud-Based)

1. Set up [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) (formerly Azure Code Signing)

2. Configure authentication via Azure CLI or service principal

3. Use the [SignClient](https://github.com/dotnet/sign) or Azure Sign Tool in the pipeline

### Option C: Self-Signed (Development Only)

Run `./generate-dev-cert.sh` to create a self-signed certificate for local development.

**Warning:** Self-signed certificates will still trigger SmartScreen warnings on end-user machines.

## macOS Code Signing

### Prerequisites

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)

2. Create certificates via the [Apple Developer Portal](https://developer.apple.com/account/resources/certificates/list):

   - **Developer ID Application** certificate for distribution outside the App Store
   - **Apple Distribution** certificate for Mac App Store distribution

3. Export the certificate + private key:

   ```bash
   # From Keychain Access, export both certificate and private key as a .p12 file
   ```

4. Encode for GitHub Actions:

   ```bash
   base64 -i certificate.p12 | pbcopy
   ```

5. Register a [Bundle ID](https://developer.apple.com/account/resources/identifiers/list) matching `com.evolveflow.desktop`

6. Create an [App-Specific Password](https://appleid.apple.com/account/manage) for notarization

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `MACOS_CERTIFICATE` | Base64-encoded .p12 certificate |
| `MACOS_CERTIFICATE_PASSWORD` | .p12 export password |
| `MACOS_NOTARY_APPLE_ID` | Your Apple ID email |
| `MACOS_NOTARY_TEAM_ID` | Your Apple Developer Team ID (10-character string) |
| `MACOS_NOTARY_PASSWORD` | App-specific password for notarization |

### Notarization Flow

1. `codesign` — Sign the `.app` bundle with hardened runtime
2. `ditto -c -k` — Create a `.zip` archive for submission
3. `xcrun notarytool submit` — Submit to Apple for notarization
4. `xcrun stapler staple` — Staple the ticket to the `.app`
5. `spctl -a -v` — Verify the signed and notarized app

## Linux Code Signing

Linux packages (`.deb`, `.rpm`, `.AppImage`) do not require binary code signing in the same way as Windows or macOS.

### Debian / Ubuntu (`.deb`)

- Packages should be signed with `debsign` using a GPG key
- The signed `.changes` file verifies package integrity
- See: [Debian Signing Tutorial](https://wiki.debian.org/SecureApt)

### Fedora / RHEL (`.rpm`)

- RPM packages can be signed with `rpmsign` using a GPG key
- See: [RPM Signing Guide](https://fedoraproject.org/wiki/Creating_RPM_%28signing%29)

### AppImage

- AppImages can be signed using `appimagetool` with a GPG key
- Alternatively, use the update metadata mechanism to verify updates

## Local Testing

### Windows (Local)

```powershell
# Build the app
npm run build -w @evolveflow/desktop-tauri

# Sign manually (adjust paths as needed)
signtool sign /fd sha256 /a /f .\signing\dev-cert.pfx /p evolveflow `
  .\src-tauri\target\release\bundle\msi\EvolveFlow_*.msi
```

### macOS (Local)

```bash
# Build the app
npm run build -w @evolveflow/desktop-tauri

# Ad-hoc sign (no identity needed for local testing)
codesign -s - -v --deep --force \
  src-tauri/target/release/bundle/dmg/EvolveFlow.app

# Verify
codesign -dvvv src-tauri/target/release/bundle/dmg/EvolveFlow.app
```

## CI Pipeline Integration

Code signing is integrated into `.github/workflows/release.yml`. See that file for the full implementation. The signing steps are conditional on:

- `matrix.os == 'windows-latest'` — Windows signing
- `matrix.os == 'macos-latest'` — macOS signing and notarization
- Linux builds skip code signing

## References

- [Tauri v2 Code Signing](https://v2.tauri.app/start/distribute/code-signing/)
- [Apple Code Signing Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/)
- [Windows SignTool Docs](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)
