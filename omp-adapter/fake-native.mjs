// Synthetic edge cases around the synthetic native protocol contract. No OMP/model call.
import {spawn} from 'node:child_process';
let stdin='';for await(const chunk of process.stdin) stdin+=chunk;
const mode=process.argv[2]?.replace('fixture:','');
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
const modelArg=process.argv.indexOf('--model');
const selected=modelArg<0?'default/fixture':process.argv[modelArg+1];
const slash=selected.indexOf('/');
const provider=slash<0?'default':selected.slice(0,slash), model=slash<0?selected:selected.slice(slash+1);
const assistant=(text,stop='stop')=>({role:'assistant',provider,model,content:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text}],stopReason:stop});
const terminal=(text,stop='stop',extra={})=>emit({type:'agent_end',messages:[assistant(text,stop)],isTerminal:true,...extra});
if(mode==='hang') {
 process.on('SIGTERM',()=>{});
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
 terminal(JSON.stringify({pid:process.pid,descendant:child.pid}));
 await new Promise(()=>setInterval(()=>{},1000));
}
if(mode==='malformed') process.stdout.write('not json\n');
else if(mode==='missing-provider'||mode==='missing-model'||mode==='blank-provider'||mode==='blank-model') {
 const message=assistant('identity fixture');
 const field=mode.endsWith('provider')?'provider':'model';
 if(mode.startsWith('missing')) delete message[field];else message[field]='';
 emit({type:'agent_end',messages:[message],isTerminal:true});
}
else if(mode==='inherited-secret'||mode==='inherited-secret-error') emit({type:'agent_end',messages:[{...assistant('public '+process.env.REVIEW_PROBE_TOKEN,mode==='inherited-secret-error'?'error':'stop'),errorMessage:'provider '+process.env.REVIEW_PROBE_TOKEN}],isTerminal:true});
else if(mode==='long') terminal('a'.repeat(1024*1024+1));
else if(mode==='missing-stop') emit({type:'agent_start'});
else if(mode==='truncated') process.stdout.write(JSON.stringify({type:'agent_end',messages:[assistant('truncated')]}));
else if(mode==='enrichment') {
 const e=process.env, dir=e.PAPERCLIP_RUN_SCRATCH_DIR;
 const checks={scratch:['PAPERCLIP_TASK_SCRATCH_DIR','PAPERCLIP_SCRATCH_DIR','PAPERCLIP_TMPDIR','TMPDIR','TMP','TEMP'].every(k=>e[k]===dir),identity:e.PAPERCLIP_AGENT_ID==='offline-agent'&&e.PAPERCLIP_COMPANY_ID==='offline-company'&&e.PAPERCLIP_RUN_ID==='offline-enrichment-run'&&e.PAPERCLIP_API_KEY==='synthetic-run-fixture',managed:e.GIT_CONFIG_GLOBAL==='/dev/null'&&e.GIT_TERMINAL_PROMPT==='0'&&e.GH_TOKEN===''&&e.PAPERCLIP_GITHUB_BROKER_TOKEN==='synthetic-broker-fixture',launcher:e.ZDOTDIR===e.PAPERCLIP_GITHUB_LAUNCHER_DIR&&e.BASH_ENV===e.ZDOTDIR+'/.bashrc'&&e.GH_CONFIG_DIR===e.ZDOTDIR+'/gh-config'&&e.PATH.startsWith(e.ZDOTDIR+':')};
 terminal(JSON.stringify(checks));
}
else if(mode==='identity') terminal(JSON.stringify({taskId:process.env.PAPERCLIP_TASK_ID,wakeReason:process.env.PAPERCLIP_WAKE_REASON,toolsTokenReceived:process.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN==='offline-tools-token'}));
else if(mode==='secrets') {
 emit({type:'tool_execution_end',result:'RAW_TOOL',isError:false});
 process.stderr.write('RAW_STDERR '+process.env.TEST_CREDENTIAL_TOKEN);
 const secret=process.env.TEST_CREDENTIAL_TOKEN??'not-provided';
 const event=JSON.stringify({type:'agent_end',messages:[assistant('\x1b[31mreceived-env:'+String(secret==='offline-fixture-secret'&&process.env.PAPERCLIP_API_KEY==='offline-run-auth')+'\x1b[0m '+secret+' '+process.env.PAPERCLIP_API_KEY)],isTerminal:true})+'\n';
 const cut=event.indexOf(secret)+8;process.stdout.write(event.slice(0,cut));await new Promise(r=>setTimeout(r,10));process.stdout.write(event.slice(cut));
} else if(mode==='error') emit({type:'agent_end',messages:[{...assistant('','error'),errorMessage:'offline failure '+process.env.TEST_CREDENTIAL_TOKEN}],isTerminal:true});
else {
 if(mode==='event-cap') for(let i=0;i<50001;i++) emit({type:'agent_start'});
 terminal(mode==='empty'?'':mode==='error-prose'?'HTTP 400 was fixed successfully':JSON.stringify({argv:process.argv.slice(3),stdin}),['length','toolUse','aborted'].includes(mode)?mode:mode==='bad-stop'?'unknown':'stop',mode==='nonterminal'?{isTerminal:false}:mode==='continuing'?{willContinue:true}:{});
 if(mode==='duplicate-stop') terminal('duplicate');
 if(mode==='after-stop') emit({type:'agent_start'});
}
if(mode==='nonzero') process.exitCode=7;
