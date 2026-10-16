import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { aggregateCapabilities, isAdmittedSmolvmWorkbench, emptyEnablement, listInstalledPluginIds, loadableIds, pluginsRootDir, readEnablement, readInstalledPlugin, reconcile, snapshotSmolvmWorkspace, writeEnablement, TOOL_DEFINITIONS, type EnablementRecord } from "@0/core";

export const GUEST_PLUGIN_ASSETS = "/opt/0-approved-plugins";
const reservedToolNames = Object.values(TOOL_DEFINITIONS).map(tool => tool.name);
const bounds = { maxBytes: 64 * 1024 * 1024, maxFiles: 4096 };

/** Snapshot only reconciled approvals, never execute plugin code on the controller. */
export async function prepareWorkbenchPlugins(project: string, homeDir?: string): Promise<{ directory?: string; approvals: EnablementRecord; cleanup(): Promise<void> }> {
  const root = pluginsRootDir(homeDir);
  const record = readEnablement(project, homeDir);
  const views = listInstalledPluginIds(root).flatMap(id => {
    const discovered = readInstalledPlugin(root, id, { reservedToolNames });
    return discovered.ok ? [{ id, version: discovered.plugin.manifest.version, capabilities: aggregateCapabilities(discovered.plugin.manifest) }] : [];
  });
  const ids = loadableIds(reconcile(record, views));
  const approvals = emptyEnablement("/workspace");
  if (!ids.length) return { approvals, cleanup: async () => {} };
  const directory = await realpath(await mkdtemp("/tmp/0-guest-plugins-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    let bytes = 0, files = 0;
    for (const id of ids) {
      if ((await lstat(join(root, id))).isSymbolicLink()) throw new Error("Workbench plugins cannot use linked source directories");
      const snapshot = await snapshotSmolvmWorkspace(join(root, id), join(directory, id), { maxBytes: Math.max(1, bounds.maxBytes - bytes), maxFiles: Math.max(1, bounds.maxFiles - files) }, undefined, false, false);
      bytes += snapshot.bytes; files += snapshot.files.length;
      if (bytes > bounds.maxBytes || files > bounds.maxFiles) throw new Error("Approved plugins exceed the workbench plugin limits");
      const copied = readInstalledPlugin(directory, id, { reservedToolNames });
      if (!copied.ok || !loadableIds(reconcile(record, [{ id, version: copied.plugin.manifest.version, capabilities: aggregateCapabilities(copied.plugin.manifest) }])).includes(id)) throw new Error(`Plugin ${id} changed during workbench preparation; approve its current permissions first`);
      approvals.enabled[id] = record.enabled[id]!;
    }
    return { directory, approvals, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

/** Called only inside the admitted guest; host state is never mounted writable. */
export async function installWorkbenchPlugins(approvals: EnablementRecord): Promise<void> {
  if (!isAdmittedSmolvmWorkbench()) throw new Error("Plugin installation requires admitted VM execution");
  const ids = Object.keys(approvals.enabled);
  for (const id of ids) {
    const discovered = readInstalledPlugin(GUEST_PLUGIN_ASSETS, id, { reservedToolNames });
    if (!discovered.ok || !loadableIds(reconcile(approvals, [{ id, version: discovered.plugin.manifest.version, capabilities: aggregateCapabilities(discovered.plugin.manifest) }])).includes(id)) throw new Error(`Invalid approved guest plugin: ${id}`);
    await snapshotSmolvmWorkspace(join(GUEST_PLUGIN_ASSETS, id), join(pluginsRootDir(), id), bounds, undefined, false, false);
  }
  if (ids.length && !writeEnablement("/workspace", { ...approvals, project: "/workspace" })) throw new Error("Could not save guest plugin approvals");
}
