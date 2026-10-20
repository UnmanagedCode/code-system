# THE ALPINE LIVE SSH TARGET for the transport tests in tests/ssh-live.test.mjs.
#
# alpine:3.22 ships BusyBox, whose `env` has no `--chdir` (GNU coreutils >= 8.28
# only). It exists to prove the transport itself runs on such a target; the
# fileops and reap tests stay on tests/fixtures/sshbox because BusyBox fails
# the tooling baseline (.wiki/gotchas/baseline-probe-two-tier.md).
#
# BUILT WITH NO CONTEXT, like the debian fixture, and the same $AUTHORIZED_KEY
# contract: the key is injected at RUN time, never baked in. No `UsePAM`:
# Alpine's sshd is built without it and rejects the option.
FROM alpine:3.22

RUN apk add --no-cache openssh-server \
 && mkdir -p /root/.ssh \
 && chmod 700 /root/.ssh \
 && mkdir -p /etc/ssh/sshd_config.d \
 && printf '%s\n' \
      'PasswordAuthentication no' \
      'PermitRootLogin prohibit-password' \
    > /etc/ssh/sshd_config.d/code-system.conf \
 && printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'if [ -n "$AUTHORIZED_KEY" ]; then' \
      '  printf "%s\n" "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys' \
      '  chmod 600 /root/.ssh/authorized_keys' \
      'fi' \
      'ssh-keygen -A >/dev/null' \
      'exec /usr/sbin/sshd -D -e' \
    > /usr/local/bin/entry.sh \
 && chmod 755 /usr/local/bin/entry.sh

CMD ["/usr/local/bin/entry.sh"]
