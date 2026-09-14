/** @jsxImportSource @opentui/react */
/**
 * A shared stack for NESTED popups — "settings with multiple levels of popups".
 *
 * The console already raises a single active overlay through `run.tsx`'s
 * `routes[]`/`routeIndex` + one `DialogSurface`. That is a HISTORY stack (go
 * back / forward through screens), not a VISUAL stack, and it is load-bearing:
 * it is tied to `routeOwner` and top-level screen navigation. This module does
 * NOT replace it. It is a second, purely-visual stack layered ABOVE that
 * level-0 screen, so a screen can open a sub-popup, and that sub-popup can open
 * its own, without any of them owning a route.
 *
 * The mechanism is the exact trick `PanePalette` and `run.tsx` already use to
 * keep only one layer interactive: OpenTUI's `useKeyboard`/`usePaste` both read
 * their `keyHandler` off `AppContext` (see `@opentui/react`), so a subtree
 * wrapped in `AppContext.Provider value={{ ...ctx, keyHandler: null }}` stops
 * receiving keys AND pastes. `PopupStackRenderer` applies that to every layer
 * except the topmost:
 *
 *   - the base app content is inert whenever the stack is non-empty;
 *   - every stacked popup below the top is inert;
 *   - only the topmost popup keeps the live `keyHandler`.
 *
 * So Esc (wired by each popup to `api.pop`) pops exactly one level, revealing
 * the layer beneath it — not the whole stack. Each level draws its own dimming
 * backdrop (the `Popup` primitive's default), so depth reads visually too.
 *
 * The stack itself is a pure reducer (`popupStackReducer`), unit-tested without
 * a renderer; the provider is a thin `useReducer` around it plus a monotonic id
 * source.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { AppContext } from "@opentui/react";

/**
 * The z-index the bottom stacked popup renders at; each higher level adds
 * `POPUP_STACK_STEP`. Chosen to sit above the level-0 `DialogSurface`/onboarding
 * overlays (zIndex 100) and the shutdown dialog (200), so a sub-popup always
 * floats over the screen that opened it.
 */
export const POPUP_STACK_BASE = 300;
export const POPUP_STACK_STEP = 10;

/** The handle a pushed popup renderer receives, so it can drive its own layer. */
export interface PopupEntryApi {
  /** This entry's stable id. */
  id: string;
  /** This entry's position in the stack (0 = bottom of the stack). */
  index: number;
  /** The z-index this level should render its `Popup` at. */
  zIndex: number;
  /** Pop THIS entry (and anything above it). Wire it to Esc / `Popup.onClose`. */
  pop: () => void;
  /** Open a further nested popup above this one. */
  push: (render: PopupRender) => string;
  /** Replace this entry's content in place (same id, same position). */
  replace: (render: PopupRender) => void;
}

/** A function that renders one popup layer, given its live api. */
export type PopupRender = (api: PopupEntryApi) => ReactNode;

interface StackEntry {
  id: string;
  render: PopupRender;
}

// ---------------------------------------------------------------------------
// Pure reducer — unit-tested in popup-stack.test.ts
// ---------------------------------------------------------------------------

export type PopupStackAction =
  | { type: "push"; id: string; render: PopupRender }
  | { type: "pop"; id?: string }
  | { type: "replace"; id: string; render: PopupRender };

/**
 * The stack transition function.
 *
 *   - `push`    appends a new top entry.
 *   - `pop`     with no id removes the top entry; with an id removes that entry
 *               AND every entry above it (closing a level closes its children),
 *               and is a no-op when the id is not present.
 *   - `replace` swaps the render of the named entry in place, keeping its id and
 *               position; a no-op when the id is not present.
 */
export function popupStackReducer(stack: StackEntry[], action: PopupStackAction): StackEntry[] {
  switch (action.type) {
    case "push":
      return [...stack, { id: action.id, render: action.render }];
    case "pop": {
      if (stack.length === 0) return stack;
      if (action.id == null) return stack.slice(0, -1);
      const at = stack.findIndex((entry) => entry.id === action.id);
      if (at === -1) return stack;
      return stack.slice(0, at);
    }
    case "replace": {
      const at = stack.findIndex((entry) => entry.id === action.id);
      if (at === -1) return stack;
      const next = stack.slice();
      next[at] = { id: action.id, render: action.render };
      return next;
    }
    default:
      return stack;
  }
}

// ---------------------------------------------------------------------------
// Context + provider
// ---------------------------------------------------------------------------

export interface PopupStackApi {
  /** Push a new top-level popup; returns its id (for `pop(id)`/`replace`). */
  push: (render: PopupRender) => string;
  /** Pop the top popup, or the named one (and everything above it). */
  pop: (id?: string) => void;
  /** Replace a popup's content in place. */
  replace: (id: string, render: PopupRender) => void;
  /** How many popups are currently stacked. */
  depth: number;
}

const PopupStackContext = createContext<PopupStackApi | null>(null);

/** The stack api. Throws if used outside a `PopupStackProvider`. */
export function usePopupStack(): PopupStackApi {
  const api = useContext(PopupStackContext);
  if (!api) throw new Error("usePopupStack must be used within a PopupStackProvider");
  return api;
}

/**
 * Provides the popup stack AND renders it above `children`.
 *
 * `children` is the base app content (the level-0 screen). It is wrapped in a
 * `keyHandler: null` `AppContext` whenever the stack is non-empty, so the
 * screen underneath a popup neither reads keys nor eats pastes. Each stacked
 * popup is rendered in stack order; only the topmost keeps the live handler.
 */
export function PopupStackProvider({ children }: { children: ReactNode }) {
  const [stack, dispatch] = useReducer(popupStackReducer, [] as StackEntry[]);
  const nextId = useRef(0);
  const parentContext = useContext(AppContext);

  const push = useCallback((render: PopupRender): string => {
    const id = `popup-${nextId.current++}`;
    dispatch({ type: "push", id, render });
    return id;
  }, []);
  const pop = useCallback((id?: string) => dispatch({ type: "pop", id }), []);
  const replace = useCallback(
    (id: string, render: PopupRender) => dispatch({ type: "replace", id, render }),
    [],
  );

  const api = useMemo<PopupStackApi>(
    () => ({ push, pop, replace, depth: stack.length }),
    [push, pop, replace, stack.length],
  );

  // The base layer is inert while anything is stacked over it.
  const inertContext = useMemo(
    () => ({ ...parentContext, keyHandler: null }),
    [parentContext],
  );
  const base =
    stack.length > 0 ? (
      <AppContext.Provider value={inertContext}>{children}</AppContext.Provider>
    ) : (
      children
    );

  return (
    <PopupStackContext.Provider value={api}>
      {base}
      {stack.map((entry, index) => {
        const isTop = index === stack.length - 1;
        const entryApi: PopupEntryApi = {
          id: entry.id,
          index,
          zIndex: POPUP_STACK_BASE + index * POPUP_STACK_STEP,
          pop: () => pop(entry.id),
          push,
          replace: (render) => replace(entry.id, render),
        };
        const node = entry.render(entryApi);
        // Only the topmost layer keeps the live keyHandler; every layer below
        // it is nulled so Esc/keys reach exactly one popup.
        return (
          <React.Fragment key={entry.id}>
            {isTop ? node : <AppContext.Provider value={inertContext}>{node}</AppContext.Provider>}
          </React.Fragment>
        );
      })}
    </PopupStackContext.Provider>
  );
}
