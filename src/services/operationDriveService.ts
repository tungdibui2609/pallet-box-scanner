import { getSupabaseClient } from './supabase';
import { OperationImageRecord, normalizeBaseSystemCode } from './operationImagesService';

export interface OperationFolder {
  id: string;
  company_id?: string | null;
  system_code: string;
  parent_id?: string | null;
  name: string;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at?: string;
}

export interface OperationDriveSettings {
  id?: string;
  company_id?: string | null;
  system_code: string;
  webhook_url: string;
  root_folder_name: string;
  auto_sync_enabled: boolean;
  auto_delete_local_days?: number | null;
}

export async function listOperationFolders(systemCode: string, companyId?: string | null): Promise<OperationFolder[]> {
  const supabase = await getSupabaseClient();
  const baseSys = normalizeBaseSystemCode(systemCode);
  let query = supabase
    .from('operation_folders')
    .select('*')
    .eq('system_code', baseSys)
    .order('name', { ascending: true });

  if (companyId) {
    query = query.eq('company_id', companyId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as OperationFolder[];
}

export async function createOperationFolder(params: {
  systemCode: string;
  companyId?: string | null;
  parentId?: string | null;
  name: string;
  user?: any;
}): Promise<OperationFolder> {
  const supabase = await getSupabaseClient();
  const baseSys = normalizeBaseSystemCode(params.systemCode);
  const { data, error } = await supabase
    .from('operation_folders')
    .insert([
      {
        system_code: baseSys,
        company_id: params.companyId || params.user?.company_id || null,
        parent_id: params.parentId || null,
        name: params.name.trim(),
        created_by: params.user?.id || null,
        created_by_name: params.user?.full_name || 'Nhân viên',
      },
    ])
    .select('*')
    .single();

  if (error) throw error;
  return data as OperationFolder;
}

export async function deleteOperationFolder(folderId: string): Promise<void> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from('operation_folders').delete().eq('id', folderId);
  if (error) throw error;
}

export function buildFolderPathMap(folders: OperationFolder[]): Map<string, string> {
  const byId = new Map<string, OperationFolder>();
  folders.forEach((f) => byId.set(f.id, f));

  const cache = new Map<string, string>();
  const resolve = (id: string, depth = 0): string => {
    if (depth > 10) return '';
    if (cache.has(id)) return cache.get(id)!;
    const node = byId.get(id);
    if (!node) return '';
    const p = node.parent_id ? resolve(node.parent_id, depth + 1) : '';
    const full = p ? `${p}/${node.name}` : node.name;
    cache.set(id, full);
    return full;
  };
  folders.forEach((f) => resolve(f.id));
  return cache;
}

export async function getDriveSettings(systemCode: string): Promise<OperationDriveSettings> {
  const supabase = await getSupabaseClient();
  const baseSys = normalizeBaseSystemCode(systemCode);
  const { data } = await supabase
    .from('operation_drive_settings')
    .select('*')
    .eq('system_code', baseSys)
    .maybeSingle();

  return (
    (data as OperationDriveSettings) || {
      system_code: baseSys,
      webhook_url: '',
      root_folder_name: 'WMS_HinhAnh_Kho',
      auto_sync_enabled: false,
      auto_delete_local_days: null,
    }
  );
}

export async function saveDriveSettings(params: OperationDriveSettings & { userId?: string | null }): Promise<void> {
  const supabase = await getSupabaseClient();
  const baseSys = normalizeBaseSystemCode(params.system_code);
  const { error } = await supabase.from('operation_drive_settings').upsert(
    {
      system_code: baseSys,
      company_id: params.company_id || null,
      webhook_url: params.webhook_url.trim(),
      root_folder_name: params.root_folder_name.trim() || 'WMS_HinhAnh_Kho',
      auto_sync_enabled: !!params.auto_sync_enabled,
      auto_delete_local_days:
        params.auto_delete_local_days != null && params.auto_delete_local_days > 0
          ? Number(params.auto_delete_local_days)
          : null,
      updated_by: params.userId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'system_code' }
  );
  if (error) throw error;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf('base64,');
      resolve(idx >= 0 ? res.slice(idx + 7) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function syncImagesToGoogleDrive(params: {
  images: OperationImageRecord[];
  systemCode: string;
  folders: OperationFolder[];
}): Promise<{ syncedCount: number; failedCount: number; errors: string[] }> {
  const baseSys = normalizeBaseSystemCode(params.systemCode);
  const settings = await getDriveSettings(baseSys);
  const webhookUrl = settings.webhook_url?.trim();
  if (!webhookUrl) {
    throw new Error('Chưa cấu hình Google Drive Webhook URL. Vui lòng nhập trong Cài đặt Drive.');
  }

  const rootFolder = settings.root_folder_name?.trim() || 'WMS_HinhAnh_Kho';
  const folderPathMap = buildFolderPathMap(params.folders);
  const supabase = await getSupabaseClient();

  let syncedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const img of params.images) {
    if (img.is_offline || img.drive_file_id) {
      if (img.drive_file_id) syncedCount++;
      continue;
    }

    try {
      const res = await fetch(img.public_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const base64 = await blobToBase64(blob);

      const dt = new Date(img.captured_at || Date.now());
      const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const customFolder = img.folder_id ? folderPathMap.get(img.folder_id) : null;
      const subName = customFolder || (img.job_name ? img.job_name.replace(/[\\/:*?"<>|]/g, '_') : 'Chung');
      const folderPath = `${baseSys}/${ym}/${subName}`;
      const safeItem = (img.item_name || img.scope || 'anh').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const filename = `${safeItem}_${dt.getTime()}.jpg`;

      const driveRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootFolder,
          folderPath,
          filename,
          mimeType: img.mime_type || 'image/jpeg',
          base64,
        }),
      });

      const driveJson = await driveRes.json();
      if (!driveJson?.success) {
        throw new Error(driveJson?.error || 'Apps Script trả về lỗi');
      }

      await supabase
        .from('operation_images')
        .update({
          drive_file_id: driveJson.fileId || null,
          drive_web_url: driveJson.fileUrl || null,
          drive_synced_at: new Date().toISOString(),
        })
        .eq('id', img.id);

      syncedCount++;
    } catch (e: any) {
      failedCount++;
      errors.push(`${img.item_name || img.id}: ${e?.message || e}`);
    }
  }

  return { syncedCount, failedCount, errors };
}
