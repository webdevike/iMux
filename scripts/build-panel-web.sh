#!/bin/sh
# Builds the interactive panel webview into a single self-contained HTML file.
# Modeled on build-agent-session-web.sh: WKWebView custom-scheme origins are
# opaque, so ES module chunks and external asset references fail — everything
# (CSS + JS) is inlined into Resources/panel-web/index.html.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="$ROOT/Resources/panel-web"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build the panel webview" >&2
  exit 1
fi

if ! command -v bunx >/dev/null 2>&1; then
  echo "error: bunx is required to build the panel webview" >&2
  exit 1
fi

bunx esbuild "$ROOT/webviews/src/panel/standalone.tsx" \
  --bundle \
  --format=iife \
  --platform=browser \
  --target=es2022 \
  '--define:process.env.NODE_ENV="production"' \
  --minify \
  --outfile="$WORK/app.js"

strip_trailing_line_whitespace() {
  /usr/bin/perl -0pi -e 's/[ \t]+(?=\r?\n)//g; s/[ \t]+\z//' "$@"
}

strip_trailing_line_whitespace "$WORK/app.js" "$WORK/app.css"

mkdir -p "$OUT"

{
  printf '<!doctype html>\n'
  printf '<html lang="en">\n'
  printf '  <head>\n'
  printf '    <meta charset="UTF-8" />\n'
  printf '    <meta\n'
  printf '      name="viewport"\n'
  printf '      content="width=device-width, initial-scale=1.0"\n'
  printf '    />\n'
  printf '    <title>cmux Panel</title>\n'
  printf '    <style>\n'
  cat "$WORK/app.css"
  printf '\n    </style>\n'
  printf '  </head>\n'
  printf '  <body>\n'
  printf '    <div id="root"></div>\n'
  printf '    <script>\n'
  /usr/bin/perl -0pe 's{</script}{<\\/script}ig; s{<!--}{<\\!--}g' "$WORK/app.js"
  printf '\n    </script>\n'
  printf '  </body>\n'
  printf '</html>\n'
} > "$OUT/index.html"

strip_trailing_line_whitespace "$OUT/index.html"

echo "built $OUT/index.html ($(wc -c < "$OUT/index.html" | tr -d ' ') bytes)"
