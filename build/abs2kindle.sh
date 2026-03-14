#!/bin/bash
# Flatpak launcher — wraps zypak-helper for Chromium sandbox compatibility
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
exec zypak-wrapper /app/lib/abs2kindle/node_modules/electron/dist/electron \
    /app/lib/abs2kindle "$@"
