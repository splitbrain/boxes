#!/usr/bin/env bash
# Box container entrypoint. It holds the container open.

# /etc/ssl/certs links to ~/.boxes/certs. The empty home of a new box or of a
# login has no such link, so the system certificates fill in until boxes-setup
# writes the link.
if [ ! -e /home/agent/.boxes/certs ]; then
  mkdir -p /home/agent/.boxes && ln -sfn /etc/ssl/certs-system /home/agent/.boxes/certs
fi

exec sleep infinity
