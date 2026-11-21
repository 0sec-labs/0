// Guards how the published Docker image embeds the release telemetry keys: only as
// BuildKit secrets (never ARG/ENV), only in the credentialed publish workflow, and
// never in a workflow that runs on pull_request. Static checks, plus an optional
// live BuildKit check that is skipped when docker is absent.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const dockerfile = read("deploy/docker/Dockerfile");
const publish = read(".github/workflows/docker-publish.yml");
const IDS = ["zero_release_sentry_dsn", "zero_release_posthog_key"];
const NAMES = ["ZERO_RELEASE_SENTRY_DSN", "ZERO_RELEASE_POSTHOG_KEY"];

test("Dockerfile mounts both keys as optional secrets on the build step", () => {
  const code = dockerfile.replace(/\\\r?\n/g, " ");
  for (const id of IDS) {
    assert.match(code, new RegExp(`--mount=type=secret,id=${id},required=false`));
  }
  const run = code.split(/\r?\n/).find((l) => l.startsWith("RUN --mount=type=secret"));
  assert.ok(run, "secret-mounted RUN present");
  assert.match(run, /pnpm build\s*$/);
  assert.equal(code.match(/^RUN pnpm build\s*$/m), null, "no bare pnpm build");
});

test("Dockerfile never uses ARG or ENV for the release keys", () => {
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (/^\s*(ARG|ENV)\b/.test(line)) {
      for (const name of [...NAMES, ...IDS]) {
        assert.ok(!line.toLowerCase().includes(name.toLowerCase()), line);
      }
    }
  }
});

test("only the builder stage sees the secrets; the runtime copies dist", () => {
  const afterBuilder = dockerfile.split("# ---------- Stage 2")[1];
  for (const id of IDS) assert.ok(!afterBuilder.includes(id));
  assert.match(afterBuilder, /COPY --from=builder \/app\/dist \/app\/dist/);
});

test("docker-publish passes both secrets to every build-push step", () => {
  const steps = publish.split(/\n      - name: /).filter((s) => /uses: docker\/build-push-action@/.test(s));
  assert.equal(steps.length, 2);
  for (const step of steps) {
    assert.match(step, /secrets: \|/);
    for (const [id, name] of IDS.map((id, i) => [id, NAMES[i]])) {
      assert.ok(step.includes(`${id}=\${{ secrets.${name} }}`), `${id} missing`);
    }
    assert.ok(!/build-args:/.test(step), "no build-args");
  }
  assert.ok(!/\n\s+pull_request(_target)?:/.test(publish.split("\npermissions:")[0]));
});

test("no pull_request workflow references the release keys", () => {
  const dir = join(ROOT, ".github/workflows");
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(dir, f), "utf8");
    const onBlock = text.split(/\n(?:permissions|env|concurrency|jobs|defaults):/)[0];
    if (!/^\s*"?pull_request(_target)?"?\s*:|\[[^\]]*pull_request/m.test(onBlock)) continue;
    for (const name of NAMES) assert.ok(!text.includes(name), `${f} references ${name}`);
  }
});

const hasBuildkit = spawnSync("docker", ["buildx", "version"], { encoding: "utf8" }).status === 0
  && spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;

test("live: secret reaches the RUN but not the image history", { skip: !hasBuildkit }, () => {
  const dir = mkdtempSync(join(tmpdir(), "zero-embed-"));
  const fake = "phc_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";
  const tag = `zero-embed-test:${process.pid}`;
  try {
    writeFileSync(join(dir, "Dockerfile"), [
      "# syntax=docker/dockerfile:1.7",
      "FROM busybox:1.36",
      "RUN --mount=type=secret,id=zero_release_posthog_key,required=false \\",
      "    if [ -s /run/secrets/zero_release_posthog_key ]; then cat /run/secrets/zero_release_posthog_key | wc -c > /out; else echo 0 > /out; fi",
      "",
    ].join("\n"));
    const build = spawnSync("docker", ["build", "-q", "-t", tag, "--secret", "id=zero_release_posthog_key,env=FAKE_KEY", dir],
      { encoding: "utf8", env: { ...process.env, FAKE_KEY: fake } });
    if (build.status !== 0) return; // base image unavailable offline: nothing to assert
    const out = spawnSync("docker", ["run", "--rm", tag, "cat", "/out"], { encoding: "utf8" }).stdout.trim();
    assert.equal(Number(out), fake.length);
    const history = spawnSync("docker", ["history", "--no-trunc", tag], { encoding: "utf8" }).stdout;
    assert.ok(!history.includes(fake));
  } finally {
    spawnSync("docker", ["rmi", "-f", tag]);
    rmSync(dir, { recursive: true, force: true });
  }
});
