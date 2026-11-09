#!/usr/bin/env bash
# Captures the whole Xvfb screen, including native dialogs that CDP screenshots miss.
source "$(dirname "$0")/common.sh"

on_display nix shell nixpkgs#imagemagick -c import -window root "${1:?usage: screen.sh <out.png>}"
