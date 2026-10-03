import module from 'node:module'

// O wrapper recebe respostas determinísticas sem iniciar ou encerrar serviços reais.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/autostart.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: `
const status = JSON.parse(process.env.PRUMO_TEST_DASHBOARD_STATUS);
const result = JSON.parse(process.env.PRUMO_TEST_DASHBOARD_RESULT ?? process.env.PRUMO_TEST_DASHBOARD_STATUS);
export const dashboardStatus = async () => status;
export const dashboardNeedsRepair = () => process.env.PRUMO_TEST_DASHBOARD_REPAIR === '1';
export const enableDashboard = async () => result;
export const disableDashboard = async () => result;
export const restartDashboard = async () => result;
export const stopDashboardForUpdate = async () => ({ ok: true, stopped: status.process === 'running' });
export const readDashboardEvents = () => [];
export const runDashboardForeground = () => 0;
//# sourceURL=prumo-test://autostart-double
` }
} })
