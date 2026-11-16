import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkWorkflows } from "./check-workflow-triggers.mjs";

const repo = new URL("..", import.meta.url);
const real = Object.fromEntries(["main", "release", "docker-publish", "public-pr"].map((n) => [`${n}.yml`, readFileSync(new URL(`.github/workflows/${n}.yml`, repo), "utf8")]));

const good = {
  ...real,
  "windows.yml": "on:\n  push:\n    paths:\n      - a\n  workflow_dispatch:\n",
  "deps.yml": "on:\n  push:\n    branches: [main]\n    paths:\n      - a\n",
};

test("the intended trigger layout passes", () => assert.deepEqual(checkWorkflows(good), []));
test("an unfiltered every-branch push is rejected", () => {
  assert.equal(checkWorkflows({ ...good, "w.yml": 'on:\n  push:\n    branches: ["**"]\n' }).length, 1);
  assert.equal(checkWorkflows({ ...good, "w.yml": "on:\n  push:\n" }).length, 1);
});
test("a tag-only push is fine", () => assert.deepEqual(checkWorkflows({ ...good, "w.yml": 'on:\n  push:\n    tags: ["v*"]\n' }), []));
test("docker publish must not follow plain main", () => {
  const onMain = good["docker-publish.yml"].replace('branches: ["v*"]', "branches: [main]");
  assert.ok(checkWorkflows({ ...good, "docker-publish.yml": onMain }).some((e) => /limited to v\* release tags/.test(e)));
  const pushy = good["docker-publish.yml"].replace("on:\n", "on:\n  push:\n    branches: [main]\n    paths: [a]\n");
  assert.ok(checkWorkflows({ ...good, "docker-publish.yml": pushy }).some((e) => /must not trigger on push/.test(e)));
});
test("release and main keep their tag triggers", () => {
  const noTag = good["release.yml"].replace('tags: ["v*"]', "tags: []");
  assert.ok(checkWorkflows({ ...good, "release.yml": noTag }).some((e) => /release\.yml: push tags/.test(e)));
  const mainNoTag = good["main.yml"].replace('tags: ["v*"]', "tags: []");
  assert.ok(checkWorkflows({ ...good, "main.yml": mainNoTag }).some((e) => /main\.yml: push tags/.test(e)));
});

// The shipped workflows are the fixture for the release-gate and image-name guards.
test("the shipped workflows pass every guard", () => assert.deepEqual(checkWorkflows(real), []));
test("release.yml cannot lose its Main gate", () => {
  const noGate = real["release.yml"].replace(/^  main-gate:/m, "  main-gate-renamed:");
  assert.ok(checkWorkflows({ ...real, "release.yml": noGate }).some((e) => /main-gate/.test(e)));
  const unneeded = real["release.yml"].replace("needs: [build, main-gate]", "needs: build");
  assert.ok(checkWorkflows({ ...real, "release.yml": unneeded }).some((e) => /must need both/.test(e)));
  const wrongRun = real["release.yml"].replace("--commit \"$sha\"", "");
  assert.ok(checkWorkflows({ ...real, "release.yml": wrongRun }).some((e) => /main-gate must look up/.test(e)));
  const soft = real["release.yml"].replace("  main-gate:\n", "  main-gate:\n    continue-on-error: true\n");
  assert.ok(checkWorkflows({ ...real, "release.yml": soft }).some((e) => /continue on error/.test(e)));
});
test("a workflow cannot push another image name or an unpinned action", () => {
  const other = { ...real, "x.yml": "on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: docker push ghcr.io/acme/0\n" };
  assert.ok(checkWorkflows(other).some((e) => /not ghcr\.io\/<owner>\/0security/.test(e)));
  const unpinned = { ...real, "x.yml": "on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6\n" };
  assert.ok(checkWorkflows(unpinned).some((e) => /pinned by a full commit SHA/.test(e)));
  const pushes = { ...real, "main.yml": real["main.yml"] + "\n        with:\n          push: true\n" };
  assert.ok(checkWorkflows(pushes).some((e) => /only docker-publish\.yml may push/.test(e)));
  const refusal = real["docker-publish.yml"].replace("Refuse any tag outside", "Allow any tag outside");
  assert.ok(checkWorkflows({ ...real, "docker-publish.yml": refusal }).some((e) => /refusal guard/.test(e)));
});
