// Aggregate existing diagnostics; no influence on processing decisions.
export function createEditRunReport(jobId, sourceName, emit, now = Date.now) {
    const started = now();
    const phases = new Map();
    const partResults = new Map();
    let phase = 'start', part = 0, requests429 = 0, retries = 0, finished = false;
    const signals = new Map();
    return {
        observe(type, data) {
            if (type === 'progress') { phase = data.phase || phase; part = data.part || part; }
            if (type !== 'log') return;
            const line = String(data.message || '');
            const timing = line.match(/\[EDIT TIMING\] (.+): ([\d.]+)s/);
            if (timing) {
                const label = part && /^(RGB\/frame refinement|final FFmpeg render)$/.test(timing[1]) ? `Part ${part} ${timing[1]}` : timing[1];
                phases.set(label, (phases.get(label) || 0) + Number(timing[2]));
            }
            if (/Shared Vertex cooldown set .*HTTP 429/.test(line)) requests429++;
            if (/Vertex retry \d/.test(line)) retries++;
            const detail = line.match(/Detail PLAN (\d+\/\d+)( modes:.*| failed.*|: \d+ framing.*)/);
            if (detail) partResults.set(detail[1], (partResults.get(detail[1]) || []).concat(detail[2]));
            for (const key of ['Detail PLAN complete:', 'Local Listen:', 'Google STT ', 'STT failed', 'Google STT skip', 'Mix framing stages:', 'Mixed 9:16 Gemini', '9:16 pass failed', 'Coverage complete:']) {
                if (line.includes(key)) signals.set(`${part}:${key}`, line);
            }
        },
        finish(status) {
            if (finished) return;
            finished = true;
            const seconds = Math.max(0, (now() - started) / 1000);
            emit(`[EDIT REPORT] job=${jobId} source=${JSON.stringify(sourceName)} status=${status} backendTotal=${seconds.toFixed(2)}s lastPhase=${phase} part=${part || '-'} HTTP429=${requests429} VertexRetries=${retries}`);
            emit(`[EDIT REPORT] Timings (may overlap; not additive): ${[...phases].map(([name, sec]) => `${name}=${sec.toFixed(2)}s`).join(' · ') || 'none'}`);
            for (const [ordinal, outcomes] of partResults) emit(`[EDIT REPORT] Detail ${ordinal}${outcomes.join(' · ')}`);
            for (const value of signals.values()) emit(`[EDIT REPORT] ${value}`);
        },
    };
}
