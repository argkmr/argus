// Package outside File Provider / synced source folders. FinderInfo attached to
// a .app inside those folders can invalidate an otherwise valid code signature.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {releaseArtifactNames} from './finalize-mac-release.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('macOS packaging requires macOS.');
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const names=releaseArtifactNames(metadata),staging=await fs.mkdtemp(path.join(os.tmpdir(),'argus-macos-release-'));
console.log('Isolated macOS release staging: '+staging);
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--mac','--arm64','--config.directories.output='+staging],{cwd:root,env:process.env,stdio:'inherit'});
  child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error('macOS packaging failed ('+(signal||code)+'); staging retained at '+staging)));
});
const app=path.join(staging,'mac-arm64',metadata.build.productName+'.app');
// Verification must precede publication into the normal dist folder.
await new Promise((resolve,reject)=>{
  const child=spawn('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Packaged application signature verification failed.')));
});
const destination=path.join(root,'dist');await fs.mkdir(destination,{recursive:true});
for(const suffix of ['', '.blockmap']){
  const source=path.join(staging,names.generated+suffix);
  try{await fs.access(source);}catch(error){if(suffix&&error.code==='ENOENT')continue;throw error;}
  const target=path.join(destination,names.generated+suffix);
  await fs.copyFile(source,target+'.packaging');await fs.rename(target+'.packaging',target);
}
const receipt=path.join(root,'output/release');await fs.mkdir(receipt,{recursive:true});
await fs.writeFile(path.join(receipt,'macos-staging-'+metadata.argusBuild+'.json'),JSON.stringify({build:metadata.argusBuild,staging,app},null,2)+'\n');
console.log('Verified macOS app staged at '+app);
