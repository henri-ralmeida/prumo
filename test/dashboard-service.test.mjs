import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { readDashboardErrors, readDashboardEvents, openDashboardErrorLog } from '../scripts/dashboard-diagnostics.mjs'
const launcher=fileURLToPath(new URL('../scripts/dashboard-service.mjs',import.meta.url))
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'prumo-service-log-'))
  t.after(()=>rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
  const env={...process.env,HOME:home,USERPROFILE:home,PRUMO_DASHBOARD_RESTART_LIMIT:'0'}
  return {home,env}
}
function run(env,args) {
  const child=spawn(process.execPath,[launcher,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d)
  const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}))})
  return {child,result}
}
test('lancador conserva stderr nativo e codigo de saida sem depender de hooks do servidor', async t=>{
  const f=fixture(t), child=run(f.env,['-e',"require('node:fs').writeSync(2,'falha nativa de teste\\n');process.exit(7)"])
  assert.equal((await child.result).code,7)
  assert.match(readDashboardErrors({home:f.home}),/falha nativa de teste/)
  const events=readDashboardEvents({home:f.home})
  assert.ok(events.some(e=>e.event==='process-started'&&e.pid))
  assert.ok(events.some(e=>e.event==='process-exit'&&e.code===7))
})
test('lancador preserva stack de excecao e erro de carregamento', async t=>{
  for(const args of [['-e',"throw new Error('falha inesperada isolada')"],[join(tmpdir(),'prumo-modulo-inexistente.mjs')]]){
    const f=fixture(t), {result}=run(f.env,args)
    assert.equal((await result).code,1)
    assert.match(readDashboardErrors({home:f.home}),args[0]==='-e'?/falha inesperada isolada/:/MODULE_NOT_FOUND/)
  }
})
test('encerramento forcado registra resultado sem inventar uma excecao', async t=>{
  const f=fixture(t), {child,result}=run(f.env,['-e',"console.log('pid='+process.pid);setInterval(()=>{},1000)"])
  const worker=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('processo isolado nao iniciou')),10000);child.stdout.on('data',d=>{const match=String(d).match(/pid=(\d+)/);if(match){clearTimeout(timeout);resolve(Number(match[1]))}});child.once('error',reject)})
  t.after(() => { if (child.exitCode === null) { try { process.kill(worker, 'SIGKILL') } catch {} child.kill() } })
  process.kill(worker,'SIGKILL')
  const ended=await result
  assert.notEqual(ended.code,0)
  const exit=readDashboardEvents({home:f.home}).find(e=>e.event==='process-exit')
  assert.ok(exit);assert.ok(exit.signal||exit.code!==0)
  assert.equal(readDashboardErrors({home:f.home}),'')
})
test('leitura de stderr limita memoria e preserva arquivo anterior na rotacao', t=>{
  const f=fixture(t), dir=join(f.home,'.local/share/prumo');mkdirSync(dir,{recursive:true})
  assert.equal(readDashboardErrors({home:f.home}),'')
  const file=join(dir,'dashboard-stderr.log')
  writeFileSync(file,'x'.repeat(262145)+'erro anterior')
  closeSync(openDashboardErrorLog({home:f.home}))
  writeFileSync(file,'erro atual')
  const errors=readDashboardErrors({home:f.home})
  assert.ok(errors.length<=32769);assert.match(errors,/erro anterior/);assert.match(errors,/erro atual/)
  assert.ok(readFileSync(file+'.previous','utf8').endsWith('erro anterior'))
})
test('falha ao gravar log nao impede o processo e mantém stderr do chamador', async t=>{
  const f=fixture(t);writeFileSync(join(f.home,'.local'),'diretorio indisponivel')
  const {result}=run(f.env,['-e',"console.error('erro preservado no terminal')"])
  const completed=await result;assert.equal(completed.code,0);assert.match(completed.stderr,/erro preservado no terminal/)
})


test('falha do sistema ao iniciar filho fica no historico de diagnostico', async t=>{
  const f=fixture(t), preload=join(f.home,'falha-spawn.mjs')
  writeFileSync(preload, "import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; const spawn = childProcess.spawn; childProcess.spawn = (...args) => spawn('prumo-executavel-ausente', args[1], args[2]); syncBuiltinESMExports();")
  const {result}=run({...f.env,NODE_OPTIONS:(f.env.NODE_OPTIONS??'')+' --import='+JSON.stringify(pathToFileURL(preload).href)},['-e','process.exit(0)'])
  assert.equal((await result).code,1)
  assert.ok(readDashboardEvents({home:f.home}).some(e=>e.event==='launch-error'&&e.code==='ENOENT'))
})
test('lancador recria o processo depois de uma queda inesperada e registra o reinicio', async t=>{
  const f=fixture(t), marker=join(f.home,'primeira-queda')
  const env={...f.env};delete env.PRUMO_DASHBOARD_RESTART_LIMIT
  const {result}=run(env,['-e',"const fs=require('node:fs');if(!fs.existsSync(process.argv[1])){fs.writeFileSync(process.argv[1],'x');process.exit(3)}",marker])
  assert.equal((await result).code,0)
  const events=readDashboardEvents({home:f.home}).map(e=>e.event)
  assert.deepEqual(events.filter(e=>e==='process-started'),['process-started','process-started'])
  assert.deepEqual(readDashboardEvents({home:f.home}).filter(e=>e.event==='process-exit').map(e=>e.code),[3,0])
  assert.ok(events.includes('restart-scheduled'));assert.ok(events.includes('process-restart'))
})
test('lancador nao recria o processo depois de disable ou de um pedido de reinicio', async t=>{
  const disabled=fixture(t), directory=join(disabled.home,'.local/share/prumo');mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,'dashboard.json'),JSON.stringify({enabled:false}))
  const env={...disabled.env};delete env.PRUMO_DASHBOARD_RESTART_LIMIT
  assert.equal((await run(env,['-e','process.exit(3)']).result).code,3)
  const first=readDashboardEvents({home:disabled.home}).map(e=>e.event)
  assert.deepEqual(first.filter(e=>e==='process-started'),['process-started'])
  assert.ok(!first.some(e=>e.startsWith('restart-')||e==='process-restart'))
  const requested=fixture(t), requestedEnv={...requested.env};delete requestedEnv.PRUMO_DASHBOARD_RESTART_LIMIT
  const script="const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const dir=path.join(os.homedir(),'.local','share','prumo');fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'dashboard-events.ndjson'),JSON.stringify({at:new Date().toISOString(),event:'restart-requested'})+String.fromCharCode(10));process.exit(3)"
  assert.equal((await run(requestedEnv,['-e',script]).result).code,3)
  const second=readDashboardEvents({home:requested.home}).map(e=>e.event)
  assert.deepEqual(second.filter(e=>e==='process-started'),['process-started'])
  assert.ok(!second.some(e=>e.startsWith('restart-scheduled')||e==='process-restart'))
})
test('PRUMO_DASHBOARD_RESTART_LIMIT=0 mantem a saida sem recriar o processo', async t=>{
  const f=fixture(t)
  assert.equal((await run(f.env,['-e','process.exit(3)']).result).code,3)
  assert.ok(!readDashboardEvents({home:f.home}).some(e=>e.event==='restart-scheduled'))
})
