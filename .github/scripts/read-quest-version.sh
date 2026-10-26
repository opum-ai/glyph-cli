#!/usr/bin/env bash
# Prints the Quest CLI version CLAUDE.md's managed Quest block declares, and
# nothing else on stdout. Reads only between the block's markers, and accepts
# only an exact X.Y.Z, so a range, a partial version or a line outside the
# block can never reach npm (DEC-240 item 3, GCLI-24). Every failure names
# itself and exits 1.
set -euo pipefail

file="${1:-CLAUDE.md}"
begin='<!-- quest:agent-instructions:begin -->'
end='<!-- quest:agent-instructions:end -->'

fail() {
  echo "::error file=${file}::$1" >&2
  exit 1
}

[ -r "$file" ] || fail "cannot read ${file}"
grep -qxF "$begin" "$file" || fail "managed Quest block begin marker not found"
grep -qxF "$end" "$file" || fail "managed Quest block end marker not found"

block="$(sed -n "/^${begin}\$/,/^${end}\$/p" "$file")"
version="$(printf '%s\n' "$block" | sed -n 's/.*Quest CLI \([^ ]*\).*/\1/p' | head -1)"

[ -n "$version" ] || fail "no 'Quest CLI <version>' line inside the managed Quest block"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "Quest version '${version}' is not an exact X.Y.Z"

printf '%s\n' "$version"
