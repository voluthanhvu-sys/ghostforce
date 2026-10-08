import React from 'react';
import { youtubeWatchUrl } from '../lib/youtube-watch.js';

export function YoutubeWatchLink({
  videoId,
  className,
  children,
}: {
  videoId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const href = youtubeWatchUrl(videoId);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-watch={videoId}
      title="Mở video trên YouTube"
      className={className}
    >
      {children}
    </a>
  );
}
