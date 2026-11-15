import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries";
import { useBackendApi } from "@/api";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./settings-section";
import { plainHealthError, type DoctorResponse } from "./system-control";

/** One status line for the computer; the full diagnostics page is a link away, not a settings page. */
export function StatusSettings() {
  const { webFetchJson } = useBackendApi();
  const doctor = useQuery({ queryKey: queryKeys.consoleDoctor(), queryFn: ({ signal }) => webFetchJson<DoctorResponse>("/api/console/doctor", { signal }) });
  const data = doctor.data;
  if (!data?.availability) return null;
  const problem = data.providers.find(provider => provider.configured && !provider.diagnostics.valid);
  const missing = data.prerequisites.find(item => item.required && !item.available);
  const status = !data.availability.apiRuntime.valid ? plainHealthError(data.availability.apiRuntime.error) ?? "Needs connection"
    : !data.runtime.nodeSupported ? "Needs Node 24 or newer"
    : problem ? `${problem.label}: ${plainHealthError(problem.diagnostics.message ?? undefined) ?? "Needs connection"}`
    : missing ? `Missing ${missing.id}`
    : `All good · v${data.version}`;
  return <SettingsSection id="settings-support" title="Support">
    <SettingsRow id="setting-status" label="Status" description={status}><Button variant="outline" size="sm" render={<Link to="/doctor" />}>Details</Button></SettingsRow>
  </SettingsSection>;
}
