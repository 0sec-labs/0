import { spawnSync } from "node:child_process";
import { resolveWorkbenchProfile } from "./workbench-profile.mjs";

if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("OS profile installation is a Linux image-build step only");
const profile = resolveWorkbenchProfile(process.argv[2]);
if (profile.name === "kali") throw new Error("Kali dependencies must be pre-provisioned in an immutable base image");
const result = spawnSync("apt-get", ["install", "-y", "--no-install-recommends", ...profile.packages], {
  stdio: "inherit", timeout: 30 * 60_000,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Workbench package installation failed (${result.status})`);
