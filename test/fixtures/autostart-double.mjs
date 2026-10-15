import module from 'node:module'

// O wrapper recebe respostas determinísticas sem iniciar ou encerrar serviços reais.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/autostart.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: `
const status = JSON.parse(process.env.PRUMO_TEST_DASHBOARD_STATUS);
const result = JSON.parse(process.env.PRUMO_TEST_DASHBOARD_RESULT ?? process.env.PRUMO_TEST_DASHBOARD_STATUS);
export const DASHBOARD_URL = 'http://localhost:4950';
export const DASHBOARD_ALIAS_URL = 'http://prumo:4950';
export const dashboardStatus = async () => status;
export const dashboardNeedsRepair = () => process.env.PRUMO_TEST_DASHBOARD_REPAIR === '1';
export const enableDashboard = async () => result;
export const disableDashboard = async () => result;
export const restartDashboard = async () => result;
import { appendFileSync } from 'node:fs';
export const stopDashboardForUpdate = async () => {
  if (process.env.PRUMO_TEST_STOP_LOG) appendFileSync(process.env.PRUMO_TEST_STOP_LOG, 'stop\\n');
  return { ok: true, stopped: status.process === 'running' };
};
export const readDashboardEvents = () => [];
export const runDashboardForeground = () => 0;
//# sourceURL=prumo-test://autostart-double
` }
} })
