# THE LIVE SSH TARGET for tests/ssh-live.test.mjs.
#
# debian:13-slim, NOT Alpine: .wiki/gotchas/baseline-probe-two-tier.md records
# busybox failing our tooling baseline in FOUR capabilities (readDir, realpath,
# stat, shell), so an Alpine target would have `fileops` gated off and the live
# suite could not exercise the thing it exists to exercise.
#
# BUILT WITH NO CONTEXT — `docker build -t … -` with this file on stdin. This
# container's filesystem is not the daemon's, so bind mounts and build contexts
# are unavailable here (the same identity limit that defers bound conformance to
# card 2026-0006). The authorized key is therefore injected at RUN time through
# $AUTHORIZED_KEY, never baked in: the suite generates a throwaway keypair per
# run and must never offer the operator's real agent keys.
FROM debian:13-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /root/.ssh \
 && chmod 700 /root/.ssh \
 && printf '%s\n' \
      'PasswordAuthentication no' \
      'PermitRootLogin prohibit-password' \
      'UsePAM no' \
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
