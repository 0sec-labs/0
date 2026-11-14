import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const dashboard = fileURLToPath(new URL("../packages/web/", import.meta.url));
test("shared primitives preserve accessible caller contracts and dense layouts", async () => {
  const directory = await mkdtemp(resolve(dashboard, ".shared-primitives-test-"));
  try {
    const output = resolve(directory, "fixture.mjs");
    await build({ stdin: { contents: `
      import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {Badge} from './src/components/ui/badge';
      import {Card,CardHeader,CardTitle,CardContent,CardEmpty,CardList,CardListItem,cardVariants} from './src/components/ui/card';
      import {ChoiceCard} from './src/components/ui/choice-card';
      import {Table,TableHeader,TableRow,TableHead,TableBody,TableCell,TableCaption} from './src/components/ui/table';
      const h=React.createElement;
      export const badge=()=>renderToStaticMarkup(h(Badge,{variant:'neutral',size:'control'},h('a',{href:'/findings'},'Findings')));
      export const card=()=>renderToStaticMarkup(h(Card,{size:'sm'},h(CardHeader,null,h(CardTitle,null,'Title')),h(CardContent,null,h(CardList,null,h(CardListItem,{selected:true},'Selected'))),h(CardEmpty,null,'Empty')));
      export const choice=selected=>renderToStaticMarkup(h(ChoiceCard,{selected},'Workspace'));
      export const table=()=>renderToStaticMarkup(h(Table,null,h(TableCaption,null,'Results'),h(TableHeader,null,h(TableRow,null,h(TableHead,{scope:'col'},'Target'))),h(TableBody,null,h(TableRow,null,h(TableCell,null,'demo-api')))));
      export {cardVariants};
    `, resolveDir: dashboard, loader: "tsx" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", logLevel: "silent" });
    const ui = await import(pathToFileURL(output).href);
    assert.match(ui.badge(), /<a[^>]*href="\/findings"/);
    assert.match(ui.badge(), /data-size="control"/);
    assert.match(ui.badge(), /data-variant="neutral"/);
    assert.match(ui.card(), /data-size="sm"/);
    assert.match(ui.cardVariants({size:"sm"}), /gap-4 py-4/);
    assert.match(ui.card(), /data-slot="card-empty"/);
    assert.match(ui.card(), /data-slot="card-list-item"/);
    assert.match(ui.choice(true), /aria-pressed="true"/);
    assert.match(ui.choice(false), /aria-pressed="false"/);
    assert.match(ui.table(), /data-slot="table-container"/);
    assert.match(ui.table(), /data-slot="scroll-area-viewport"/);
    assert.match(ui.table(), /<th[^>]*scope="col"/);
    assert.match(ui.table(), /<caption[^>]*>Results<\/caption>/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
