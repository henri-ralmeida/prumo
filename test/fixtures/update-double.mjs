import module from 'node:module'

// O wrapper é verificado sem instalar pacotes globais ou acessar um registro externo.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/update.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: `
import { unlinkSync, appendFileSync, readFileSync } from 'node:fs';
const state = JSON.parse(process.env.PRUMO_TEST_GLOBAL_STATE);
export const assertUpdateVersion = () => {};
export const globalCliState = () => state;
export const globalCliContentCurrent = () => process.env.PRUMO_TEST_GLOBAL_CURRENT !== '0';
export const ensureGlobalCliContent = async () => {
  if (process.env.PRUMO_TEST_UPDATE_FAILURE === 'refresh') throw new Error('refresh negado');
  if (process.env.PRUMO_TEST_REFRESH_READ_FAILURE === '1') process.env.PRUMO_TEST_READ_FAILURE_ACTIVE = '1';
  if (process.env.PRUMO_TEST_REPORT_REFRESH === '1') console.log('refresh solicitado');
  return state;
};
export const updateGlobalCliFromPackage = async (_root, options = {}) => {
  await options.beforeInstall?.();
  if (process.env.PRUMO_TEST_UPDATE_STAGE_LOG) appendFileSync(process.env.PRUMO_TEST_UPDATE_STAGE_LOG, 'global\\n');
  if (process.env.PRUMO_TEST_UPDATE_FAILURE === 'install') throw new Error('instalação global negada');
  if (process.env.PRUMO_TEST_MARKER_REMOVED) unlinkSync(process.env.PRUMO_TEST_MARKER_REMOVED);
  return state;
};
export const updateRequest = value => JSON.parse(value);
export const reconcileDashboardUpdate = async () => {
  if (process.env.PRUMO_TEST_UPDATE_STAGE_LOG) {
    const lang = process.env.PRUMO_TEST_OBSERVE_MARKER ? JSON.parse(readFileSync(process.env.PRUMO_TEST_OBSERVE_MARKER)).lang : '';
    appendFileSync(process.env.PRUMO_TEST_UPDATE_STAGE_LOG, 'reconcile:' + lang + '\\n');
  }
  return process.env.PRUMO_TEST_RECONCILE_FAILURE === '1' ? { ok: false, status: process.env.PRUMO_TEST_RECONCILE_STATUS ? JSON.parse(process.env.PRUMO_TEST_RECONCILE_STATUS) : { error: 'recuperação negada' } } : { ok: true, status: {} };
};
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
