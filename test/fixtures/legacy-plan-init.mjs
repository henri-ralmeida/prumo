import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// Casos de compatibilidade precisam de um registro legado, não de permissão para criar IDs novos inválidos.
export function initializeLegacyPlanFixture(cli, planPath, root, run) {
  const plan=JSON.parse(readFileSync(planPath,'utf8'));
  const taskIds=Object.fromEntries(plan.tasks.map((task,index)=>[task.id,'T'+(index+1)]));
  const phases=Object.fromEntries((plan.phases??[]).map((phase,index)=>[phase.id,'F'+(index+1)]));
  const taskOriginal=Object.fromEntries(Object.entries(taskIds).map(([old,id])=>[id,old]));
  const phaseOriginal=Object.fromEntries(Object.entries(phases).map(([old,id])=>[id,old]));
  const canonical={...plan,...(plan.phases?{phases:plan.phases.map(phase=>({...phase,id:phases[phase.id]}))}:{}),
    tasks:plan.tasks.map(task=>({...task,id:taskIds[task.id],deps:(task.deps??[]).map(id=>taskIds[id]??id),
      ...(task.phase?{phase:phases[task.phase]??task.phase}:{})}))};
  const canonicalPath=planPath+'.canonical.json';writeFileSync(canonicalPath,JSON.stringify(canonical));
  const result=cli('init','--plan',canonicalPath,'--run',run);
  if(result.status!==0)return result;
  const file=join(root,'.specs/graph',run,'state.json'),state=JSON.parse(readFileSync(file,'utf8'));
  state.tasks=Object.fromEntries(Object.entries(state.tasks).map(([id,task])=>[taskOriginal[id],{...task,id:taskOriginal[id],deps:task.deps.map(dep=>taskOriginal[dep]??dep),phase:phaseOriginal[task.phase]??task.phase}]));
  state.plan.source=planPath;
  if(plan.phases)state.plan.phases=plan.phases;
  if(state.phaseWorkflows)state.phaseWorkflows=Object.fromEntries(Object.entries(state.phaseWorkflows).map(([id,phase])=>[phaseOriginal[id],{...phase,id:phaseOriginal[id]}]));
  writeFileSync(file,JSON.stringify(state));
  return result;
}
