const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function parseVideoId(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (VIDEO_ID.test(value)) return value;

  if (!/^https?:\/\//i.test(value) && /(?:youtube\.com|youtu\.be)/i.test(value)) {
    value = `https://${value.replace(/^\/+/, "")}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const candidate = url.pathname.split("/").filter(Boolean)[0];
    return candidate !== undefined && VIDEO_ID.test(candidate) ? candidate : null;
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (url.pathname === "/watch") {
    const candidate = url.searchParams.get("v");
    return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
  }

  const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
  return match?.[1] !== undefined && VIDEO_ID.test(match[1]) ? match[1] : null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
