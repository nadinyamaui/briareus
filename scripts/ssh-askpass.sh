#!/bin/sh
# OpenSSH invokes this helper without putting the password in arguments or files.
printf '%s\n' "$BRIAREUS_SSH_PASSWORD"
