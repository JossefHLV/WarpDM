import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const TEXT_EXTS = new Set([".html", ".css", ".js", ".mjs", ".json", ".md", ".cs", ".ps1", ".bat", ".svg"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "runtime", "data", "downloads", "analysis", "rea-reference", "dist", "build", "build_stage"]);

// Classic UTF-8 -> Windows-1252 / Latin-1 mojibake signatures + replacement char + C1 controls
const MOJIBAKE_RE =
  /[\u0080-\u009F\uFFFD]|Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[\u0080-\u00BF]|ðŸ|ï¸|Ø[\u0080-\u00BF]|Ù[\u0080-\u00BF]|Ð[\u0080-\u00BF]|Ñ[\u0080-\u00BF]|ç®|æ—/;

function collectFiles(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectFiles(full, acc);
    else if (TEXT_EXTS.has(path.extname(ent.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

test("UTF-8 Integrity: Zero mojibake or invalid UTF-8 sequences across all project files", () => {
  const files = collectFiles(ROOT);
  assert.ok(files.length >= 25, "Expected to scan at least 25 project files");

  const corrupted = [];
  for (const f of files) {
    if (path.resolve(f) === __filename) continue; // skip regex literal itself
    const raw = fs.readFileSync(f);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (MOJIBAKE_RE.test(decoded)) {
      corrupted.push(path.relative(ROOT, f));
    }
  }
  assert.deepEqual(corrupted, [], `Found corrupted UTF-8 / mojibake in: ${corrupted.join(", ")}`);
});

test("C# Sources: Pure ASCII with explicit \\uXXXX escapes so csc.exe never mis-encodes UI strings", () => {
  for (const rel of ["src/launcher/Program.cs", "src/installer/Setup.cs"]) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const nonAsciiMatch = text.match(/[^\x00-\x7F]/);
    assert.equal(
      nonAsciiMatch,
      null,
      `${rel} contains raw non-ASCII character '${nonAsciiMatch?.[0]}' — use \\uXXXX escape for 100% csc.exe safety`
    );
  }
});

test("UI Icons & Emojis: Key UI files preserve crisp UTF-8 symbols and unified v3.5.0 version", () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, "src/ui/index.html"), "utf8");
  assert.ok(indexHtml.includes("📁"), "index.html All Downloads folder icon intact");
  assert.ok(indexHtml.includes("✅"), "index.html Finished checkmark icon intact");
  assert.ok(indexHtml.includes("🧩 Connect Browser"), "index.html Connect Browser icon intact");
  assert.ok(indexHtml.includes("v3.5.0"), "index.html shows v3.5.0");

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const extManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
  assert.equal(pkg.version, "3.5.0");
  assert.equal(extManifest.version, "3.5.0");
});
