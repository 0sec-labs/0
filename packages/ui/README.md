# @0/ui

Public, application-neutral React UI primitives shared by 0security interfaces.
The initial components are extracted from the public chat dashboard; this package
has no private service, authentication, router or backend dependencies.

Import from `@0/ui` or use component subpaths such as
`@0/ui/components/button`. Applications own their theme values and provide the
semantic Tailwind tokens referenced by these components. Tailwind consumers
must scan this package's `src` directory (for example with `@source`).

Run `pnpm --filter @0/ui build` before building a consumer. During development,
`pnpm --filter @0/ui dev` keeps the exported JavaScript and declarations fresh.
Compiled exports let consumers keep their own TypeScript `rootDir` boundaries.

The dashboard's existing component paths are compatibility reexports, so shared
components have a single implementation without requiring an immediate caller
migration.

Import `@0/ui/styles/tokens.css` for shared control geometry and semantic field
surfaces, and `@0/ui/styles/motion.css` for the motion vocabulary. Keep palette
choices in the application. The current motion timings are 120 ms for control
feedback, 200 ms for structural changes, and 240 ms for surface arrival.

`SelectionHighlight` moves one background surface between rows marked
`data-ui-selected="true"`; it does not move text or reorder entries. Intrinsic
width motion is opt-in. Both mechanisms respect reduced motion, and avoid
animation loops while idle. Keep copy feedback truthful: change state only
after the clipboard operation succeeds.
