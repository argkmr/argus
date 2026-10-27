import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { drainJavaBackend, stopChild, stopRecordedJava } from "../desktop/shutdown.mjs";

test("stale JVM shutdown validates the recorded executable and waits without force-killing", async () => {
  const record={pid:123,jar:"/Applications/Argus.app/Contents/Resources/backend/argus-backend.jar"};
  const command=`java -jar ${record.jar}`; let current=command,clock=0;const signals=[];
  await stopRecordedJava(record,{readCommand:()=>current,signal:(...args)=>signals.push(args),now:()=>clock,sleep:async()=>{clock+=100;current="";}});
  assert.deepEqual(signals,[[123,"SIGTERM"]]);assert.equal(clock,100);
  await stopRecordedJava(record,{readCommand:()=>"java -jar /other/service.jar",signal:()=>assert.fail("unowned JVM")});
  await assert.rejects(stopRecordedJava(record,{readCommand:()=>command,signal:()=>{},now:()=>clock,sleep:async()=>{clock+=100;},timeoutMs:100}),/still shutting down/);
});

test("Java shutdown handles instant exit and waits for forced termination", async () => {
  for (const stubborn of [false, true]) {
    const child = new EventEmitter(); const signals = [];
    child.kill = (signal) => { signals.push(signal); if (!stubborn || signal === "SIGKILL") { child.signalCode = signal; child.emit("exit"); } };
    await stopChild(child, { gracefulMs: 5, forceMs: 5 });
    assert.deepEqual(signals, stubborn ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
    assert.equal(child.listenerCount("exit"), 0);
  }
  const never = new EventEmitter(); never.kill = () => {};
  await assert.rejects(stopChild(never, { gracefulMs: 5, forceMs: 5 }), /did not exit/);
});

test("Java-only desktop waits for authenticated Java quiescence before stopping it", async () => {
  const events = [];
  await drainJavaBackend({ child: new EventEmitter(), baseUrl: "http://127.0.0.1:12345", token: "fixture-only",
    fetchImpl: async (url, options) => {
      assert.equal(url,"http://127.0.0.1:12345/api/internal/maintenance/shutdown");
      assert.equal(options.headers.authorization,"Bearer fixture-only");
      assert.equal(options.headers.origin,undefined);events.push("drain");
      return {ok:true,json:async()=>({ok:true})};
    }, stopImpl: async () => { events.push("stop"); },
  });
  assert.deepEqual(events,["drain","stop"]);
});

test("failed drain never authorizes process termination or destructive reset", async () => {
  for(const result of [{ok:false,error:"restore active"},{ok:false,error:"worker still alive"}]) {
    let stopped=false;
    await assert.rejects(drainJavaBackend({ child:new EventEmitter(),baseUrl:"http://127.0.0.1:12345",token:"fixture-only",
      fetchImpl:async()=>({ok:false,json:async()=>result}),stopImpl:async()=>{stopped=true;},
    }),new RegExp(result.error));assert.equal(stopped,false);
  }
});

test("dead child does not need HTTP quiescence", async () => {
  const child=new EventEmitter();child.exitCode=0;
  await drainJavaBackend({child,fetchImpl:()=>{throw new Error("not called");}});
});
