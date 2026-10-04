// Native DSH regression: user/tool images and error recovery; no real account or network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, PROVIDER } from '../adapter.mjs';
import { PLAN_SCOPE } from '../oauth.mjs';
import { PiAiAdapter, responses, llm } from './runtime.mjs';
const require = createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json');
const [{ Context }, { LocalAttachmentStore }, retry] = await Promise.all([
  import(require.resolve('@deepseek-ai/cordis')),
  import(require.resolve('@deepseek-ai/dsh-attachment-local')),
  import(require.resolve('@deepseek-ai/dsh-llm-retry')),
]);
const home = await mkdtemp(join(tmpdir(), 'dsh-image-wire-test-'));
const oldFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected real network access'); };
const result = { network: 'mocked', credentials: 'synthetic', nativeDSH: true };
let attachmentContext;
try {
  attachmentContext = new Context();
  const attachments = new LocalAttachmentStore(attachmentContext, { dshHome: home });
  const ref = await attachments.saveImage({data: await readFile(new URL('../assets/icon.webp', import.meta.url)), mediaType:'image/webp', name:'public-test-icon.webp'});
  const accountPath = join(home, 'accounts.json');
  await writeFile(accountPath, JSON.stringify({ activeProfileId:'test', profiles:[{ id:'test',access_token:'offline-test',scopes:[PLAN_SCOPE],models:[{slug:'gpt-test',visibility:'list',input_modalities:['text','image'],context_window:128000}]}]}), {mode:0o600});
  let requests = 0, imageParts = 0;
  const auth = {
    store:{path:accountPath},generation:1,requestController:new AbortController(),
    access:async()=>({token:'offline-test'}),
    fetchInference:async (_profile, input, init) => {
      requests++;
      const body = JSON.parse(await new Request(input,init).text());
      const countImages = value => !value || typeof value !== 'object' ? 0 : (value.type === 'input_image' ? 1 : 0) + Object.values(value).reduce((n,child)=>n+countImages(child),0);
      imageParts += countImages(body.input);
      const output=[{type:'message',id:'msg_offline',role:'assistant',status:'completed',content:[{type:'output_text',text:'IMAGE_OK',annotations:[]}]}];
      const events=[
        {type:'response.created',response:{id:'resp_offline',model:'gpt-test',output:[]}},
        {type:'response.output_item.added',output_index:0,item:{...output[0],status:'in_progress',content:[]}},
        {type:'response.content_part.added',item_id:'msg_offline',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
        {type:'response.output_text.delta',item_id:'msg_offline',output_index:0,content_index:0,delta:'IMAGE_OK'},
        {type:'response.output_item.done',output_index:0,item:output[0]},
        {type:'response.completed',response:{id:'resp_offline',model:'gpt-test',status:'completed',output,usage:{input_tokens:10,output_tokens:2,total_tokens:12}}},
      ];
      return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    },
  };
  const ctx={get:name=>name==='attachments'?attachments:name==='fs'?{processPathFromHostPath:p=>p}:undefined};
  const args={provider:PROVIDER,model:'gpt-test',tools:[],messages:[llm.createUserMessage({content:[{type:'text',text:'Offline image test'},{type:'image',attachment:ref}],source:{kind:'user'}})]};
  async function collect(adapter) {const chunks=[];for await(const c of adapter.stream(args))chunks.push(c);return chunks;}
  const adapter=createAdapter({PiAiAdapter,responses,resolveImageAttachmentAccess:llm.resolveImageAttachmentAccess,resolveRetryPolicy:llm.resolveRetryPolicy},auth,ctx);
  async function check(messages) {
    const chunks=await collect({stream:options=>adapter.stream({...options,messages})});
    assert.equal(chunks.find(x=>x.type==='finish')?.reason.kind,'stop');
    assert.equal(chunks.filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'IMAGE_OK');
  }
  await check(args.messages);
  assert.equal(imageParts,1);
  const callId='call_image_probe';
  const history=[
    llm.createUserMessage({content:[{type:'text',text:'Read the supplied image.'}],source:{kind:'user'}}),
    llm.createAssistantMessage({content:[{type:'tool-call',id:callId,name:'read_image',arguments:'{}'}],source:{provider:PROVIDER,model:'gpt-test'}}),
    llm.createMessage({role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:'Image read successfully.'},{type:'image',attachment:ref}]}),
  ];
  await check(history);
  assert.equal(requests,2);
  assert.equal(imageParts,2);
  result.userAndToolImages={requests,imageParts};
  const before=requests;
  const badImage={...ref,attachmentId:'invalid'};
  await assert.rejects(check([llm.createUserMessage({content:[{type:'image',attachment:badImage}],source:{kind:'user'}})]),/Attachment reference is invalid/);
  assert.equal(requests,before);
  result.invalidAttachmentRejectedBeforeNetwork=true;
  const listeners=new Map(), events=[];
  let retryState={};
  retry.apply({sessionProjections:{register(){},stateOf:()=>retryState},on:(name,fn)=>{listeners.set(name,fn);return()=>{}},effect(){}},{});
  const policy=adapter.providerRetryPolicy(PROVIDER);
  assert.ok(Object.isFrozen(policy));
  assert.ok(policy.retryableCodes.includes('SERVER'));
  assert.ok(Number.isFinite(policy.initialDelayMs));
  assert.ok(Number.isFinite(policy.maxDelayMs));
  assert.ok(Number.isFinite(policy.jitterRatio));
  assert.equal(policy.maxRetries,2);
  const payload={agent:{session:{append:(type,data)=>{events.push({type,data});if(type==='llm/retry')retryState[JSON.stringify([PROVIDER,data.policyKey])]={retry:data.retry,retryId:data.retryId};}}},turn:1,step:1,provider:PROVIDER,failure:{message:'Attachment reference is invalid.',code:'UNKNOWN'},retryPolicy:policy,signal:new AbortController().signal};
  let forwarded=0;
  const next=async()=>{forwarded++;};
  await listeners.get('agent/request-error')(payload,next);
  assert.equal(forwarded,1);
  assert.equal(events.length,0);
  const retryPayload={...payload,failure:{message:'Mock server failure',code:'SERVER'},retryPolicy:{...policy,initialDelayMs:0,maxDelayMs:0,jitterRatio:0}};
  for(let i=0;i<2;i++)assert.deepEqual(await listeners.get('agent/request-error')(retryPayload,next),{kind:'retry'});
  await listeners.get('agent/request-error')(retryPayload,next);
  assert.equal(forwarded,2);
  assert.deepEqual(events.filter(e=>e.type==='llm/retry').map(e=>e.data.retry),[1,2]);
  result.retryPolicy={originalFailurePreserved:true,retries:2,limitEnforced:true};
  result.success=true;
  console.log(JSON.stringify(result,null,2));
} finally {
  globalThis.fetch=oldFetch;
  await attachmentContext?.scope?.dispose?.();
  await rm(home,{recursive:true,force:true});
}
