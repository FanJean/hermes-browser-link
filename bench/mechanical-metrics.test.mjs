// 中文注释：新旧机械指标共用 nearest-rank 汇总，失败样本不进入耗时分位数。
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarize} from './mechanical-metrics.mjs';

test('同站与四页指标保留 N 轮样本及 p50/p90',()=>{
  const samples={};
  for(const name of ['same_site_navigate','same_site_new_task','four_pages_sequential','four_pages_parallel']){
    samples[name]=[10,20,30,40,50].map(durationMs=>({durationMs,success:true,code:null}));
    samples[name].push({durationMs:1000,success:false,code:'timeout'});
  }
  for(const result of Object.values(summarize(samples))){
    assert.equal(result.attempts,6);
    assert.equal(result.successes,5);
    assert.equal(result.p50Ms,30);
    assert.equal(result.p90Ms,50);
    assert.deepEqual(result.errorCodes,{timeout:1});
  }
});
