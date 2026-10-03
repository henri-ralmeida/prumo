import module from 'node:module'

// O wrapper é verificado sem instalar pacotes globais ou acessar um registro externo.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/update.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: `
import { unlinkSync } from 'node:fs';
const state = JSON.parse(process.env.PRUMO_TEST_GLOBAL_STATE);
export const assertUpdateVersion = () => {};
export const globalCliState = () => state;
export const globalCliContentCurrent = () => true;
export const ensureGlobalCliContent = async () => {
  if (process.env.PRUMO_TEST_UPDATE_FAILURE === 'refresh') throw new Error('refresh negado');
  if (process.env.PRUMO_TEST_REFRESH_READ_FAILURE === '1') process.env.PRUMO_TEST_READ_FAILURE_ACTIVE = '1';
  if (process.env.PRUMO_TEST_REPORT_REFRESH === '1') console.log('refresh solicitado');
  return state;
};
export const updateGlobalCliFromPackage = async () => {
  if (process.env.PRUMO_TEST_UPDATE_FAILURE === 'install') throw new Error('instalação global negada');
  if (process.env.PRUMO_TEST_MARKER_REMOVED) unlinkSync(process.env.PRUMO_TEST_MARKER_REMOVED);
  return state;
};
export const updateRequest = value => JSON.parse(value);
export const reconcileDashboardUpdate = async () => ({ ok: true, status: {} });
export const launchUpdate = async (request, callbacks) => {
  if (process.env.PRUMO_TEST_LAUNCH_MODE === 'absent') return null;
  if (process.env.PRUMO_TEST_LAUNCH_MODE === 'error') throw new Error('verificação externa indisponível');
  if (process.env.PRUMO_TEST_LAUNCH_MODE === 'repair-error') throw Object.assign(new Error('serviço falhou'), { dashboardFailure: 'serviço negado' });
  callbacks.onDashboardRepair(false);
  return 0;
};
//# sourceURL=prumo-test://update-double
` }
} })
