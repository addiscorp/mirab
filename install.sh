#!/bin/sh
# mirab installer.
#
#   curl -fsSL https://mirab.addis.gg/install.sh | sh
#   curl -fsSL https://mirab.addis.gg/install.sh | sh -s -- --canary
#
# Installs mirab into ~/.mirab: the release in ~/.mirab/releases/<version>,
# the command in ~/.mirab/bin.
# Options: --stable / --canary, --version X.Y.Z, --install-dir PATH,
# --base-url HTTPS_URL (artifact mirror), --no-modify-path.
# Re-run this installer to update. No sudo is required.
#
# The same installer as mirab's (mirab.dev/install.sh): the same channels,
# manifest, checksum check and atomic install, for mirab's releases.

set -eu

# Releases live in R2 (mirab-releases), served at this domain. Kept as a
# constant so repointing it is a one-line change.
BASE_URL="https://mirab.addis.gg"
INSTALL_DIR="${HOME}/.mirab"
MIRAB_VERSION=""
NO_MODIFY_PATH=0

# --- output -----------------------------------------------------------------
# Colour only when stdout is a terminal; piping to a file or another program
# should not get escape codes.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m')
  green=$(printf '\033[32m'); reset=$(printf '\033[0m')
else
  bold=''; dim=''; red=''; green=''; reset=''
fi

info() { printf '%s\n' "$*"; }
# Show ~/.mirab rather than /home/someone/.mirab in user-facing output.
# shellcheck disable=SC2088 # the ~ is printed for people, never expanded
tildify() { case "$1" in "${HOME}"/*) printf '~/%s' "${1#"${HOME}"/}" ;; *) printf '%s' "$1" ;; esac; }
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
warn() { printf '%swarning:%s %s\n' "$red" "$reset" "$*" >&2; }

die() {
  printf '%serror:%s %s\n' "$red" "$reset" "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but was not found on PATH."
}

need uname
need mkdir

# Flatten JSON onto one line so a POSIX sed can pull a string field. These
# assume the published release.json shape (no nested objects inside a
# binaries.<platform> value).
json_string() {
  # json_string FILE key -> first "key": "value"
  tr -d '\n' < "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

json_binary_sha() {
  # json_binary_sha FILE platform -> binaries[platform].sha256
  tr -d '\n' < "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*{[^}]*\"sha256\"[[:space:]]*:[[:space:]]*\"\\([a-fA-F0-9]*\\)\".*/\\1/p"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "Neither sha256sum nor shasum is available; cannot verify the download."
  fi
}

# Everything below runs inside main(), invoked on the very last line. That
# matters for `curl ... | sh`: if the connection drops mid-transfer, sh runs
# whatever bytes arrived. Top-level statements would run half a script,
# possibly having downloaded but not verified. Defining functions and calling
# main() last means a truncated file defines some functions and does nothing.

main() {
  # --- channel ----------------------------------------------------------------
  # A flag, not an environment variable: the channel is decided at the
  # curl|sh call site (`sh -s -- --canary`), not left in a shell profile.
  CHANNEL='stable'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --canary) CHANNEL='canary' ;;
      --stable) CHANNEL='stable' ;;
      --no-modify-path) NO_MODIFY_PATH=1 ;;
      --version|--install-dir|--base-url)
        option="$1"
        shift
        [ "$#" -gt 0 ] || die "Missing value for ${option}"
        case "$option" in
          --version) MIRAB_VERSION="$1" ;;
          --install-dir) INSTALL_DIR="$1" ;;
          --base-url) BASE_URL="$1" ;;
        esac
        ;;
      *) die "Usage: install.sh [--stable|--canary] [--version VERSION] [--install-dir PATH] [--base-url HTTPS_URL] [--no-modify-path]" ;;
    esac
    shift
  done
  case "$BASE_URL" in https://*) ;; *) die "The artifact mirror must use HTTPS." ;; esac
  BIN_DIR="${INSTALL_DIR}/bin"

  # --- platform ---------------------------------------------------------------
  # mirab publishes three builds:
  #   macOS  x86_64   -> darwin-x64
  #   macOS  arm64    -> darwin-arm64
  #   Linux  x86_64   -> linux-x64
  # Anything else is a clear error, not a download that 404s. OS and arch are
  # checked as a pair.
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux|Darwin) ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "Windows is not supported." \
          "Run this inside WSL (Windows Subsystem for Linux) instead:" \
          "  wsl --install" \
          "  curl -fsSL https://mirab.addis.gg/install.sh | sh"
      ;;
    *)
      die "${os} is not supported." \
          "mirab publishes builds for macOS and Linux." \
          "Track platform support: https://github.com/addiscorp/mirab/issues"
      ;;
  esac

  case "${os}/${arch}" in
    Darwin/x86_64|Darwin/amd64)   PLATFORM='darwin-x64' ;;
    Darwin/arm64|Darwin/aarch64)  PLATFORM='darwin-arm64' ;;
    Linux/x86_64|Linux/amd64)     PLATFORM='linux-x64' ;;
    Linux/aarch64|Linux/arm64)
      # Common in Docker on Apple Silicon, where the daemon defaults to
      # linux/arm64; the fix there is a flag, not another machine.
      die "Linux on ARM (${arch}) is not supported yet." \
          "mirab publishes: macOS x86_64, macOS arm64, Linux x86_64." \
          "" \
          "In Docker on an Apple Silicon Mac, ask for an x86_64 image:" \
          "  docker run --platform linux/amd64 ..." \
          "" \
          "Follow Linux ARM support: https://github.com/addiscorp/mirab/issues"
      ;;
    *)
      die "Unsupported platform: ${os} ${arch}" \
          "mirab publishes: macOS x86_64 (Intel), macOS arm64 (Apple Silicon), Linux x86_64." \
          "" \
          "Include this when reporting:" \
          "  uname -a: $(uname -a 2>/dev/null || echo unavailable)" \
          "  https://github.com/addiscorp/mirab/issues"
      ;;
  esac

  # Under Rosetta 2, `uname -m` says x86_64 on an Apple Silicon Mac, so the
  # Intel build would be picked and run emulated. Ask whether this process is
  # translated and install the native build instead.
  if [ "$PLATFORM" = 'darwin-x64' ] && \
     [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = '1' ]; then
    PLATFORM='darwin-arm64'
    info "  Detected Rosetta 2; installing the native arm64 build."
  fi

  # --- downloader -------------------------------------------------------------
  # curl and wget disagree on flags; normalise to `fetch <url> <dest>`.
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q --https-only --tries=3 -O "$2" "$1"; }
  else
    die "Either curl or wget is required."
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t mirab-install)
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT INT TERM HUP

  # --- version ----------------------------------------------------------------
  if [ -z "$MIRAB_VERSION" ]; then
    case "$CHANNEL" in
      canary)
        step "Resolving mirab version (canary)"
        fetch "${BASE_URL}/canary.json" "${tmp}/release.json" || die \
          "No canary build has been published yet (${BASE_URL}/canary.json not found)."
        ;;
      *)
        step "Resolving mirab version (stable)"
        fetch "${BASE_URL}/latest.json" "${tmp}/release.json" || die \
          "No stable release of mirab yet (${BASE_URL}/latest.json not found)." \
          "Install the newest canary build instead:" \
          "  curl -fsSL https://mirab.addis.gg/install.sh | sh -s -- --canary"
        ;;
    esac
    MIRAB_VERSION=$(json_string "${tmp}/release.json" version)
    [ -n "$MIRAB_VERSION" ] || die "Could not read the version from the ${CHANNEL} manifest."
  fi
  case "$MIRAB_VERSION" in v*) MIRAB_VERSION="${MIRAB_VERSION#v}" ;; esac

  # Release directories are the full version with no "v", in every channel:
  # 0.61.0/release.json and 0.61.0-canary-906f051/release.json (the git tag
  # has the v, the path does not). A pinned --version that is a canary
  # resolves either way.
  if [ ! -f "${tmp}/release.json" ] || [ "$(json_string "${tmp}/release.json" version)" != "$MIRAB_VERSION" ]; then
    fetch "${BASE_URL}/${MIRAB_VERSION}/release.json" "${tmp}/release.json" || die \
      "Could not download the mirab ${MIRAB_VERSION} manifest:" \
      "  ${BASE_URL}/${MIRAB_VERSION}/release.json"
  fi

  # An exact "name": "mirab" (json_string takes the last "name", which is a
  # binary's: mirab-<platform>).
  tr -d '\n' < "${tmp}/release.json" | grep -q '"name"[[:space:]]*:[[:space:]]*"mirab"' || die "This manifest is not a mirab release."
  [ "$(json_string "${tmp}/release.json" version)" = "$MIRAB_VERSION" ] || die "Release manifest version mismatch."
  ARCHIVE="mirab-${PLATFORM}.tar.gz"
  URL="${BASE_URL}/${MIRAB_VERSION}/${ARCHIVE}"
  SHA=$(json_binary_sha "${tmp}/release.json" "$PLATFORM")
  [ -n "$SHA" ] || die "mirab ${MIRAB_VERSION} has no ${PLATFORM} checksum in its release manifest."
  info ""
  info "  ${bold}mirab${reset} v${MIRAB_VERSION}"
  info "  ${dim}${PLATFORM}${reset}"
  info "  ${dim}$(tildify "${INSTALL_DIR}")${reset}"
  info ""
  # --- download and verify ----------------------------------------------------
  step "Downloading ${ARCHIVE}"
  fetch "$URL" "${tmp}/${ARCHIVE}" || die \
    "Download failed: ${URL}" \
    "That version may not publish a build for ${PLATFORM}."
  step "Verifying checksum"
  actual=$(sha256_file "${tmp}/${ARCHIVE}")
  if [ "$SHA" != "$actual" ]; then
    die "Checksum mismatch for mirab; refusing to install." \
        "expected: ${SHA}" \
        "actual:   ${actual}" \
        "" \
        "This can mean a corrupted download, or a tampered artifact." \
        "Please report it: https://github.com/addiscorp/mirab/issues"
  fi
  need tar
  mkdir -p "${tmp}/x"
  tar -xzf "${tmp}/${ARCHIVE}" -C "${tmp}/x" || die "The download could not be unpacked."
  unpacked="${tmp}/x/mirab-${PLATFORM}"
  banner=$("${unpacked}/bin/mirab" --version 2>&1) || die "The downloaded mirab did not run."
  base_version="${MIRAB_VERSION%%-canary-*}"
  [ "$banner" = "$base_version" ] || die "The downloaded mirab reports a different version: ${banner}"
  # --- install ----------------------------------------------------------------
  RELEASE_DIR="${INSTALL_DIR}/releases/${MIRAB_VERSION}"
  step "Installing to $(tildify "${RELEASE_DIR}")"
  mkdir -p "${INSTALL_DIR}/releases" "$BIN_DIR"
  # Moved into place whole, then the command is pointed at it in one step, so
  # an interrupted install leaves the previous one working.
  rm -rf "${RELEASE_DIR}.tmp"
  mv "$unpacked" "${RELEASE_DIR}.tmp"
  rm -rf "$RELEASE_DIR"
  mv "${RELEASE_DIR}.tmp" "$RELEASE_DIR"
  ln -sfn "../releases/${MIRAB_VERSION}/bin/mirab" "${BIN_DIR}/.mirab.tmp"
  mv -f "${BIN_DIR}/.mirab.tmp" "${BIN_DIR}/mirab"
  "${BIN_DIR}/mirab" --version >/dev/null 2>&1 || die "mirab was installed but does not run from $(tildify "${BIN_DIR}")."
  # --- PATH -------------------------------------------------------------------
  already_on_path=0
  case ":${PATH}:" in *":${BIN_DIR}:"*) already_on_path=1 ;; esac

  # Write $HOME rather than the expanded path when possible, so a profile
  # stays valid if the home directory moves.
  if [ "${BIN_DIR#"${HOME}/"}" != "$BIN_DIR" ]; then
    path_literal="\$HOME/${BIN_DIR#"${HOME}"/}"
  else
    path_literal="$BIN_DIR"
  fi

  # Only touch the profile of the shell the user runs: POSIX `export` in a
  # fish config is a syntax error.
  shell_name=$(basename "${SHELL:-sh}")
  added_to=''

  append_profile() {
    target_file="$1"
    target_line="$2"
    [ -e "$target_file" ] || touch "$target_file" 2>/dev/null || return 0
    [ -w "$target_file" ] || { warn "Cannot write ${target_file}; skipping PATH setup there."; return 0; }
    grep -Fq "$BIN_DIR" "$target_file" 2>/dev/null && return 0
    printf '\n# mirab\n%s\n' "$target_line" >> "$target_file" || return 0
    added_to="${added_to} ${target_file##*/}"
  }

  if [ "$already_on_path" -eq 0 ] && [ "$NO_MODIFY_PATH" -eq 0 ]; then
    case "$shell_name" in
      fish)
        fish_config="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/config.fish"
        mkdir -p "$(dirname "$fish_config")" 2>/dev/null || true
        append_profile "$fish_config" "set -gx PATH ${path_literal} \$PATH"
        ;;
      zsh)
        append_profile "${ZDOTDIR:-$HOME}/.zshrc" "export PATH=\"${path_literal}:\$PATH\""
        ;;
      bash)
        # bash reads .bash_profile on macOS login shells and .bashrc on Linux;
        # writing whichever exists covers both without inventing files.
        for f in "${HOME}/.bashrc" "${HOME}/.bash_profile"; do
          [ -f "$f" ] && append_profile "$f" "export PATH=\"${path_literal}:\$PATH\""
        done
        [ -z "$added_to" ] && append_profile "${HOME}/.bashrc" "export PATH=\"${path_literal}:\$PATH\""
        ;;
      *)
        append_profile "${HOME}/.profile" "export PATH=\"${path_literal}:\$PATH\""
        ;;
    esac
  fi

  # --- done -------------------------------------------------------------------
  info ""
  info "  ${green}Installed${reset} mirab v${MIRAB_VERSION} "
  info ""
  if [ "$already_on_path" -eq 1 ]; then
    info "  Make an agent: ${bold}mirab init my-agent${reset}"
  elif [ -n "$added_to" ]; then
    info "  Added to PATH in:${added_to}"
    info "  Restart your shell, or run:"
    info ""
    info "    ${bold}export PATH=\"${BIN_DIR}:\$PATH\"${reset}"
    info ""
    info "  Then make an agent: ${bold}mirab init my-agent${reset}"
  else
    info "  Add this to your shell profile:"
    info ""
    info "    ${bold}export PATH=\"${BIN_DIR}:\$PATH\"${reset}"
  fi
  info ""
  info "  ${dim}Docs: https://github.com/addiscorp/mirab${reset}"
  info ""
}

main "$@"
