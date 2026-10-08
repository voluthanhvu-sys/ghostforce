export const fmtTs = (s?: number) => { if (s == null || !Number.isFinite(s)) return '—'; const m=Math.floor(s/60); const sec=(s%60).toFixed(1).padStart(4,'0'); return `${m}:${sec}`; };
export const fmtDur = (start?: number,end?: number) => start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) ? '—' : fmtTs(Math.max(0,end-start));
export const formatBytes=(bytes:number,decimals=2)=>{ if(!+bytes)return '0 Bytes'; const k=1024,dm=decimals<0?0:decimals,sizes=['Bytes','KB','MB','GB','TB'],i=Math.floor(Math.log(bytes)/Math.log(k)); return `${parseFloat((bytes/Math.pow(k,i)).toFixed(dm))} ${sizes[i]}`; };
export const formatDuration=(sec?:number)=>!sec||!Number.isFinite(sec)?'—':`${sec.toFixed(2)}s`;
export const shortHash=(hash?:string)=>!hash?'—':hash.length<=20?hash:`${hash.slice(0,12)}…${hash.slice(-8)}`;
export const resLabel=(w?:number,h?:number)=>!w||!h?'—':`${w}×${h}`;
export const codecLabel=(c?:string)=>{ if(!c)return '—'; const map:Record<string,string>={hevc:'HEVC (H.265)',h264:'H.264',av1:'AV1',vp9:'VP9',aac:'AAC'}; return map[c.toLowerCase()]||c.toUpperCase(); };
