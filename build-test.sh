#!/bin/sh
# Compile src/ to build/ and rewrite extensionless imports for node ESM.
#
# Uses node rather than sed for the rewrite: BSD sed (macOS) and GNU sed
# (Linux) disagree on -i and -E, and node is already a hard dependency.
set -e
npx tsc -p tsconfig.test.json
node -e '
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "build");
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".js")) continue;
  const p = path.join(dir, f);
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(/from "(\.\/[^"]+)"/g, (m, spec) =>
    spec.endsWith(".js") ? m : `from "${spec}.js"`,
  );
  if (after !== before) fs.writeFileSync(p, after);
}
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
'
