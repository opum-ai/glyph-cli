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
# A CR before the newline makes every marker line fail an exact match, which
# would otherwise surface as a missing marker.
if grep -q "$(printf '\r')" "$file"; then
  fail "${file} has CRLF line endings; the markers cannot match"
fi

begins="$(grep -cxF "$begin" "$file" || true)"
ends="$(grep -cxF "$end" "$file" || true)"
[ "$begins" -eq 1 ] && [ "$ends" -eq 1 ] \
  || fail "markers: expected exactly one begin and one end marker, found ${begins} begin and ${ends} end"
begin_line="$(grep -nxF "$begin" "$file" | cut -d: -f1)"
end_line="$(grep -nxF "$end" "$file" | cut -d: -f1)"
[ "$begin_line" -lt "$end_line" ] || fail "markers: the end marker comes before the begin marker"

# First digit-led token after 'Quest CLI', so prose such as 'Quest CLI version'
# can never be the match.
version="$(awk -v b="$begin_line" -v e="$end_line" \
  'NR >= b && NR <= e && match($0, /Quest CLI [0-9][^ ]*/) { print substr($0, RSTART + 10, RLENGTH - 10); exit }' "$file")"

[ -n "$version" ] || fail "no 'Quest CLI <version>' line inside the managed Quest block"
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "Quest version '${version}' is not an exact X.Y.Z"

printf '%s\n' "$version"
