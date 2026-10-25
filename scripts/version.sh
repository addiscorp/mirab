#!/bin/sh
# Print mirab's version, from package.json. Used by the release workflows.
set -eu
sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$(dirname "$0")/../package.json" | head -n 1
