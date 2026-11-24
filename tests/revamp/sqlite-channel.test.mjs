// Binary framing unit evidence only. These header patterns are not valid business databases or Native receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {childEnv} from '../../dist/server/security.js';
import {SQLITE_IMAGE_LIMIT,sqliteInputDescriptor,validateSqliteInputDescriptor,sqliteFrameHeader,SqliteFrameDecoder} from '../../dist/server/sqlite-channel.js';
const sha=body=>createHash('sha256').update(body).digest('hex'),binding={inputHash:'a'.repeat(64),expectedRevision:4};
function image(size=8192){const bytes=Buffer.alloc(size,10);Buffer.from('SQLite format 3\0').copy(bytes);bytes.writeUInt16BE(4096,16);bytes[18]=bytes[19]=1;return bytes;}
const frame=(result,body)=>sqliteFrameHeader(result,body,binding);
test('SQLite input descriptor binds exact binary length/hash and revision without accepting paths or authority',()=>{
 const body=image(),descriptor=sqliteInputDescriptor(body,binding);assert.equal(descriptor.imageBytes,body.length);assert.equal(descriptor.imageHash,sha(body));assert.deepEqual(validateSqliteInputDescriptor(descriptor),descriptor);
 for(const name of ['path','sql','worker','actor','verified','provider'])assert.throws(()=>validateSqliteInputDescriptor({...descriptor,[name]:'not-authorized'}));
 for(const patch of [{expectedRevision:-1},{expectedRevision:1.5},{imageBytes:SQLITE_IMAGE_LIMIT+1},{imageBytes:513},{imageHash:'not-hash'},{inputHash:'bad'},{schema:'guess'}])assert.throws(()=>validateSqliteInputDescriptor({...descriptor,...patch}));
 assert.equal(sqliteInputDescriptor(null,{...binding,expectedRevision:0}).imageBytes,0);assert.throws(()=>sqliteInputDescriptor(null,binding));assert.throws(()=>sqliteInputDescriptor(Buffer.from('SQLite-like prose'),binding));
});
test('binary frames survive split headers, arbitrary chunk boundaries and newlines within the image',()=>{
 const body=image(16384),meta={status:'UNIT_METADATA_ONLY'},header=frame(meta,body),wire=Buffer.concat([header,body]);
 for(const size of [1,7,127,65536]){const reader=new SqliteFrameDecoder(binding);for(let i=0;i<wire.length;i+=size)reader.push(wire.subarray(i,i+size));const result=reader.finish();assert.deepEqual(result.frame.result,meta);assert.deepEqual(result.image,body);assert.equal(result.frame.imageHash,sha(body));assert.throws(()=>reader.finish());}
});
test('a declared 64 MiB image is supported; limits and header growth are checked before accumulation',()=>{
 const body=image(SQLITE_IMAGE_LIMIT),reader=new SqliteFrameDecoder(binding);reader.push(frame({},body));for(let i=0;i<body.length;i+=65536)reader.push(body.subarray(i,i+65536));assert.equal(sha(reader.finish().image),sha(body));
 const oversized=new SqliteFrameDecoder(binding);assert.throws(()=>oversized.push(Buffer.alloc(2000001,32)),{code:'SQLITE_CHANNEL_METADATA_LIMIT'});
 const raw=JSON.parse(frame({},image()).toString()),large=new SqliteFrameDecoder(binding);assert.throws(()=>large.push(Buffer.from(JSON.stringify({...raw,imageBytes:SQLITE_IMAGE_LIMIT+512})+'\n')),{code:'SQLITE_CHANNEL_INVALID'});
});
test('truncated, extra, changed, invalid-header and foreign-bound frames never return an image',()=>{
 const body=image(),header=frame({},body);
 const truncated=new SqliteFrameDecoder(binding);truncated.push(header);truncated.push(body.subarray(0,-1));assert.throws(()=>truncated.finish(),{code:'SQLITE_CHANNEL_TRUNCATED'});
 const extra=new SqliteFrameDecoder(binding);extra.push(header);assert.throws(()=>extra.push(Buffer.concat([body,Buffer.of(1)])),{code:'SQLITE_CHANNEL_LENGTH_MISMATCH'});
 const changed=new SqliteFrameDecoder(binding);changed.push(header);const corrupt=Buffer.from(body);corrupt[100]^=1;changed.push(corrupt);assert.throws(()=>changed.finish(),{code:'SQLITE_CHANNEL_HASH_MISMATCH'});
 const raw=JSON.parse(header.toString());for(const patch of [{inputHash:'b'.repeat(64)},{expectedRevision:5},{path:'outside'},{schema:'dream-maker.wsl-result.v1'}]){const reader=new SqliteFrameDecoder(binding);assert.throws(()=>reader.push(Buffer.from(JSON.stringify({...raw,...patch})+'\n')));}
 const invalid=Buffer.from(body);invalid[0]=0;const bad=new SqliteFrameDecoder(binding);bad.push(Buffer.from(JSON.stringify({...raw,imageHash:sha(invalid)})+'\n'));bad.push(invalid);assert.throws(()=>bad.finish(),{code:'SQLITE_IMAGE_HEADER_INVALID'});
});
test('failed execution can carry only bounded metadata and no image; framing makes no execution or review claim',()=>{
 const result={status:'CANCELLED',cleanup:{unitOnly:true}},reader=new SqliteFrameDecoder(binding);reader.push(frame(result,null));assert.deepEqual(reader.finish(),{frame:{schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',...binding,imageBytes:0,imageHash:sha(Buffer.alloc(0)),result},image:null});
});

test('a bounded supervisor refusal retains its specific category without becoming an execution receipt',()=>{
 const reader=new SqliteFrameDecoder(binding);
 assert.throws(()=>reader.push(Buffer.from(JSON.stringify({schema:'dream-maker.wsl-supervisor-error.v1',code:'SQLITE_UNRELEASED_JOB_LIMIT'})+'\n')),{code:'SANDBOX_SUPERVISOR_SQLITE_UNRELEASED_JOB_LIMIT'});
 assert.throws(()=>reader.finish(),{code:'SQLITE_CHANNEL_CLOSED'});
});

test('binding subtypes cannot overwrite transport schema or leak their other fields into metadata',()=>{
 const body=image(),descriptor=sqliteInputDescriptor(body,binding),reader=new SqliteFrameDecoder(descriptor);
 reader.push(sqliteFrameHeader({},body,descriptor));reader.push(body);
 assert.equal(reader.finish().frame.schema,'dream-maker.sqlite-frame.v1');
 assert.deepEqual(sqliteInputDescriptor(body,{...descriptor,callerOnly:'ignore'}),descriptor);
});
for(const mode of ['prefix','image','binding'])test('transport retains original '+mode+' when the caller reuses its buffers or binding',()=>{
 const body=image(),original=Buffer.from(body),identity={...binding},reader=new SqliteFrameDecoder(identity),header=frame({},body),first=Buffer.from(header.subarray(0,20));
 if(mode==='binding')identity.inputHash='f'.repeat(64);
 reader.push(first);if(mode==='prefix')first.fill(0);reader.push(header.subarray(20));reader.push(body);if(mode==='image')body[100]^=1;
 const result=reader.finish();assert.deepEqual(result.image,original);assert.equal(result.frame.inputHash,binding.inputHash);assert.equal(sha(result.image),result.frame.imageHash);
});
test('one-byte fragmentation of a 1 MiB image has a bounded retained heap',()=>{
 const moduleUrl=pathToFileURL(resolve(import.meta.dirname,'../../dist/server/sqlite-channel.js')).href;
 const source=`import {SqliteFrameDecoder,sqliteFrameHeader} from ${JSON.stringify(moduleUrl)};
 const binding={inputHash:'a'.repeat(64),expectedRevision:4},body=Buffer.alloc(1048576,10);Buffer.from('SQLite format 3\\0').copy(body);body.writeUInt16BE(4096,16);body[18]=body[19]=1;
 const reader=new SqliteFrameDecoder(binding);reader.push(sqliteFrameHeader({},body,binding));global.gc();const before=process.memoryUsage().heapUsed;
 for(let i=0;i<body.length;i++)reader.push(body.subarray(i,i+1));global.gc();const growth=process.memoryUsage().heapUsed-before;
 if(growth>16777216)throw Error('SQLITE_CHANNEL_FRAGMENT_MEMORY_BUDGET_EXCEEDED '+growth);if(reader.finish().image.length!==body.length)throw Error('BAD_IMAGE_LENGTH');console.log(JSON.stringify({retainedHeapGrowth:growth}));`;
 const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',source],{cwd:process.cwd(),env:childEnv(),encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:128000});assert.equal(result.status,0,result.stderr);assert.ok(JSON.parse(result.stdout).retainedHeapGrowth<=16777216);
});
