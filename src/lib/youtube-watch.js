const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeWatchUrl(id) {
  const text = String(id || '');
  return VIDEO_ID.test(text) ? `https://www.youtube.com/watch?v=${text}` : '';
}
