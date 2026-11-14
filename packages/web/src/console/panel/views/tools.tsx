import { createContext, useContext, type ReactNode } from "react";
import type { HarnessUiEvent, HarnessViewBlock } from "@0/engine/shared";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Markdown } from "../../markdown";
import { SourceContext } from "../../source-context";
import { ToolCatalog } from "../../tool-catalog";
import type { PanelViewComponent } from "../types";

/** Host-provided plugin (harness) capabilities. Omitted callbacks leave the controls inert. */
export type HarnessActions = {
  /** Put text into the composer draft for review (plugin `action` blocks). */
  stagePrompt?: (text: string) => void;
  /** Append text to the composer draft without replacing it (visual references). */
  appendPrompt?: (text: string) => void;
  /** Send a plugin command or setting change (`POST .../harness`). */
  onHarness?: (providerId: string, event: HarnessUiEvent) => void;
};
export const HarnessActionsContext = createContext<HarnessActions>({});
export function HarnessActionsProvider({ value, children }: { value: HarnessActions; children: ReactNode }) {
  return <HarnessActionsContext.Provider value={value}>{children}</HarnessActionsContext.Provider>;
}

export const hasHarnessContent = (
  harness:
    | { error?: string; views: readonly unknown[]; commands: readonly unknown[]; settings: readonly unknown[] }
    | undefined
    | null,
) => Boolean(harness && (harness.error || harness.views.length || harness.commands.length || harness.settings.length));

function HarnessBlock({ block, stagePrompt }: { block: HarnessViewBlock; stagePrompt?: (text: string) => void }) {
  if (block.type === "markdown") return <Markdown text={block.text} />;
  if (block.type === "text") return <p className="whitespace-pre-wrap text-xs leading-5">{block.text}</p>;
  if (block.type === "progress")
    return (
      <div className="text-xs">
        <div>
          {block.label} · {block.value} / {block.max}
        </div>
        <progress className="mt-1 h-2 w-full accent-primary" max={block.max} value={block.value} />
      </div>
    );
  if (block.type === "action")
    return (
      <Button variant="outline" size="sm" disabled={!stagePrompt} onClick={() => stagePrompt?.(block.prompt)}>
        {block.label}
      </Button>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th key={index} className="p-1">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td className="border-t border-border p-1" key={cellIndex}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plugins, source context and the available-tool catalog: what used to sit at the bottom of the details column. */
export const ToolsView: PanelViewComponent = ({ snapshot, busy }) => {
  const { stagePrompt, onHarness } = useContext(HarnessActionsContext);
  if (!snapshot)
    return (
      <p role="status" className="p-4 text-center text-xs text-muted-foreground-2">
        Loading chat…
      </p>
    );
  const harness = snapshot.harness;
  const editable = !busy && snapshot.session.status === "ready" && Boolean(harness?.generationId) && Boolean(onHarness);
  return (
    <div className="min-w-0 space-y-3 p-3 text-sm">
      <SourceContext context={snapshot.sourceContext} />
      {hasHarnessContent(harness) && harness && (
        <section aria-label={harness.label || "Plugins"} className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">{harness.label || "Plugins"}</h3>
          {harness.error && (
            <p role="alert" className="text-xs text-destructive">
              {harness.error}
            </p>
          )}
          {harness.views.map(({ providerId, view }) => (
            <div key={providerId} className="space-y-3 rounded-lg bg-secondary/50 p-3">
              <div className="text-xs font-medium">{view.title}</div>
              {view.blocks.map((block, index) => (
                <HarnessBlock key={index} block={block} stagePrompt={stagePrompt} />
              ))}
            </div>
          ))}
          {harness.commands.map((command) => (
            <div key={`${command.providerId}:${command.id}`} className="space-y-1">
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                disabled={!editable}
                onClick={() => onHarness?.(command.providerId, { kind: "command", id: command.id })}
              >
                {command.label}
              </Button>
              {command.description && <p className="text-xs leading-5 text-muted-foreground">{command.description}</p>}
            </div>
          ))}
          {harness.settings.map((setting) => (
            <label
              key={`${harness.generationId}:${setting.providerId}:${setting.id}`}
              className="block space-y-2 rounded-lg bg-secondary/50 p-3 text-xs"
            >
              <span className="font-medium">{setting.label}</span>
              {setting.description && <span className="block text-muted-foreground">{setting.description}</span>}
              {setting.type === "boolean" ? (
                <Switch
                  aria-label={setting.label}
                  checked={Boolean(setting.value)}
                  disabled={!editable}
                  onCheckedChange={(value) =>
                    onHarness?.(setting.providerId, { kind: "setting", id: setting.id, value })
                  }
                />
              ) : setting.type === "select" ? (
                <Select
                  aria-label={setting.label}
                  value={String(setting.value)}
                  disabled={!editable}
                  onValueChange={(value) => onHarness?.(setting.providerId, { kind: "setting", id: setting.id, value })}
                  options={setting.options ?? []}
                />
              ) : (
                <input
                  className="w-full rounded-md border border-transparent bg-secondary p-2 focus-visible:outline-2 focus-visible:outline-ring"
                  defaultValue={String(setting.value)}
                  disabled={!editable}
                  onBlur={(event) => {
                    if (event.target.value !== setting.value)
                      onHarness?.(setting.providerId, { kind: "setting", id: setting.id, value: event.target.value });
                  }}
                />
              )}
            </label>
          ))}
          <Disclosure
            className="p-3 text-xs"
            summary={<> Plugin details </>}
            triggerClassName="cursor-pointer text-muted-foreground"
          >
            <p className="mt-2 text-muted-foreground">
              {harness.status} · {harness.trusted ? "Trusted" : "Sandboxed"}
            </p>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">
              {JSON.stringify(
                { providers: harness.providers, commands: harness.commands, settings: harness.settings },
                null,
                2,
              )}
            </pre>
          </Disclosure>
        </section>
      )}
      <ToolCatalog tools={snapshot.tools} />
    </div>
  );
};
