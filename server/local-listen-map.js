const overlapDuration = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

const scoreTurns = (turns, intervals, ranges) => {
  const total = turns.reduce((sum, turn) => sum + ranges.reduce((inside, range) => (
    inside + overlapDuration(turn, range)
  ), 0), 0);
  const scores = new Map();
  for (const turn of turns) {
    for (const hint of intervals) {
      const overlap = overlapDuration(turn, hint);
      if (overlap <= 0) continue;
      scores.set(hint.who, (scores.get(hint.who) || 0) + overlap);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const evidence = ranked.reduce((sum, x) => sum + x[1], 0);
  const winner = ranked[0];
  const second = ranked[1]?.[1] || 0;
  const clear = winner
    && evidence >= Math.max(0.8, total * 0.35)
    && evidence / Math.max(0.01, total) >= 0.45
    && winner[1] / evidence >= 0.70
    && winner[1] - second >= Math.max(0.35, evidence * 0.20);
  return { total, ranked, evidence, winner, second, clear };
};

const diagnosticLine = (kind, speakerId, scored, turn) => {
  const { total, ranked, evidence, winner, second, clear } = scored;
  const coverage = evidence / Math.max(0.01, total);
  const topShare = winner ? winner[1] / evidence : 0;
  const margin = winner ? winner[1] - second : 0;
  const requiredMargin = Math.max(0.35, evidence * 0.20);
  const topName = String(winner?.[0] || 'none').replace(/\s+/g, ' ').trim();
  const secondName = String(ranked[1]?.[0] || 'none').replace(/\s+/g, ' ').trim();
  const ratio = (value) => Number(value).toFixed(2).replace(/^0/, '');
  const at = turn ? ` ${turn.start.toFixed(2)}-${turn.end.toFixed(2)}` : '';
  return `[EDIT] Local Listen ${kind} ${speakerId}${at}: total=${total.toFixed(2)} evidence=${evidence.toFixed(2)} coverage=${ratio(coverage)} `
    + `${topName}=${(winner?.[1] || 0).toFixed(2)} ${secondName}=${second.toFixed(2)} `
    + `share=${ratio(topShare)} margin=${margin.toFixed(2)} needShare=.70 needMargin=${requiredMargin.toFixed(2)} `
    + `-> ${clear ? `${kind === 'map' ? 'mapped ' : ''}${winner[0]}` : 'ambiguous'}`;
};

export const mapDiarizationEvidence = (turns, intervals, ranges, onDiagnostic) => {
  const byCluster = new Map();
  for (const turn of turns) {
    if (!byCluster.has(turn.speakerId)) byCluster.set(turn.speakerId, []);
    byCluster.get(turn.speakerId).push(turn);
  }
  const names = new Map();
  const mappedTurns = [];
  const ambiguousTurns = [];
  let globalMappedClusters = 0;
  let locallyValidatedTurns = 0;
  let localOverrides = 0;
  let globalDiagnosticCount = 0;
  let turnDiagnosticCount = 0;
  let firstAmbiguousSpeaker = '';
  const emit = (line) => {
    try { onDiagnostic?.(line); } catch { /* diagnostics must not affect mapping */ }
  };

  for (const [speakerId, clusterTurns] of byCluster) {
    const globalScore = scoreTurns(clusterTurns, intervals, ranges);
    const globalEligible = globalScore.total >= 0.35;
    if (globalEligible && globalDiagnosticCount < 8) {
      emit(diagnosticLine('map', speakerId, globalScore));
      globalDiagnosticCount += 1;
    }
    const globalWho = globalEligible && globalScore.clear ? globalScore.winner[0] : '';
    if (globalWho) {
      names.set(speakerId, globalWho);
      globalMappedClusters += 1;
    } else if (globalScore.total > 0) firstAmbiguousSpeaker ||= speakerId;
    for (const turn of clusterTurns) {
      const turnScore = scoreTurns([turn], intervals, ranges);
      if (!globalWho && turnScore.total > 0 && turnDiagnosticCount < 12) {
        emit(diagnosticLine('turn', speakerId, turnScore, turn));
        turnDiagnosticCount += 1;
      }
      if (turnScore.total >= 0.35 && turnScore.clear) {
        const localWho = turnScore.winner[0];
        mappedTurns.push({ ...turn, who: localWho });
        locallyValidatedTurns += 1;
        if (globalWho && localWho !== globalWho) {
          if (turnDiagnosticCount < 12) {
            emit(`[EDIT] Local Listen override ${speakerId} ${turn.start.toFixed(2)}-${turn.end.toFixed(2)}: `
              + `global=${globalWho} local=${localWho} -> ${localWho}`);
            turnDiagnosticCount += 1;
          }
          localOverrides += 1;
        }
      } else {
        ambiguousTurns.push(turn);
        firstAmbiguousSpeaker ||= speakerId;
      }
    }
  }

  if (!mappedTurns.length) {
    return {
      ok: false,
      reason: firstAmbiguousSpeaker
        ? `ambiguous PLAN identity for ${firstAmbiguousSpeaker}`
        : 'no diarization clusters overlap PLAN output',
      names,
      mappedTurns,
      ambiguousTurns,
      globalMappedClusters,
      locallyValidatedTurns,
      localOverrides,
    };
  }
  return {
    ok: true,
    names,
    mappedTurns,
    ambiguousTurns,
    globalMappedClusters,
    locallyValidatedTurns,
    localOverrides,
  };
};

const mergeRanges = (ranges) => {
  const sorted = ranges
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ start: range.start, end: range.end });
  }
  return out;
};

const subtractRanges = (start, end, exclusions) => {
  let parts = [{ start, end }];
  for (const exclusion of exclusions) {
    const next = [];
    for (const part of parts) {
      if (exclusion.end <= part.start || exclusion.start >= part.end) {
        next.push(part);
        continue;
      }
      if (exclusion.start > part.start) next.push({ start: part.start, end: exclusion.start });
      if (exclusion.end < part.end) next.push({ start: exclusion.end, end: part.end });
    }
    parts = next;
  }
  return parts.filter((x) => x.end > x.start);
};

export const fallbackSpeechForAmbiguousTurns = (fallbackSpeech, ambiguousTurns, mappedTurns) => {
  const unresolved = mergeRanges(ambiguousTurns.map((x) => ({ start: x.start, end: x.end })));
  const confident = mergeRanges(mappedTurns.map((x) => ({ start: x.start, end: x.end })));
  const out = [];
  for (const line of fallbackSpeech) {
    for (const range of unresolved) {
      const start = Math.max(line.t, range.start);
      const end = Math.min(line.end, range.end);
      if (end <= start) continue;
      for (const part of subtractRanges(start, end, confident)) {
        out.push({ ...line, t: part.start, end: part.end });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
};
