for await(const _ of process.stdin) {}
const mode=process.argv[2];
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
const m={role:'assistant',provider:'offline',model:'fixture',content:[{type:'text',text:'complete'}],stopReason:'stop'};
if(mode==='large-error') {m.stopReason='error';m.errorMessage='Deadline exceeded';}
if(mode==='malformed') process.stdout.write('PRIVATE_BAD_JSON\n');
else if(mode==='oversize') process.stdout.write('x'.repeat(8*1024*1024+1)+'\n');
else if(mode==='progress') {
 for(let i=0;i<300;i++) for(const type of ['turn_start','tool_execution_start','tool_execution_end','turn_end']) emit({type,toolName:'PRIVATE_TOOL',args:'PRIVATE_ARGS',result:'PRIVATE_RESULT'});
 emit({type:'PRIVATE_UNKNOWN'});
 emit({type:'agent_end',messages:[m],isTerminal:true});
} else emit({type:'agent_end',messages:[{role:'user',content:'PRIVATE_HISTORY'.repeat(90000)},m],isTerminal:true});
