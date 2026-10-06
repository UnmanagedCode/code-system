#!/bin/sh
case "$1" in
  *[Pp]assword*) [ -n "$CODE_SYSTEM_SSH_PASSWORD" ] || exit 1; printf '%s\n' "$CODE_SYSTEM_SSH_PASSWORD";;
  *) exit 1;;
esac
