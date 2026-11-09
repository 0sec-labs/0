import { useId } from "react";
import type { ConsoleAccessProgramConfiguration, ConsoleCyberAccessProgram } from "@0/shared";
import { Select, type SelectOption } from "@0/ui/components/select";

export const ACCESS_PROGRAM_LABELS: Record<ConsoleCyberAccessProgram, string> = {
  standard: "Standard", daybreak_blue: "Daybreak Blue", daybreak_red: "Daybreak Red",
};

export function accessProgramOptions(configuration: ConsoleAccessProgramConfiguration): SelectOption[] {
  const options: SelectOption[] = [{ value: "automatic", label: "Automatic" }];
  for (const value of Object.keys(ACCESS_PROGRAM_LABELS) as ConsoleCyberAccessProgram[]) {
    if (configuration.options.includes(value)) options.push({ value, label: ACCESS_PROGRAM_LABELS[value] });
  }
  // A stale/unsupported explicit request stays visible until the operator clears it.
  if (configuration.requested && !configuration.options.includes(configuration.requested)) {
    options.push({ value: configuration.requested, label: ACCESS_PROGRAM_LABELS[configuration.requested], disabled: true });
  }
  return options;
}

export function accessProgramChange(configuration: ConsoleAccessProgramConfiguration, value: string): ConsoleCyberAccessProgram | null | undefined {
  if (value === "automatic") return null;
  return configuration.options.find(option => option === value);
}

export function accessProgramStatus(configuration: ConsoleAccessProgramConfiguration): string {
  return [configuration.requested ? "Requested" : configuration.confirmed ? "Automatic" : null,
    configuration.confirmed ? `Last provider response: ${ACCESS_PROGRAM_LABELS[configuration.confirmed]}` : null,
    configuration.unavailableReason].filter(Boolean).join(" · ");
}

/** Options describe the request protocol. They do not assert account entitlement. */
export function AccessProgramControl({ configuration, disabled, onChange }: {
  configuration?: ConsoleAccessProgramConfiguration;
  disabled: boolean;
  onChange: (value: ConsoleCyberAccessProgram | null) => void;
}) {
  const descriptionId = useId();
  if (!configuration || (!configuration.options.length && configuration.requested === null)) return null;
  const requested = configuration.requested;
  const status = accessProgramStatus(configuration);
  return <section aria-label="Daybreak" className="shrink-0 border-b border-border px-3 py-2"
    onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter", " "].includes(event.key)) event.stopPropagation(); }}>
    <div className="flex min-w-0 items-center gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">Daybreak</span>
      <Select value={requested ?? "automatic"} options={accessProgramOptions(configuration)} size="sm" className="ml-auto min-w-0 max-w-56 flex-1"
        aria-label="Daybreak access program" aria-describedby={status ? descriptionId : undefined} disabled={disabled}
        onValueChange={value => { const next = accessProgramChange(configuration, value); if (!disabled && next !== undefined && next !== requested) onChange(next); }} />
    </div>
    {status && <p id={descriptionId} role="status" className="mt-1 text-[11px] text-muted-foreground">{status}</p>}
  </section>;
}
