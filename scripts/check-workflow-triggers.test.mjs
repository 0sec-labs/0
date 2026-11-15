import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflows } from "./check-workflow-triggers.mjs";

const good = {
  "main.yml": 'on:\n  push:\n    branches: ["**"]\n    tags: ["v*"]\npermissions: {}\n',
  "release.yml": 'on:\n  push:\n    tags: ["v*"]\n    branches: ["**"]\n    paths:\n      - a\n  schedule:\n    - cron: "1 2 * * *"\n',
  "docker-publish.yml": 'on:\n  workflow_run:\n    workflows: ["0: Main"]\n    branches: ["v*"]\n  schedule:\n    - cron: "1 2 * * *"\n',
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
  assert.equal(checkWorkflows({ ...good, "docker-publish.yml": good["docker-publish.yml"].replace('"v*"', "main") }).length, 1);
  assert.equal(checkWorkflows({ ...good, "docker-publish.yml": "on:\n  push:\n    branches: [main]\n    paths: [a]\n  schedule:\n    - cron: x\n" }).length, 1);
});
test("release and main keep their tag triggers", () => {
  assert.equal(checkWorkflows({ ...good, "release.yml": "on:\n  schedule:\n    - cron: x\n" }).length, 1);
  assert.equal(checkWorkflows({ ...good, "main.yml": 'on:\n  push:\n    branches: ["**"]\n' }).length, 1);
});
