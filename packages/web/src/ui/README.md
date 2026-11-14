# Shared UI primitives (packages/web/src/ui)

Public, application-neutral React UI primitives shared by 0security interfaces.
The initial components are extracted from the public chat dashboard; this package
has no private service, authentication, router or backend dependencies.

Import from `@/ui` or use component subpaths such as `@/ui/components/button`
(the `@` alias maps to `packages/web/src`). The app owns its theme values and
provides the semantic Tailwind tokens referenced by these components; Tailwind
scans this directory through `@source "./ui"` in `src/styles.css`.

The dashboard's existing component paths are compatibility reexports, so shared
components have a single implementation without requiring an immediate caller
migration.

Import `@/ui/styles/tokens.css` for shared control geometry and semantic field
surfaces, and `@/ui/styles/motion.css` for the motion vocabulary. Keep palette
choices in the application. The current motion timings are 120 ms for control
feedback, 200 ms for structural changes, and 240 ms for surface arrival.

`SelectionHighlight` moves one background surface between rows marked
`data-ui-selected="true"`; it does not move text or reorder entries. Intrinsic
width motion is opt-in. Both mechanisms avoid
animation loops while idle. Keep copy feedback truthful: change state only
after the clipboard operation succeeds.
