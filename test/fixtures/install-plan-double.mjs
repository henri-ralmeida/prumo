import module from 'node:module'

// Um planner de outra versão pode solicitar remoção; a prévia deve conservar os dados.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/install.mjs')) return nextLoad(url, context)
  const actual = `${url}?prumo-real`
  return { format: 'module', shortCircuit: true, source: `
export * from ${JSON.stringify(actual)};
import { planInstall as actualPlan, inspectInstallation as actualInspection } from ${JSON.stringify(actual)};
import { readFileSync } from 'node:fs';
export function planInstall(options) {
  const plan = actualPlan(options);
  const file = process.env.PRUMO_TEST_REMOVE_PREVIEW;
  if (file) plan.groups.push({ name: 'compatibility-removal', snapshots: [], cleanup: [], conflicts: [], changes: [{ file, before: readFileSync(file), after: null }] });
  return plan;
}
export function inspectInstallation(...args) {
  const report = actualInspection(...args);
  return process.env.PRUMO_TEST_UNKNOWN_MARKER_CONTENT === '1' ? { ...report, contentId: null, markerContentId: 'legacy', markerContentCurrent: false } : report;
}
//# sourceURL=prumo-test://install-plan-double
` }
} })
