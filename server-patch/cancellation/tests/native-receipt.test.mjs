import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './route-a1.test.mjs';
test('native receipt uses actual dispatchState acknowledgement and exact current attempt marker',async()=>{
 const f=fixture({nativeReceipt:true});const r=await f.run();assert.equal(r.cancelledStatusRunId,'active-run');assert.equal(f.committed.audits.at(-1).details.runOutcome,'confirmed');
});
