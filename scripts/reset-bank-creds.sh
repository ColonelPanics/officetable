#!/bin/sh
# One-shot debug helper (office virtual money only): stamp the stored site-side
# bank password back to the current bank-side password so login + transfers work.
# Usage: sh scripts/reset-bank-creds.sh AdamJ correctpassword
set -e
cd "$(dirname "$0")/.."
USER="$1"
PASS="$2"
[ -n "$USER" ] && [ -n "$PASS" ] || { echo "usage: $0 <bank_username> <password>"; exit 2; }
sqlite3 officetable.db "UPDATE bank_accounts SET bank_password = '$PASS', updated_at = CURRENT_TIMESTAMP WHERE bank_username = '$USER';"
sqlite3 officetable.db "SELECT 'stored password length: ' || length(bank_password) FROM bank_accounts WHERE bank_username = '$USER';"
echo "Done — log in at the top right with that bank username + password."