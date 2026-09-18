// Run explicitly with Bun; Rust tests use the checked-in generated fixture.
import {mock} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
mock.module("@0sec/shared",()=>({VERSION:"fixture-version"}));
const {formatSarif}=await import("../../../../../packages/cli/src/formatters/sarif.ts");
const report=JSON.parse(readFileSync(join(import.meta.dir,"report.json"),"utf8"));
writeFileSync(join(import.meta.dir,"typescript.sarif.json"),formatSarif(report)+"\n");
