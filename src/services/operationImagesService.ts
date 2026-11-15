import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { getSupabaseClient } from './supabase';
import {
  addHiddenId,
  reconcileHiddenIds,
  submitMobileApprovalRequest,
} from './approvalService';
import {
  buildFolderPathMap,
  getDriveSettings,
  listOperationFolders,
} from './operationDriveService';
import { applyOperationWatermark } from './watermarkService';

export const OPERATION_IMAGES_BUCKET = 'operation-images';
const OFFLINE_IMAGES_QUEUE_KEY = 'solieu_offline_images_queue';
const CACHE_SHIFT_IMAGES_PREFIX = 'solieu_cache_images_';
const LOCAL_ORIGINALS_KEY = 'solieu_local_original_images';
const LOCAL_AUTO_DELETE_DAYS_KEY = 'solieu_local_auto_delete_days';

export type OperationImageScope = 'journal' | 'sub_shift' | 'shift';

export function parseRefPhase(notes?: string | null): 'start' | 'end' | 'legacy' | null {
  const m = notes?.match(/^\[THAM_CHIEU:([^\]:]+)(?::(start|end))?\]/);
  if (!m) return null;
  if (m[2] === 'start') return 'start';
  if (m[2] === 'end') return 'end';
  return 'legacy';
}

export interface LocalPickedImage {
  localId: string;
  uri: string;
  originalUri?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
}

export interface OperationImageRecord {
  id: string;
  company_id?: string | null;
  system_code: string;
  shift_id: string;
  sub_shift_id?: string | null;
  journal_id?: string | null;
  folder_id?: string | null;
  scope: OperationImageScope;
  direction?: 'in' | 'out' | null;
  job_name?: string | null;
  item_name?: string | null;
  item_sku?: string | null;
  quantity?: number | null;
  unit?: string | null;
  storage_bucket: string;
  storage_path: string;
  public_url: string;
  file_size?: number | null;
  mime_type?: string | null;
  captured_by?: string | null;
  captured_by_name?: string | null;
  captured_at: string;
  notes?: string | null;
  drive_file_id?: string | null;
  drive_web_url?: string | null;
  drive_synced_at?: string | null;
  is_offline?: boolean;
}

interface OfflineImageQueueItem {
  localId: string;
  localUri: string;
  originalUri?: string;
  uploadedDrive?: {
    fileId: string;
    fileUrl: string;
    directUrl: string;
    syncedAt: string;
    fileSize?: number | null;
  };
  metadata: {
    company_id?: string | null;
    system_code: string;
    shift_id: string;
    sub_shift_id?: string | null;
    journal_id?: string | null;
    folder_id?: string | null;
    scope: OperationImageScope;
    direction?: 'in' | 'out' | null;
    job_name?: string | null;
    item_name?: string | null;
    item_sku?: string | null;
    quantity?: number | null;
    unit?: string | null;
    captured_by?: string | null;
    captured_by_name?: string | null;
    captured_at: string;
    notes?: string | null;
  };
}

export function normalizeBaseSystemCode(systemCode?: string | null): string {
  return String(systemCode || '').replace(/__solieu$/i, '').trim();
}

export function normalizeSearchText(str?: string | null): string {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function buildOperationImageFileName(params: {
  capturedAt?: Date;
  direction?: 'in' | 'out' | null;
  scope?: OperationImageScope;
  itemSku?: string | null;
  itemName?: string | null;
  jobName?: string | null;
  quantity?: number | null;
  unit?: string | null;
}): string {
  const dt = params.capturedAt || new Date();
  const stamp = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(
    dt.getDate()
  ).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}`;
  const dirTag = params.direction === 'in' ? 'NHAP' : params.direction === 'out' ? 'XUAT' : 'CV';
  const rawCode = params.itemSku?.trim() || params.itemName?.trim() || params.jobName?.trim() || params.scope || 'ANH';
  const cleanCode = rawCode
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const qtyTag =
    params.quantity != null
      ? `_${params.quantity}${
          params.unit
            ? params.unit
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[\\/:*?"<>|\s]+/g, '')
                .slice(0, 10)
            : ''
        }`
      : '';
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}_${dirTag}_${cleanCode}${qtyTag}_${rand}.jpg`;
}

export function generateUuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function compressImageUri(uri: string): Promise<{ uri: string; width: number; height: number }> {
  try {
    const manipulated = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1400 } }],
      { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
    );
    return { uri: manipulated.uri, width: manipulated.width, height: manipulated.height };
  } catch (err) {
    console.warn('Compress image fallback to original:', err);
    return { uri, width: 0, height: 0 };
  }
}

export async function capturePhotoWithCamera(): Promise<LocalPickedImage | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    alert('Vui lòng cấp quyền Camera để chụp ảnh chứng minh.');
    return null;
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.85,
    allowsEditing: false,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  const compressed = await compressImageUri(asset.uri);
  return {
    localId: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    uri: compressed.uri,
    originalUri: asset.uri !== compressed.uri ? asset.uri : undefined,
    width: compressed.width || asset.width,
    height: compressed.height || asset.height,
    mimeType: 'image/jpeg',
  };
}

export async function pickPhotosFromLibrary(maxCount = 5): Promise<LocalPickedImage[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    alert('Vui lòng cấp quyền Thư viện ảnh để chọn hình.');
    return [];
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: maxCount,
    quality: 0.85,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return [];
  }

  const out: LocalPickedImage[] = [];
  for (const asset of result.assets) {
    const compressed = await compressImageUri(asset.uri);
    out.push({
      localId: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      uri: compressed.uri,
      originalUri: asset.uri !== compressed.uri ? asset.uri : undefined,
      width: compressed.width || asset.width,
      height: compressed.height || asset.height,
      mimeType: 'image/jpeg',
    });
  }
  return out;
}

async function getCachedShiftImages(shiftId: string): Promise<OperationImageRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(`${CACHE_SHIFT_IMAGES_PREFIX}${shiftId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setCachedShiftImages(shiftId: string, list: OperationImageRecord[]): Promise<void> {
  try {
    await AsyncStorage.setItem(`${CACHE_SHIFT_IMAGES_PREFIX}${shiftId}`, JSON.stringify(list));
  } catch (e) {
    console.warn('setCachedShiftImages error:', e);
  }
}

async function getOfflineQueue(): Promise<OfflineImageQueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_IMAGES_QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function setOfflineQueue(items: OfflineImageQueueItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OFFLINE_IMAGES_QUEUE_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn('setOfflineQueue error:', e);
  }
}

export function getOperationImageDisplayUrl(img: Partial<OperationImageRecord>): string {
  if (img.drive_file_id) {
    return `https://lh3.googleusercontent.com/d/${img.drive_file_id}=w1600`;
  }
  return img.public_url || '';
}

async function uploadSingleImageOnline(item: OfflineImageQueueItem): Promise<OperationImageRecord> {
  const supabase = await getSupabaseClient();
  const baseSys = normalizeBaseSystemCode(item.metadata.system_code);
  const now = new Date(item.metadata.captured_at || Date.now());
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 1. Lấy cấu hình Google Drive của kho (KHÔNG lưu file lên Supabase Storage)
  const settings = await getDriveSettings(baseSys);
  const webhookUrl = settings?.webhook_url?.trim();
  if (!webhookUrl) {
    throw new Error('CHUA_CAU_HINH_DRIVE');
  }

  // 2. Nếu chưa đẩy Drive -> đọc base64 chuẩn từ file trên máy bằng LegacyFileSystem
  let driveInfo = item.uploadedDrive;
  if (!driveInfo?.fileId) {
    let fileSize: number | null = null;
    try {
      const f = new File(item.localUri);
      fileSize = f.exists ? (f.size ?? null) : null;
    } catch {
      fileSize = null;
    }

    const base64 = await LegacyFileSystem.readAsStringAsync(item.localUri, {
      encoding: 'base64',
    });
    if (!base64 || base64.length < 100) {
      throw new Error('Không đọc được dữ liệu ảnh hợp lệ từ bộ nhớ máy');
    }

    // 3. Xác định đường dẫn thư mục trên Google Drive
    let customFolder = '';
    if (item.metadata.folder_id) {
      try {
        const folders = await listOperationFolders(baseSys);
        const pathMap = buildFolderPathMap(folders);
        customFolder = pathMap.get(item.metadata.folder_id) || '';
      } catch {
        customFolder = '';
      }
    }

    const rootFolder = settings?.root_folder_name?.trim() || 'WMS_HinhAnh_Kho';
    const subName =
      customFolder ||
      (item.metadata.job_name ? item.metadata.job_name.replace(/[\\/:*?"<>|]/g, '_') : 'Chung');
    const folderPath = `${baseSys || 'DEFAULT'}/${ym}/${subName}`;
    const fileName = buildOperationImageFileName({
      capturedAt: now,
      direction: item.metadata.direction,
      scope: item.metadata.scope,
      itemSku: item.metadata.item_sku,
      itemName: item.metadata.item_name,
      jobName: item.metadata.job_name,
      quantity: item.metadata.quantity,
      unit: item.metadata.unit,
    });

    // 4. Đẩy trực tiếp lên Google Drive qua Google Apps Script Webhook
    const driveRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolder,
        folderPath,
        filename: fileName,
        mimeType: 'image/jpeg',
        base64,
      }),
    });

    const driveJson = await driveRes.json();
    if (!driveJson?.success || !driveJson?.fileId) {
      throw new Error(driveJson?.error || 'Google Drive Webhook trả về lỗi');
    }

    const directUrl =
      driveJson.directUrl ||
      `https://lh3.googleusercontent.com/d/${driveJson.fileId}=w1600`;

    driveInfo = {
      fileId: driveJson.fileId,
      fileUrl: driveJson.fileUrl || directUrl,
      directUrl,
      syncedAt: new Date().toISOString(),
      fileSize,
    };
    item.uploadedDrive = driveInfo;
  }

  // 5. Chỉ lưu đường link Google Drive & metadata vào Database
  const insertPayload = {
    company_id: item.metadata.company_id || null,
    system_code: baseSys,
    shift_id: item.metadata.shift_id,
    sub_shift_id: item.metadata.sub_shift_id || null,
    journal_id: item.metadata.journal_id || null,
    folder_id: item.metadata.folder_id || null,
    scope: item.metadata.scope,
    direction: item.metadata.direction || null,
    job_name: item.metadata.job_name || null,
    item_name: item.metadata.item_name || null,
    item_sku: item.metadata.item_sku || null,
    quantity: item.metadata.quantity ?? null,
    unit: item.metadata.unit || null,
    storage_bucket: 'google-drive',
    storage_path: '',
    public_url: driveInfo.directUrl,
    file_size: driveInfo.fileSize ?? null,
    mime_type: 'image/jpeg',
    captured_by: item.metadata.captured_by || null,
    captured_by_name: item.metadata.captured_by_name || null,
    captured_at: item.metadata.captured_at,
    notes: item.metadata.notes || null,
    drive_file_id: driveInfo.fileId,
    drive_web_url: driveInfo.fileUrl,
    drive_synced_at: driveInfo.syncedAt,
  };

  let { data: inserted, error: dbErr } = await supabase
    .from('operation_images')
    .insert([insertPayload])
    .select('*')
    .single();

  if (dbErr && dbErr.code === '23503' && insertPayload.journal_id) {
    // Nếu journal_id bị lỗi FK (phiếu bị xóa hoặc chưa đồng bộ), kiểm tra xem phiếu còn trong queue offline không
    const rawOpsQueue = await AsyncStorage.getItem('solieu_offline_queue').catch(() => null);
    const hasPendingOps = rawOpsQueue && rawOpsQueue !== '[]';
    if (!hasPendingOps) {
      const retryRes = await supabase
        .from('operation_images')
        .insert([{ ...insertPayload, journal_id: null }])
        .select('*')
        .single();
      inserted = retryRes.data;
      dbErr = retryRes.error;
    }
  }

  if (dbErr) throw dbErr;

  // 6. Tự động xóa file nén tạm trên máy ngay sau khi đã đẩy lên Google Drive thành công
  deleteLocalFileSafe(item.localUri);

  // 7. Lưu dấu vết ảnh gốc trên máy (chỉ tự xóa theo tùy chọn riêng của máy nhân viên khi đã đồng bộ Drive)
  if (item.originalUri) {
    await trackLocalOriginal({
      id: item.localId,
      uri: item.originalUri,
      systemCode: baseSys,
      driveFileId: driveInfo.fileId,
      syncedAt: insertPayload.drive_synced_at,
    });
  }

  // Dọn các ảnh gốc đã đồng bộ quá số ngày cấu hình riêng trên máy này
  await cleanupExpiredLocalOriginals(baseSys).catch(() => 0);

  return inserted as OperationImageRecord;
}

export async function getLocalAutoDeleteDays(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_AUTO_DELETE_DAYS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function setLocalAutoDeleteDays(days: number | null): Promise<void> {
  try {
    if (days != null && days > 0) {
      await AsyncStorage.setItem(LOCAL_AUTO_DELETE_DAYS_KEY, String(days));
    } else {
      await AsyncStorage.removeItem(LOCAL_AUTO_DELETE_DAYS_KEY);
    }
  } catch (err) {
    console.warn('setLocalAutoDeleteDays error:', err);
  }
}

interface LocalOriginalTrackItem {
  id: string;
  uri: string;
  systemCode: string;
  driveFileId: string;
  syncedAt: string;
}

function deleteLocalFileSafe(uri?: string | null): void {
  if (!uri || !uri.startsWith('file://')) return;
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch (err) {
    console.warn('deleteLocalFileSafe skipped:', err);
  }
}

async function getTrackedLocalOriginals(): Promise<LocalOriginalTrackItem[]> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_ORIGINALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function trackLocalOriginal(entry: LocalOriginalTrackItem): Promise<void> {
  const list = await getTrackedLocalOriginals();
  const next = list.filter((x) => x.id !== entry.id && x.uri !== entry.uri);
  next.push(entry);
  await AsyncStorage.setItem(LOCAL_ORIGINALS_KEY, JSON.stringify(next));
}

/**
 * Xóa các ảnh gốc trên máy nhân viên đã đồng bộ Google Drive thành công
 * và đã quá số ngày quy định (cài đặt riêng trên từng điện thoại).
 */
export async function cleanupExpiredLocalOriginals(
  systemCode: string,
  daysOverride?: number | null
): Promise<number> {
  const baseSys = normalizeBaseSystemCode(systemCode);
  const days = daysOverride !== undefined ? daysOverride : await getLocalAutoDeleteDays();
  if (!days || days <= 0) return 0;

  const list = await getTrackedLocalOriginals();
  if (list.length === 0) return 0;

  const nowMs = Date.now();
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const remaining: LocalOriginalTrackItem[] = [];
  let deletedCount = 0;

  for (const entry of list) {
    // Điều kiện bắt buộc: phải có driveFileId (đã đồng bộ thành công)
    if (
      entry.systemCode === baseSys &&
      entry.driveFileId &&
      nowMs - new Date(entry.syncedAt).getTime() >= maxAgeMs
    ) {
      deleteLocalFileSafe(entry.uri);
      deletedCount++;
    } else {
      remaining.push(entry);
    }
  }

  if (deletedCount > 0) {
    await AsyncStorage.setItem(LOCAL_ORIGINALS_KEY, JSON.stringify(remaining));
  }
  return deletedCount;
}

export async function uploadOperationImages(params: {
  images: LocalPickedImage[];
  systemCode: string;
  companyId?: string | null;
  shiftId: string;
  subShiftId?: string | null;
  journalId?: string | null;
  folderId?: string | null;
  scope: OperationImageScope;
  direction?: 'in' | 'out' | null;
  jobName?: string | null;
  itemName?: string | null;
  itemSku?: string | null;
  quantity?: number | null;
  unit?: string | null;
  user?: any;
  notes?: string | null;
}): Promise<OperationImageRecord[]> {
  if (!params.images || params.images.length === 0) return [];

  const baseSys = normalizeBaseSystemCode(params.systemCode);
  const now = new Date();
  const nowIso = now.toISOString();
  const results: OperationImageRecord[] = [];
  const queue = await getOfflineQueue();
  const cached = await getCachedShiftImages(params.shiftId);

  for (const img of params.images) {
    const stampedUri = await applyOperationWatermark({
      uri: img.uri,
      width: img.width,
      height: img.height,
      systemCode: baseSys,
      jobName: params.jobName,
      itemName: params.itemName,
      quantity: params.quantity,
      unit: params.unit,
      direction: params.direction,
      capturedByName: params.user?.full_name || 'Nhân viên kho',
      capturedAt: now,
    });

    if (stampedUri !== img.uri && img.uri !== img.originalUri) {
      deleteLocalFileSafe(img.uri);
    }

    const queueItem: OfflineImageQueueItem = {
      localId: img.localId,
      localUri: stampedUri,
      originalUri: img.originalUri,
      metadata: {
        company_id: params.companyId || params.user?.company_id || null,
        system_code: baseSys,
        shift_id: params.shiftId,
        sub_shift_id: params.subShiftId || null,
        journal_id: params.journalId || null,
        folder_id: params.folderId || null,
        scope: params.scope,
        direction: params.direction || null,
        job_name: params.jobName || null,
        item_name: params.itemName || null,
        item_sku: params.itemSku || null,
        quantity: params.quantity ?? null,
        unit: params.unit || null,
        captured_by: params.user?.id || null,
        captured_by_name: params.user?.full_name || 'Nhân viên kho',
        captured_at: nowIso,
        notes: params.notes || null,
      },
    };

    if (params.shiftId.startsWith('offline_shift_')) {
      queue.push(queueItem);
      const localRec: OperationImageRecord = {
        id: img.localId,
        ...queueItem.metadata,
        storage_bucket: OPERATION_IMAGES_BUCKET,
        storage_path: '',
        public_url: stampedUri,
        mime_type: 'image/jpeg',
        is_offline: true,
      };
      cached.unshift(localRec);
      results.push(localRec);
      continue;
    }

    try {
      const uploaded = await uploadSingleImageOnline(queueItem);
      cached.unshift(uploaded);
      results.push(uploaded);
    } catch (err) {
      console.warn('Upload image failed, queuing offline:', err);
      queue.push(queueItem);
      const localRec: OperationImageRecord = {
        id: img.localId,
        ...queueItem.metadata,
        storage_bucket: OPERATION_IMAGES_BUCKET,
        storage_path: '',
        public_url: stampedUri,
        mime_type: 'image/jpeg',
        is_offline: true,
      };
      cached.unshift(localRec);
      results.push(localRec);
    }
  }

  await setOfflineQueue(queue);
  await setCachedShiftImages(params.shiftId, cached);
  return results;
}

export async function syncOfflineOperationImages(shiftIdMap?: Record<string, string>): Promise<number> {
  const queue = await getOfflineQueue();
  if (queue.length === 0) return 0;

  const remaining: OfflineImageQueueItem[] = [];
  let synced = 0;

  for (const item of queue) {
    const resolvedShiftId = shiftIdMap?.[item.metadata.shift_id] || item.metadata.shift_id;
    if (resolvedShiftId.startsWith('offline_shift_')) {
      remaining.push(item);
      continue;
    }
    const updatedItem: OfflineImageQueueItem = {
      ...item,
      metadata: { ...item.metadata, shift_id: resolvedShiftId },
    };

    try {
      await uploadSingleImageOnline(updatedItem);
      synced++;
    } catch (err) {
      console.warn('Sync offline image failed:', err);
      remaining.push(updatedItem);
    }
  }

  await setOfflineQueue(remaining);
  return synced;
}

export async function getShiftOperationImages(shiftId: string): Promise<OperationImageRecord[]> {
  const cached = await getCachedShiftImages(shiftId);
  if (shiftId.startsWith('offline_shift_')) {
    return cached;
  }

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
      .from('operation_images')
      .select('*')
      .eq('shift_id', shiftId)
      .order('captured_at', { ascending: false });

    if (error) throw error;
    const hidden = await reconcileHiddenIds('images', 'operation_images');
    const onlineList = ((data || []) as OperationImageRecord[]).filter((img) => !hidden.has(img.id));
    const offlineOnly = cached.filter((c) => c.is_offline && !hidden.has(c.id));
    const merged = [...offlineOnly, ...onlineList];
    await setCachedShiftImages(shiftId, merged);
    return merged;
  } catch (err) {
    console.warn('getShiftOperationImages fallback to cache:', err);
    const hidden = await reconcileHiddenIds('images', 'operation_images');
    return cached.filter((img) => !hidden.has(img.id));
  }
}

export async function deleteOperationImage(image: OperationImageRecord): Promise<void> {
  if (!image.is_offline && !String(image.id).startsWith('offline_')) {
    await submitMobileApprovalRequest({
      systemCode: image.system_code,
      companyId: image.company_id || null,
      actionType: 'delete_image',
      targetTable: 'operation_images',
      targetId: image.id,
      shiftId: image.shift_id || null,
      shiftName: image.job_name || null,
      targetLabel: image.item_name
        ? `Ảnh SP: ${image.item_name}`
        : image.job_name
        ? `Ảnh công việc: ${image.job_name}`
        : 'Hình ảnh kho',
      beforeData: {
        id: image.id,
        image_url: image.public_url,
        storage_path: image.storage_path,
        item_name: image.item_name,
        shift_name: image.job_name,
        scope: image.scope,
      },
      requestedBy: (image as any).captured_by || null,
      requestedByName: image.captured_by_name || 'Nhân viên App',
    });
    await addHiddenId('images', image.id);
  } else {
    const queue = await getOfflineQueue();
    await setOfflineQueue(queue.filter((q) => q.localId !== image.id));
  }

  const cached = await getCachedShiftImages(image.shift_id);
  await setCachedShiftImages(
    image.shift_id,
    cached.filter((c) => c.id !== image.id)
  );
}

export async function moveOperationImageToFolder(image: OperationImageRecord, folderId: string | null): Promise<void> {
  if (!image.is_offline) {
    const supabase = await getSupabaseClient();
    const { error } = await supabase
      .from('operation_images')
      .update({ folder_id: folderId })
      .eq('id', image.id);
    if (error) throw error;
  }
  const cached = await getCachedShiftImages(image.shift_id);
  await setCachedShiftImages(
    image.shift_id,
    cached.map((c) => (c.id === image.id ? { ...c, folder_id: folderId } : c))
  );
}

/**
 * Lấy danh sách toàn bộ ảnh của kho hiện tại (phục vụ màn hình Album & Thống kê theo cây Tháng -> Ngày -> Công việc).
 */
export async function listSystemOperationImages(params: {
  systemCode: string;
  companyId?: string | null;
  limit?: number;
}): Promise<OperationImageRecord[]> {
  const baseSys = normalizeBaseSystemCode(params.systemCode);
  const queue = await getOfflineQueue();
  const offlineRecords: OperationImageRecord[] = queue
    .filter((q) => normalizeBaseSystemCode(q.metadata.system_code) === baseSys)
    .map((q) => ({
      id: q.localId,
      ...q.metadata,
      storage_bucket: OPERATION_IMAGES_BUCKET,
      storage_path: '',
      public_url: q.localUri,
      mime_type: 'image/jpeg',
      is_offline: true,
    }));

  try {
    const supabase = await getSupabaseClient();
    let query = supabase
      .from('operation_images')
      .select('*')
      .eq('system_code', baseSys)
      .order('captured_at', { ascending: false })
      .limit(params.limit || 300);

    if (params.companyId) {
      query = query.eq('company_id', params.companyId);
    }

    const { data, error } = await query;
    if (error) throw error;
    const hidden = await reconcileHiddenIds('images', 'operation_images');
    return [...offlineRecords, ...((data || []) as OperationImageRecord[])].filter(
      (img) => !hidden.has(img.id)
    );
  } catch (err) {
    console.warn('listSystemOperationImages fallback offline only:', err);
    const hidden = await reconcileHiddenIds('images', 'operation_images');
    return offlineRecords.filter((img) => !hidden.has(img.id));
  }
}
