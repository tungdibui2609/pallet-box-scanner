import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { getSupabaseClient } from './supabase';
import { getProductsFromCache } from './database';
import {
  normalizeWarehouseVoiceText,
  WAREHOUSE_VOICE_CONTEXT_STRINGS,
} from '../utils/voiceTextNormalizer';

const OFFLINE_VOICES_KEY = 'offline_inventory_voices_v1';
const VOICE_BATCH_SIZE = 10;

let cachedAliasVocab: { systemCode: string; fetchedAt: number; words: string[] } | null = null;

/**
 * Lấy danh sách tên gõ tắt (products.aliases) từ SQLite cache của App
 * để gửi làm từ điển gợi ý cho Gemini AI (giới hạn tối đa 50 từ ngắn <= 32 ký tự, giống Web Scanner).
 */
async function getCachedProductAliasesVocab(systemCode?: string): Promise<string[]> {
  const sysKey = String(systemCode || '').trim().toUpperCase();
  if (
    cachedAliasVocab &&
    cachedAliasVocab.systemCode === sysKey &&
    Date.now() - cachedAliasVocab.fetchedAt < 60_000
  ) {
    return cachedAliasVocab.words;
  }

  try {
    const rows = await getProductsFromCache();
    const filtered = sysKey
      ? rows.filter((p: any) => !p?.system_type || String(p.system_type).toUpperCase() === sysKey)
      : rows;
    const source = filtered.length > 0 ? filtered : rows;

    const set = new Set<string>();
    for (const p of source) {
      if (set.size >= 50) break;
      const rawAlias = String(p?.aliases || '').trim();
      if (rawAlias) {
        const parts = rawAlias.split(/[,;/|\n]+/);
        for (const part of parts) {
          const w = part.trim();
          if (w.length >= 2 && w.length <= 32) {
            set.add(w);
            if (set.size >= 50) break;
          }
        }
      }
      if (set.size < 50 && p?.name) {
        const name = String(p.name).trim();
        if (name.length >= 2 && name.length <= 32) {
          set.add(name);
        }
      }
    }

    const words = Array.from(set).slice(0, 50);
    cachedAliasVocab = { systemCode: sysKey, fetchedAt: Date.now(), words };
    return words;
  } catch {
    return [];
  }
}

let appKeyRoundRobinIdx = 0;
const appKeyCooldownUntil = new Map<string, number>();

function getOrderedGeminiKeysApp(keys: string[]): string[] {
  if (keys.length <= 1) return keys;
  const now = Date.now();
  const start = appKeyRoundRobinIdx % keys.length;
  appKeyRoundRobinIdx = (appKeyRoundRobinIdx + 1) % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const ready = rotated.filter(k => (appKeyCooldownUntil.get(k) || 0) <= now);
  const cooling = rotated.filter(k => (appKeyCooldownUntil.get(k) || 0) > now);
  return [...ready, ...cooling];
}

export interface OfflineInventoryVoiceAppItem {
  key: string; // `${sessionId}__${positionId}__${ts}_${rand}` (hỗ trợ nhiều ghi âm / 1 vị trí)
  sessionId: string;
  positionId: string;
  localUri: string;
  mimeType: string;
  durationSec: number;
  createdAt: string;
}

/**
 * Đọc danh sách URL ghi âm từ cột `voice_note_url` (tương thích cả 1 chuỗi đơn cũ lẫn JSON array mới).
 */
export function parseVoiceNoteUrlsApp(raw?: string | null): string[] {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return Array.from(
          new Set(arr.map(x => String(x || '').trim()).filter(Boolean))
        );
      }
    } catch {}
  }
  return [s];
}

/**
 * Gộp thêm 1 hoặc nhiều URL ghi âm vào `voice_note_url` mà không ghi đè các file trước đó.
 */
export function appendVoiceNoteUrlApp(
  existingRaw: string | null | undefined,
  incoming: string | string[] | null | undefined
): string | null {
  const current = parseVoiceNoteUrlsApp(existingRaw);
  const additions = Array.isArray(incoming)
    ? incoming.map(x => String(x || '').trim()).filter(Boolean)
    : incoming
      ? [String(incoming).trim()].filter(Boolean)
      : [];
  const merged = Array.from(new Set([...current, ...additions]));
  if (merged.length === 0) return null;
  if (merged.length === 1) return merged[0];
  return JSON.stringify(merged);
}

function getVoicesDir(): string {
  const base = LegacyFileSystem.documentDirectory || LegacyFileSystem.cacheDirectory || '';
  return `${base}inventory_voices/`;
}

async function ensureVoicesDir(): Promise<string> {
  const dir = getVoicesDir();
  try {
    const info = await LegacyFileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await LegacyFileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch {}
  return dir;
}

async function readAllVoiceRecords(): Promise<OfflineInventoryVoiceAppItem[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_VOICES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAllVoiceRecords(list: OfflineInventoryVoiceAppItem[]): Promise<void> {
  await AsyncStorage.setItem(OFFLINE_VOICES_KEY, JSON.stringify(list));
}

export async function saveOfflineInventoryVoiceApp(params: {
  sessionId: string;
  positionId: string;
  sourceUri: string;
  mimeType?: string;
  durationSec: number;
}): Promise<OfflineInventoryVoiceAppItem> {
  const dir = await ensureVoicesDir();
  const safePos = params.positionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  const rand = Math.random().toString(36).slice(2, 6);
  const ts = Date.now();
  const destUri = `${dir}voice_${safePos}_${ts}_${rand}.m4a`;

  let finalUri = params.sourceUri;
  try {
    await LegacyFileSystem.copyAsync({ from: params.sourceUri, to: destUri });
    finalUri = destUri;
  } catch {
    finalUri = params.sourceUri;
  }

  const key = `${params.sessionId}__${params.positionId}__${ts}_${rand}`;
  const item: OfflineInventoryVoiceAppItem = {
    key,
    sessionId: params.sessionId,
    positionId: params.positionId,
    localUri: finalUri,
    mimeType: params.mimeType || 'audio/mp4',
    durationSec: Math.max(1, Math.round(params.durationSec || 1)),
    createdAt: new Date().toISOString(),
  };

  const all = await readAllVoiceRecords();
  const next = [...all, item];
  await writeAllVoiceRecords(next);
  return item;
}

export async function getOfflineInventoryVoicesBySessionApp(
  sessionId: string
): Promise<OfflineInventoryVoiceAppItem[]> {
  const all = await readAllVoiceRecords();
  return all
    .filter(x => x.sessionId === sessionId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export async function getOfflineVoiceCountsBySessionApp(): Promise<Record<string, number>> {
  const all = await readAllVoiceRecords();
  const counts: Record<string, number> = {};
  for (const it of all) {
    if (!it.sessionId) continue;
    counts[it.sessionId] = (counts[it.sessionId] || 0) + 1;
  }
  return counts;
}

export async function deleteOfflineInventoryVoiceByKeyApp(voiceKey: string): Promise<void> {
  const all = await readAllVoiceRecords();
  const target = all.find(x => x.key === voiceKey);
  if (target?.localUri) {
    LegacyFileSystem.deleteAsync(target.localUri, { idempotent: true }).catch(() => {});
  }
  const next = all.filter(x => x.key !== voiceKey);
  await writeAllVoiceRecords(next);
}

export async function deleteOfflineInventoryVoiceApp(
  sessionId: string,
  positionId: string
): Promise<void> {
  const all = await readAllVoiceRecords();
  const targets = all.filter(x => x.sessionId === sessionId && x.positionId === positionId);
  for (const t of targets) {
    if (t.localUri) {
      LegacyFileSystem.deleteAsync(t.localUri, { idempotent: true }).catch(() => {});
    }
  }
  const next = all.filter(x => !(x.sessionId === sessionId && x.positionId === positionId));
  await writeAllVoiceRecords(next);
}

export async function remapOfflineInventoryVoiceSessionApp(
  oldSessionId: string,
  newSessionId: string
): Promise<void> {
  if (oldSessionId === newSessionId) return;
  const all = await readAllVoiceRecords();
  let changed = false;
  const next = all.map(it => {
    if (it.sessionId !== oldSessionId) return it;
    changed = true;
    const prefix = `${oldSessionId}__`;
    const suffix = it.key.startsWith(prefix) ? it.key.slice(prefix.length) : it.positionId;
    return {
      ...it,
      sessionId: newSessionId,
      key: `${newSessionId}__${suffix}`,
    };
  });
  if (changed) {
    await writeAllVoiceRecords(next);
  }
}

/**
 * Chuyển đổi URL lưu trong DB (`/api/voice-proxy?id=FILE_ID`) sang URL phát trực tiếp từ Google Drive cho App Android.
 */
export function resolvePlayableAudioUrlForApp(voiceNoteUrl?: string | null): string | null {
  if (!voiceNoteUrl) return null;
  const trimmed = voiceNoteUrl.trim();
  if (!trimmed) return null;
  const proxyMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (trimmed.includes('/api/voice-proxy') && proxyMatch?.[1]) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(proxyMatch[1])}`;
  }
  return trimmed;
}

function parseGeminiApiKeys(raw?: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      String(raw)
        .split(/[\r\n,;]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 20)
    )
  );
}

interface DriveVoiceCfg {
  webhookUrl: string;
  rootFolder: string;
}

interface GeminiCfg {
  apiKeys: string[];
  model: string;
}

async function fetchVoiceConfigsFromSupabase(
  systemCode: string,
  companyId?: string | null
): Promise<{ driveCfg: DriveVoiceCfg | null; geminiCfg: GeminiCfg | null }> {
  const client = await getSupabaseClient();
  let driveCfg: DriveVoiceCfg | null = null;
  let geminiCfg: GeminiCfg | null = null;

  try {
    const { data: dRow } = await client
      .from('inventory_voice_drive_settings')
      .select('webhook_url, root_folder_name, is_enabled')
      .eq('system_code', systemCode)
      .maybeSingle();

    if (
      dRow &&
      dRow.is_enabled !== false &&
      dRow.webhook_url &&
      String(dRow.webhook_url).trim().startsWith('http')
    ) {
      driveCfg = {
        webhookUrl: String(dRow.webhook_url).trim(),
        rootFolder: String(dRow.root_folder_name || 'WMS_GhiAm_KiemKe').trim(),
      };
    }
  } catch {}

  try {
    let q = client
      .from('company_ai_settings')
      .select('gemini_api_key, gemini_model, is_enabled')
      .eq('is_enabled', true);
    if (companyId) q = q.eq('company_id', companyId);
    const { data: aRow } = await q.limit(1).maybeSingle();
    if (aRow?.gemini_api_key) {
      const keys = parseGeminiApiKeys(aRow.gemini_api_key);
      if (keys.length > 0) {
        geminiCfg = {
          apiKeys: keys,
          model: String(aRow.gemini_model || 'gemini-2.5-flash').trim(),
        };
      }
    }
  } catch {}

  return { driveCfg, geminiCfg };
}

function sanitizeDriveSegment(raw?: string | null, fallback = 'Khac', maxLen = 60): string {
  const cleaned = String(raw || '')
    .replace(/[\\/:*?"<>|#%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

async function uploadSingleAudioToDrive(
  driveCfg: DriveVoiceCfg | null,
  params: {
    audioBase64: string;
    mimeType: string;
    systemCode: string;
    sessionId: string;
    sessionName?: string | null;
    positionId: string;
    positionCode?: string | null;
    rootFolderOverride?: string | null;
  }
): Promise<string | null> {
  if (!driveCfg) return null;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const day = `${ym}-${String(now.getDate()).padStart(2, '0')}`;
  const hhmmss = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 6);
  const sessionFolder = sanitizeDriveSegment(
    params.sessionName,
    params.sessionId.slice(0, 12),
    60
  );
  const posPrefix = sanitizeDriveSegment(
    params.positionCode,
    params.positionId.slice(0, 12),
    32
  ).replace(/\s+/g, '_');
  const folderPath = `${params.systemCode}/${ym}/${day}/${sessionFolder}`;
  const filename = `${posPrefix}_${hhmmss}_${rand}.m4a`;
  const rootFolder = params.rootFolderOverride
    ? sanitizeDriveSegment(params.rootFolderOverride, driveCfg.rootFolder, 60).replace(/\s+/g, '_')
    : driveCfg.rootFolder;

  // Tự động thử lại tối đa 3 lần (chống Apps Script cold-start / nghẽn mạng làm rớt file đầu tiên)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(driveCfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootFolder,
          folderPath,
          filename,
          mimeType: params.mimeType || 'audio/mp4',
          base64: params.audioBase64,
        }),
      });
      const text = await res.text();
      const parsed = JSON.parse(text);
      if (parsed?.success && parsed?.fileId) {
        // Lưu đúng định dạng chung với Web để Web Quản trị & Web Scanner phát trực tiếp qua /api/voice-proxy
        return `/api/voice-proxy?id=${encodeURIComponent(String(parsed.fileId))}`;
      }
    } catch {}
    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    }
  }
  return null;
}

async function mapWithConcurrency<T, R>(
  list: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      results[idx] = await worker(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function callGeminiBatchAudio(
  geminiCfg: GeminiCfg | null,
  items: { itemId: string; audioBase64: string; mimeType: string }[],
  extraVocab: string[] = []
): Promise<Record<string, string>> {
  if (!geminiCfg || geminiCfg.apiKeys.length === 0 || items.length === 0) return {};

  const mergedVocab = Array.from(
    new Set([
      'Dona A', 'Dona B', 'Dona C', 'Dona D',
      'Đô A', 'Đô B', 'Đô C', 'Đô D',
      'Ri A', 'Ri B', 'Ri C', 'Ri D', 'Ri 6',
      'vụn', 'múi', 'cơm', 'Nito', 'nguyên trái',
      'thùng', 'pallet', 'LOT', 'kg',
      ...extraVocab.slice(0, 50),
    ])
  );

  const prompt = [
    `Nghe ${items.length} đoạn ghi âm kiểm kê của nhân viên KHO LẠNH SẦU RIÊNG (đánh số "1".."${items.length}").`,
    `Tên hàng & từ hay dùng trong kho: ${mergedVocab.join(', ')}.`,
    'Chép lại đúng ý người nói bằng tiếng Việt, viết số bằng chữ số (0-9), giữ nguyên phân loại A/B/C/D nếu có.',
    `Trả về DUY NHẤT JSON object chứa đủ ${items.length} khóa "1".."${items.length}", ví dụ: {"1": "...", "2": "..."}. Đoạn im lặng trả về "".`,
  ].join('\n');

  // Dùng ID ngắn "1", "2", ... khi gửi Gemini để AI không bao giờ viết sai/bỏ sót chuỗi UUID dài
  const parts: any[] = [{ text: prompt }];
  items.forEach((it, idx) => {
    parts.push({ text: `Đoạn "${idx + 1}":` });
    parts.push({
      inlineData: {
        mimeType: it.mimeType || 'audio/mp4',
        data: it.audioBase64,
      },
    });
  });

  for (const apiKey of getOrderedGeminiKeysApp(geminiCfg.apiKeys)) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        geminiCfg.model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (res.status === 429) {
        appKeyCooldownUntil.set(apiKey, Date.now() + 60_000);
        continue;
      }
      if (res.status === 503 || !res.ok) continue;

      const json = await res.json();
      const rawText =
        json?.candidates?.[0]?.content?.parts
          ?.map((p: any) => p?.text || '')
          .join('')
          .trim() || '{}';
      const cleanJson = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed === 'object') {
        const mapped: Record<string, string> = {};
        items.forEach((it, idx) => {
          const shortKey = String(idx + 1);
          const val =
            parsed[shortKey] ??
            parsed[`Đoạn ${shortKey}`] ??
            parsed[`đoạn ${shortKey}`] ??
            parsed[it.itemId] ??
            '';
          mapped[it.itemId] = String(val || '').trim();
        });
        return mapped;
      }
    } catch {}
  }

  return {};
}

export async function processSingleVoiceOnlineApp(params: {
  localUri: string;
  mimeType?: string;
  systemCode: string;
  companyId?: string | null;
  sessionId: string;
  sessionName?: string | null;
  positionId: string;
  positionCode?: string | null;
  vocabulary?: string[];
  skipDriveUpload?: boolean;
  rootFolderOverride?: string | null;
}): Promise<{ text: string; voiceUrl: string | null; driveEnabled: boolean }> {
  const audioBase64 = await LegacyFileSystem.readAsStringAsync(params.localUri, {
    encoding: LegacyFileSystem.EncodingType.Base64,
  });
  const mimeType = params.mimeType || 'audio/mp4';

  const [{ driveCfg, geminiCfg }, cachedAliases] = await Promise.all([
    fetchVoiceConfigsFromSupabase(params.systemCode, params.companyId),
    getCachedProductAliasesVocab(params.systemCode),
  ]);
  const combinedVocab = Array.from(
    new Set([...(params.vocabulary || []), ...cachedAliases])
  ).slice(0, 50);

  const [voiceUrl, textMap] = await Promise.all([
    params.skipDriveUpload
      ? Promise.resolve(null)
      : uploadSingleAudioToDrive(driveCfg, {
          audioBase64,
          mimeType,
          systemCode: params.systemCode,
          sessionId: params.sessionId,
          sessionName: params.sessionName,
          positionId: params.positionId,
          positionCode: params.positionCode,
          rootFolderOverride: params.rootFolderOverride || null,
        }),
    callGeminiBatchAudio(
      geminiCfg,
      [{ itemId: params.positionId, audioBase64, mimeType }],
      combinedVocab
    ),
  ]);

  const rawText = String(textMap[params.positionId] || '').trim();
  const normalized = rawText ? normalizeWarehouseVoiceText(rawText) : '';
  return {
    text: normalized,
    voiceUrl,
    driveEnabled: Boolean(!params.skipDriveUpload && driveCfg),
  };
}

export async function syncOfflineInventoryVoicesForSessionApp(params: {
  sessionId: string;
  sessionName?: string | null;
  systemCode: string;
  companyId?: string | null;
  positionCodeById?: Record<string, string>;
  vocabulary?: string[];
  rootFolderOverride?: string | null;
  onProgress?: (msg: string) => void;
  /** Lưu ngay kết quả từng lô vào AsyncStorage/DB TRƯỚC KHI xóa file local, tránh mất link nếu gián đoạn giữa chừng */
  onBatchCompleted?: (
    batchResultsByPos: Record<string, { texts: string[]; voiceUrls: string[] }>
  ) => Promise<void>;
}): Promise<{
  syncedCount: number;
  resultsByPos: Record<string, { texts: string[]; voiceUrls: string[] }>;
}> {
  const pending = await getOfflineInventoryVoicesBySessionApp(params.sessionId);
  if (pending.length === 0) {
    return { syncedCount: 0, resultsByPos: {} };
  }

  const [{ driveCfg, geminiCfg }, cachedAliases] = await Promise.all([
    fetchVoiceConfigsFromSupabase(params.systemCode, params.companyId),
    getCachedProductAliasesVocab(params.systemCode),
  ]);
  const combinedVocab = Array.from(
    new Set([...(params.vocabulary || []), ...cachedAliases])
  ).slice(0, 50);

  const resultsByPos: Record<string, { texts: string[]; voiceUrls: string[] }> = {};
  let syncedCount = 0;
  const totalBatches = Math.ceil(pending.length / VOICE_BATCH_SIZE);

  for (let b = 0; b < pending.length; b += VOICE_BATCH_SIZE) {
    const batch = pending.slice(b, b + VOICE_BATCH_SIZE);
    const batchNo = Math.floor(b / VOICE_BATCH_SIZE) + 1;
    params.onProgress?.(
      totalBatches > 1
        ? `Đang gửi lô ${batchNo}/${totalBatches} (${batch.length} ghi âm) lên Drive & AI...`
        : `Đang tải & dịch AI ${batch.length} ghi âm kiểm kê...`
    );

    const loadedItems: {
      item: OfflineInventoryVoiceAppItem;
      audioBase64: string;
    }[] = [];

    for (const pv of batch) {
      try {
        const b64 = await LegacyFileSystem.readAsStringAsync(pv.localUri, {
          encoding: LegacyFileSystem.EncodingType.Base64,
        });
        if (b64) loadedItems.push({ item: pv, audioBase64: b64 });
      } catch {
        await deleteOfflineInventoryVoiceByKeyApp(pv.key);
      }
    }

    if (loadedItems.length === 0) continue;

    // Giới hạn 3 luồng upload Drive song song (kèm retry 3 lần) để tránh Google Apps Script cold-start làm rớt file đầu tiên
    const [driveUrls, geminiMap] = await Promise.all([
      mapWithConcurrency(loadedItems, 3, ({ item, audioBase64 }) =>
        uploadSingleAudioToDrive(driveCfg, {
          audioBase64,
          mimeType: item.mimeType,
          systemCode: params.systemCode,
          sessionId: params.sessionId,
          sessionName: params.sessionName,
          positionId: item.positionId,
          positionCode: params.positionCodeById?.[item.positionId] || null,
          rootFolderOverride: params.rootFolderOverride || null,
        })
      ),
      callGeminiBatchAudio(
        geminiCfg,
        loadedItems.map(({ item, audioBase64 }) => ({
          itemId: item.key,
          audioBase64,
          mimeType: item.mimeType,
        })),
        combinedVocab
      ),
    ]);

    // Nếu trong lô có đoạn bị AI bỏ sót (rỗng text), tự động thử dịch lẻ 1 lần nữa cho đoạn đó
    if (loadedItems.length > 1 && geminiCfg && geminiCfg.apiKeys.length > 0) {
      for (const { item, audioBase64 } of loadedItems) {
        if (!String(geminiMap[item.key] || '').trim()) {
          try {
            const retryMap = await callGeminiBatchAudio(
              geminiCfg,
              [{ itemId: item.key, audioBase64, mimeType: item.mimeType }],
              combinedVocab
            );
            const retryText = String(retryMap[item.key] || '').trim();
            if (retryText) {
              geminiMap[item.key] = retryText;
            }
          } catch {}
        }
      }
    }

    const batchResultsByPos: Record<string, { texts: string[]; voiceUrls: string[] }> = {};
    const keysToDeleteAfterPersist: string[] = [];

    for (let i = 0; i < loadedItems.length; i++) {
      const { item } = loadedItems[i];
      const voiceUrl = driveUrls[i] || null;
      const rawText = String(geminiMap[item.key] || '').trim();
      const normalized = rawText ? normalizeWarehouseVoiceText(rawText) : '';

      if (normalized || voiceUrl) {
        if (!resultsByPos[item.positionId]) {
          resultsByPos[item.positionId] = { texts: [], voiceUrls: [] };
        }
        if (!batchResultsByPos[item.positionId]) {
          batchResultsByPos[item.positionId] = { texts: [], voiceUrls: [] };
        }
        if (normalized) {
          resultsByPos[item.positionId].texts.push(normalized);
          batchResultsByPos[item.positionId].texts.push(normalized);
        }
        if (voiceUrl) {
          resultsByPos[item.positionId].voiceUrls.push(voiceUrl);
          batchResultsByPos[item.positionId].voiceUrls.push(voiceUrl);
        }

        // BẮT BUỘC có file ghi âm lên Drive (nếu Drive đang bật) thì mới được phép xóa file local;
        // nếu Drive lỗi (voiceUrl == null) thì vẫn giữ file local để lần đồng bộ sau đẩy tiếp lên Drive!
        const canRemoveLocal = driveCfg ? Boolean(voiceUrl) : Boolean(normalized);
        if (canRemoveLocal) {
          keysToDeleteAfterPersist.push(item.key);
          syncedCount++;
        }
      }
    }

    // Lưu bền vững kết quả của lô này trước, sau đó mới xóa file local để tuyệt đối không mất link ghi âm
    if (Object.keys(batchResultsByPos).length > 0 && params.onBatchCompleted) {
      await params.onBatchCompleted(batchResultsByPos);
    }
    for (const k of keysToDeleteAfterPersist) {
      await deleteOfflineInventoryVoiceByKeyApp(k);
    }
  }

  return { syncedCount, resultsByPos };
}
