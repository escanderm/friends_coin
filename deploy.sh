#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Production deployment is separate from client builds.' 'Build clients with npm run build. Read docs/MIGRATION.md before activating protocol 2.' 'This script does not connect to SSH, restart a server or push Git commits.'
exit 1
