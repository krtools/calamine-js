/** Build the native addon via cargo and place the platform artifact next to
 * index.js as calamine-native.node. (Full napi prebuild CI matrix is future
 * work — this builds for the current platform only.) */
import { execSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pkgDir, "..", "..");

execSync("cargo build -p calamine-native --release", { stdio: "inherit", cwd: repoRoot });

const artifact = {
  win32: "calamine_native.dll",
  darwin: "libcalamine_native.dylib",
  linux: "libcalamine_native.so",
}[process.platform];
if (!artifact) throw new Error(`unsupported platform: ${process.platform}`);

copyFileSync(path.join(repoRoot, "target", "release", artifact), path.join(pkgDir, "calamine-native.node"));
console.log(`calamine-native.node ready (${process.platform})`);
