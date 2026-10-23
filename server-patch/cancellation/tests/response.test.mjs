import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.REVIEW_CANCEL_SOURCE,'utf8');
const start=source.indexOf('        const changes = issueResponse.changes');
const end=source.indexOf('\n    });',start);
for(const minimal of [false,true])test(`response projection preserves cancellation reconciliation minimal=${minimal}`,()=>{
 const outcome={goalOutcome:'unknown',runOutcome:'already_terminal',auditRecorded:false};let response;
 const run=Function('issueResponse','cancellationStopOutcome','req','res','prefersMinimalIssueUpdateResponse','comment',source.slice(start,end));
 run({id:'issue',status:'cancelled'},outcome,{}, {setHeader(){},json(v){response=v;}},()=>minimal,null);
 assert.deepEqual(response.cancellationStop,outcome);
});
