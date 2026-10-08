const transientStatus = (status) => status === 429 || status >= 500;

const failureMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error || 'request failed');
  return message.replace(/\s+/g, ' ').trim().slice(0, 120) || 'request failed';
};

export async function runGoogleSttChunkWithRetry({
  request,
  wait,
  isCancelled = () => false,
  onRetry,
  maxAttempts = 3,
  retryDelaysMs = [2000, 5000],
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled()) throw new Error('cancelled');
    let response;
    let reason = '';
    try {
      response = await request(attempt);
      if (response?.ok) return { ok: true, response, attempts: attempt };
      reason = `HTTP ${Number(response?.status) || 0}`;
      if (!transientStatus(Number(response?.status))) {
        return { ok: false, permanent: true, response, reason, attempts: attempt };
      }
    } catch (error) {
      if (isCancelled() || /^cancelled$/i.test(failureMessage(error))) throw error;
      reason = failureMessage(error);
    }
    if (attempt >= maxAttempts) return { ok: false, skipped: true, reason, attempts: attempt };
    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;
    onRetry?.({ attempt, maxAttempts, reason, delayMs });
    await wait(delayMs);
  }
  return { ok: false, skipped: true, reason: 'request failed', attempts: maxAttempts };
}
