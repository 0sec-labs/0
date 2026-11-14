import type { DockviewApi } from "dockview-react";

/**
 * Dockview exposes closes as layout mutations, and `createDockLifecycle` treats a close without intent as library
 * teardown. Views are closed from many places (toggle, shortcuts, chat switches), so give them an API whose
 * `panel.api.close()` always declares its intent.
 */
export function lifecycleApi(dock: DockviewApi, close: (id: string, remove: () => void) => void): DockviewApi {
  const bound = (target: object, prop: string | symbol) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  type Closable = { id: string; api: { close(): void } };
  const wrap = <T extends Closable>(panel: T): T =>
    new Proxy(panel, {
      get(target, prop) {
        if (prop !== "api") return bound(target, prop);
        return new Proxy(target.api, {
          get: (inner, key) => (key === "close" ? () => close(target.id, () => inner.close()) : bound(inner, key)),
        });
      },
    });
  return new Proxy(dock, {
    get(target, prop) {
      if (prop === "panels") return target.panels.map(wrap);
      if (prop === "getPanel")
        return (id: string) => {
          const panel = target.getPanel(id);
          return panel ? wrap(panel) : panel;
        };
      if (prop === "activePanel") return target.activePanel ? wrap(target.activePanel) : target.activePanel;
      return bound(target, prop);
    },
  });
}

/** Animate structural changes only; sash resizing stays synchronous and unanimated. */
export function installDockMotion(dock: DockviewApi, host: HTMLElement) {
  let before: Map<string, { rect: DOMRect; element: HTMLElement }> | undefined;
  let frame = 0;
  const animations = new Set<Animation>();
  const ghosts = new Set<HTMLElement>();
  const clear = () => {
    for (const animation of animations) animation.cancel();
    animations.clear();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  };
  const animate = (element: HTMLElement, keyframes: Keyframe[], finish?: () => void) => {
    const animation = element.animate(keyframes, { duration: 190, easing: "cubic-bezier(.22,1,.36,1)" });
    animations.add(animation);
    const done = () => {
      animations.delete(animation);
      finish?.();
    };
    animation.onfinish = done;
    animation.oncancel = done;
  };
  const surfaces = () => {
    const groups = dock.groups.map((group) => ({
      id: `group:${group.id}`,
      element: group.element,
      rect: group.element.getBoundingClientRect(),
    }));
    // renderer="always" content lives in Dockview overlays outside the group DOM.
    const overlays = Array.from(host.querySelectorAll<HTMLElement>("[data-dock-panel-id]")).flatMap((slot) => {
      const id = slot.dataset.dockPanelId!;
      const panel = dock.getPanel(id);
      const element = slot.closest<HTMLElement>(".dv-render-overlay");
      return panel?.api.isVisible && element && !groups.some((group) => group.element.contains(element))
        ? [{ id: `panel:${id}`, element, rect: element.getBoundingClientRect() }]
        : [];
    });
    return [...groups, ...overlays];
  };
  const will = dock.onWillMutateLayout((event) => {
    if (!["add", "remove", "move", "maximize", "tab-group"].includes(event.kind) || before) return;
    clear();
    before = new Map(surfaces().map((surface) => [surface.id, surface]));
  });
  const did = dock.onDidMutateLayout(() => {
    if (!before || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const previous = before;
      before = undefined;
      if (!previous || !host.isConnected) return;
      const groups = surfaces();
      const currentIds = new Set(groups.map((group) => group.id));
      const hostRect = host.getBoundingClientRect();
      for (const [id, old] of previous) {
        if (!id.startsWith("group:") || currentIds.has(id) || old.rect.width < 1 || old.rect.height < 1) continue;
        // A lightweight surface fades out; no duplicate transcript, controls or remote media.
        const ghost = document.createElement("div");
        ghost.className = "console-dock-closing-surface";
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        Object.assign(ghost.style, {
          left: `${old.rect.left - hostRect.left}px`,
          top: `${old.rect.top - hostRect.top}px`,
          width: `${old.rect.width}px`,
          height: `${old.rect.height}px`,
        });
        host.append(ghost);
        ghosts.add(ghost);
        animate(
          ghost,
          [
            { opacity: 0.7, transform: "scale(1)" },
            { opacity: 0, transform: "scale(.975)" },
          ],
          () => {
            ghost.remove();
            ghosts.delete(ghost);
          },
        );
      }
      for (const group of groups) {
        if (group.rect.width < 1 || group.rect.height < 1) continue;
        const old = previous.get(group.id);
        if (!old) {
          animate(group.element, [
            { opacity: 0, transform: "translateX(12px) scale(.985)" },
            { opacity: 1, transform: "none" },
          ]);
          continue;
        }
        const dx = old.rect.left - group.rect.left,
          dy = old.rect.top - group.rect.top;
        const sx = old.rect.width / group.rect.width,
          sy = old.rect.height / group.rect.height;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) continue;
        animate(group.element, [
          { transformOrigin: "top left", transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` },
          { transformOrigin: "top left", transform: "none" },
        ]);
      }
    });
  });
  // Grabbing a sash cancels the previous structural animation immediately.
  const pointerDown = (event: PointerEvent) => {
    if (event.target instanceof Element && event.target.closest(".dv-sash")) clear();
  };
  host.addEventListener("pointerdown", pointerDown, true);
  return {
    dispose: () => {
      will.dispose();
      did.dispose();
      if (frame) cancelAnimationFrame(frame);
      clear();
      host.removeEventListener("pointerdown", pointerDown, true);
    },
  };
}
