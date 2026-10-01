// 中文注释：机械基准的成功样本汇总可离线验证，不依赖浏览器。
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(p*sorted.length)-1];
}

export function summarize(samples) {
  return Object.fromEntries(Object.entries(samples).map(([name, rows])=>{
    const successful=rows.filter(row=>row.success);
    const times=successful.map(row=>row.durationMs);
    return [name,{attempts:rows.length,successes:successful.length,successRate:successful.length/rows.length,
      p50Ms:percentile(times,.5),p90Ms:percentile(times,.9),maxMs:times.length?Math.max(...times):null,
      errorCodes:Object.fromEntries([...new Set(rows.map(row=>row.code).filter(Boolean))].map(code=>[code,rows.filter(row=>row.code===code).length])),samples:rows}];
  }));
}
