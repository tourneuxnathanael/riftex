/**
 * TikTok Content Posting API (OAuth 2.0 + upload FILE_UPLOAD par chunks).
 *
 * Scopes requis : `video.upload` (brouillon dans la boîte de réception TikTok) et/ou
 * `video.publish` (publication directe). Tant que l'app n'a pas passé l'audit TikTok,
 * la publication directe est limitée à `privacy_level: "SELF_ONLY"`.
 */
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

const API = "https://open.tiktokapis.com";
const MIN_CHUNK = 5 * 1024 * 1024;
const DEFAULT_CHUNK = 10 * 1024 * 1024;

export interface TikTokToken {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  /** Timestamps absolus (ms). */
  expires_at: number;
  refresh_expires_at: number;
}

// ---------------------------------------------------------------- OAuth
export function buildAuthUrl(state = randomBytes(12).toString("hex")) {
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.search = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    scope: "user.info.basic,video.upload,video.publish",
    response_type: "code",
    redirect_uri: config.tiktok.redirectUri,
    state,
  }).toString();
  return { url: url.toString(), state };
}

async function tokenRequest(params: Record<string, string>): Promise<TikTokToken> {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      ...params,
    }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new Error(`TikTok OAuth : ${data.error ?? res.status} ${data.error_description ?? ""}`);
  }
  const now = Date.now();
  const token: TikTokToken = {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    open_id: String(data.open_id),
    scope: String(data.scope),
    expires_at: now + Number(data.expires_in) * 1000,
    refresh_expires_at: now + Number(data.refresh_expires_in) * 1000,
  };
  await saveToken(token);
  return token;
}

export function exchangeCode(code: string) {
  return tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: config.tiktok.redirectUri,
  });
}

async function saveToken(token: TikTokToken) {
  await mkdir(path.dirname(config.tiktok.tokenPath), { recursive: true });
  await writeFile(config.tiktok.tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/** Charge le token stocké et le rafraîchit s'il expire dans moins de 5 minutes. */
export async function getValidToken(): Promise<TikTokToken> {
  let token: TikTokToken;
  try {
    token = JSON.parse(await readFile(config.tiktok.tokenPath, "utf8"));
  } catch {
    throw new Error("Aucun token TikTok : lancez d'abord `npm run tiktok:auth`.");
  }
  if (token.expires_at - Date.now() > 5 * 60_000) return token;
  if (token.refresh_expires_at < Date.now()) {
    throw new Error("Refresh token TikTok expiré : relancez `npm run tiktok:auth`.");
  }
  return tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token });
}

// ---------------------------------------------------------------- API helpers
async function api<T>(token: TikTokToken, endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error: { code: string; message: string } };
  if (!res.ok || (json.error && json.error.code !== "ok")) {
    throw new Error(`TikTok ${endpoint} : ${json.error?.code} ${json.error?.message ?? res.status}`);
  }
  return json.data;
}

export interface CreatorInfo {
  creator_username: string;
  privacy_level_options: string[];
  max_video_post_duration_sec: number;
}

export function queryCreatorInfo(token: TikTokToken) {
  return api<CreatorInfo>(token, "/v2/post/publish/creator_info/query/", {});
}

/** Découpage conforme aux règles TikTok : chunks de 5 à 64 Mo, le dernier absorbe le reste. */
export function chunkPlan(size: number, chunkSize = DEFAULT_CHUNK) {
  if (size <= MIN_CHUNK) return { chunkSize: size, count: 1 };
  const count = Math.max(1, Math.floor(size / chunkSize));
  return { chunkSize, count };
}

async function uploadChunks(uploadUrl: string, filePath: string, size: number, chunkSize: number, count: number) {
  const fh = await open(filePath, "r");
  try {
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
      if (![200, 201, 206].includes(res.status)) {
        throw new Error(`Upload TikTok chunk ${i + 1}/${count} : ${res.status} ${await res.text()}`);
      }
    }
  } finally {
    await fh.close();
  }
}

export interface PublishOptions {
  videoPath: string;
  /** Légende complète (titre + hashtags), 2200 caractères max. */
  caption: string;
  /** "draft" : envoi dans la boîte de réception TikTok de l'utilisateur, qui finalise dans l'app. */
  mode: "draft" | "direct";
  privacyLevel?: string;
}

export async function publishVideo(opts: PublishOptions) {
  const token = await getValidToken();
  const { size } = await stat(opts.videoPath);
  const { chunkSize, count } = chunkPlan(size);
  const source_info = {
    source: "FILE_UPLOAD",
    video_size: size,
    chunk_size: chunkSize,
    total_chunk_count: count,
  };

  let init: { publish_id: string; upload_url: string };
  if (opts.mode === "draft") {
    init = await api(token, "/v2/post/publish/inbox/video/init/", { source_info });
  } else {
    const creator = await queryCreatorInfo(token);
    const privacy =
      opts.privacyLevel && creator.privacy_level_options.includes(opts.privacyLevel)
        ? opts.privacyLevel
        : creator.privacy_level_options.includes("SELF_ONLY")
          ? "SELF_ONLY"
          : creator.privacy_level_options[0];
    init = await api(token, "/v2/post/publish/video/init/", {
      post_info: {
        title: opts.caption.slice(0, 2200),
        privacy_level: privacy,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info,
    });
  }

  await uploadChunks(init.upload_url, opts.videoPath, size, chunkSize, count);
  return init.publish_id;
}

export function fetchPublishStatus(token: TikTokToken, publishId: string) {
  return api<{ status: string; fail_reason?: string; publicaly_available_post_id?: string[] }>(
    token,
    "/v2/post/publish/status/fetch/",
    { publish_id: publishId },
  );
}

/** Attend que TikTok ait traité la vidéo (ou échoue). */
export async function waitForPublish(publishId: string, timeoutMs = 180_000) {
  const token = await getValidToken();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await fetchPublishStatus(token, publishId);
    if (s.status === "FAILED") throw new Error(`Publication TikTok échouée : ${s.fail_reason}`);
    if (s.status === "PUBLISH_COMPLETE" || s.status === "SEND_TO_USER_INBOX") return s;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Délai dépassé en attendant le traitement TikTok.");
}
