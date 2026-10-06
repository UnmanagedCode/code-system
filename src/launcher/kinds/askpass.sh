#!/bin/sh
case "$1" in *[Pp]assword*) printf '%s\n' "$CODE_SYSTEM_SSH_PASSWORD";; *) exit 1;; esac
