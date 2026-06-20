/**
 * Copy the noVNC browser library out of node_modules into public/vendor/novnc so
 * the frontend can import it as static ES modules (no bundler). Runs on
 * `npm run vendor:novnc` and automatically before `npm start` (prestart).
 *
 * We copy both `core/` (the RFB implementation) and `vendor/` (its pako dependency)
 * preserving their sibling layout, because core imports `../vendor/pako/...`.
 */

const fs = require("fs");
const path = require("path");

const pkgDir = path.join(__dirname, "..", "node_modules", "@novnc", "novnc");
const destDir = path.join(__dirname, "..", "public", "vendor", "novnc");
const vendoredEntry = path.join(destDir, "core", "rfb.js");

if (!fs.existsSync(pkgDir)) {
  // In a production image @novnc is a devDependency that isn't installed, but the
  // files were already vendored during the build stage — so skip, don't fail.
  if (fs.existsSync(vendoredEntry)) {
    console.log("[vendor:novnc] @novnc not installed but already vendored — skipping.");
    process.exit(0);
  }
  console.error("[vendor:novnc] @novnc/novnc not found in node_modules — run `npm install` first.");
  process.exit(1);
}

for (const sub of ["core", "vendor"]) {
  const from = path.join(pkgDir, sub);
  const to = path.join(destDir, sub);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

console.log(`[vendor:novnc] copied noVNC core + vendor into ${path.relative(process.cwd(), destDir)}`);
