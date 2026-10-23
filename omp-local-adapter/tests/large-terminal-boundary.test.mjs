// Post-fix regression coverage, not claimed as original RED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOmpOutputParser, DEFAULT_MAX_TERMINAL_LINE_BYTES } from '../output-parser.mjs';
const event = (extra = {}) => ({ type: 'agent_end', isTerminal: true, messages: [{role:'toolResult',content:'x'.repeat(1100000)}, {role:'assistant', content:[{type:'text',text:'done'}],stopReason:'stop'}], ...extra });
const wire = x => JSON.stringify(x)+'\n';
function parse(s, limits) { const p=createOmpOutputParser(limits); const b=Buffer.from(s); for(let i=0;i<b.length;i+=65521)p.feed(b.subarray(i,i+65521)); return p.end(); }
test('large envelope accepts complete terminal at exact 8MiB boundary',()=>{
  const e=event(); e.messages[0].content=''; e.messages[0].content='x'.repeat(DEFAULT_MAX_TERMINAL_LINE_BYTES-Buffer.byteLength(JSON.stringify(e)));
  const r=parse(wire(e)); assert.deepEqual(r.damage,[]); assert.equal(r.final.isTerminal,true);
});
test('ordinary, continuing, and unmarked large events retain 1MiB rejection',()=>{
  for(const e of [event({type:'message_update'}),event({willContinue:true}),event({isTerminal:false}),event({isTerminal:undefined})]) {
    const r=parse(wire(e)); assert.ok(r.damage.includes('oversized_lines')); assert.equal(r.final,null);
  }
});
test('caller explicit line cap remains strict',()=>{
  const r=parse(wire(event()),{maxLineBytes:1024*1024}); assert.deepEqual(r.damage,['oversized_lines']);
});
test('terminal above 8MiB remains oversized',()=>{
  const e=event(); e.messages[0].content='x'.repeat(DEFAULT_MAX_TERMINAL_LINE_BYTES);
  const r=parse(wire(e)); assert.ok(r.damage.includes('oversized_lines')); assert.equal(r.final,null);
});
test('large terminal truncated/malformed/late/duplicate remain untrusted',()=>{
  assert.ok(parse(wire(event()).slice(0,-1)).damage.includes('truncated_tail'));
  assert.ok(parse(wire(event())+'{broken\n').damage.includes('malformed_lines'));
  const late=parse(wire(event())+wire({type:'turn_start'})); assert.equal(late.final,null); assert.equal(late.finalsInvalidated,1);
  assert.equal(parse(wire(event())+wire(event())).finalsInvalidated,1);
});
