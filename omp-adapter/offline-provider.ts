// Test-only provider: no network, real OMP owns agent loop and JSON serialization.
import { createAssistantMessageEventStream } from '@oh-my-pi/pi-ai';
export default function(pi: any) {
  pi.registerProvider('adapter-offline', {
    api: 'adapter-offline-api', baseUrl: 'http://offline.invalid', apiKey: 'offline-placeholder',
    models: [{id:'fixture',name:'Offline fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}],
    streamSimple: (_model: any, context: any) => {
      const stream=createAssistantMessageEventStream();
      const mode=process.env.OMP_OFFLINE_CASE;
      const hasTool=context.messages.some((m: any)=>m.role==='toolResult');
      const failure=mode==='provider-error';
      const tool=mode==='tool-error'&&!hasTool;
      const message={role:'assistant',api:'adapter-offline-api',provider:'adapter-offline',model:'fixture',timestamp:1,
        content:tool?[{type:'toolCall',id:'offline-tool',name:'offline_failure',arguments:{}}]:failure?[]:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text:'offline native complete'}],
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        stopReason:failure?'error':tool?'toolUse':'stop',...(failure?{errorMessage:'Offline provider rejected request'}:{})};
      stream.push({type:'start',partial:message});
      if(tool) {
        stream.push({type:'toolcall_start',contentIndex:0,partial:message});
        stream.push({type:'toolcall_end',contentIndex:0,toolCall:message.content[0],partial:message});
      }
      stream.push(failure?{type:'error',reason:'error',error:message}:{type:'done',reason:message.stopReason,message});
      stream.end(); return stream;
    },
  });
  pi.registerTool({name:'offline_failure',label:'Offline failure',description:'Deterministic test tool failure',parameters:{type:'object',properties:{}},execute:async()=>{throw new Error('RAW_TOOL_FAILURE');}});
}
