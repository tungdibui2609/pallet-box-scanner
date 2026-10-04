import * as SQLite from 'expo-sqlite';
import { Pallet, BoxLabel, ParsedLabelData, ParsedStampData, AppConfig, StampDictionaryItem } from '../types';
import { decodeStamp, DEFAULT_STAMP_DICTIONARY } from './stampParser';

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync('anywarehouse_scanner.db');
    await initTables(dbInstance);
  }
  return dbInstance;
}

async function initTables(db: SQLite.SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS pallets (
      id TEXT PRIMARY KEY NOT NULL,
      code TEXT NOT NULL,
      target_qty INTEGER NOT NULL DEFAULT 30,
      scanned_qty INTEGER NOT NULL DEFAULT 0,
      total_weight REAL NOT NULL DEFAULT 0,
      system_code TEXT NOT NULL DEFAULT 'KHO_DONG_LANH',
      status TEXT NOT NULL DEFAULT 'active',
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boxes (
      id TEXT PRIMARY KEY NOT NULL,
      pallet_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      lot_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      box_index TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 20,
      unit TEXT NOT NULL DEFAULT 'Kg',
      shift_group TEXT,
      region TEXT,
      production_date TEXT,
      packaging_date TEXT,
      spec TEXT,
      raw_text TEXT,
      scan_type TEXT DEFAULT 'label',
      stamp_line1 TEXT,
      stamp_line2 TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (pallet_id) REFERENCES pallets (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stamp_dictionaries (
      category TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      PRIMARY KEY (category, code)
    );
  `);

  // Tự động nạp dữ liệu từ điển mặc định nếu chưa có
  try {
    const countRow = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM stamp_dictionaries`
    );
    if (!countRow || countRow.count === 0) {
      for (const [category, codes] of Object.entries(DEFAULT_STAMP_DICTIONARY)) {
        for (const [code, name] of Object.entries(codes)) {
          await db.runAsync(
            `INSERT OR IGNORE INTO stamp_dictionaries (category, code, name, sort_order) VALUES (?, ?, ?, 0)`,
            [category, code, name]
          );
        }
      }
    }
  } catch (err) {
    console.warn('Init stamp_dictionaries warning:', err);
  }

  // Migrate existing tables if columns are missing
  try {
    await db.execAsync(`ALTER TABLE boxes ADD COLUMN scan_type TEXT DEFAULT 'label';`);
  } catch {}
  try {
    await db.execAsync(`ALTER TABLE boxes ADD COLUMN stamp_line1 TEXT;`);
  } catch {}
  try {
    await db.execAsync(`ALTER TABLE boxes ADD COLUMN stamp_line2 TEXT;`);
  } catch {}
}

// ── Pallet operations ─────────────────────────────────────────

export async function createNewPallet(code: string, targetQty: number = 30, systemCode: string = 'KHO_DONG_LANH'): Promise<Pallet> {
  const db = await getDb();
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO pallets (id, code, target_qty, scanned_qty, total_weight, system_code, status, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, ?, 'active', 'pending', ?, ?)`,
    [id, code.trim().toUpperCase(), targetQty, systemCode, now, now]
  );

  return {
    id,
    code: code.trim().toUpperCase(),
    target_qty: targetQty,
    scanned_qty: 0,
    total_weight: 0,
    system_code: systemCode,
    status: 'active',
    sync_status: 'pending',
    created_at: now,
    updated_at: now
  };
}

export async function getActivePallet(): Promise<Pallet | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Pallet>(
    `SELECT * FROM pallets WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  return row || null;
}

export async function getAllPallets(): Promise<Pallet[]> {
  const db = await getDb();
  return await db.getAllAsync<Pallet>(
    `SELECT * FROM pallets ORDER BY created_at DESC`
  );
}

export async function completePallet(palletId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE pallets SET status = 'completed', updated_at = ? WHERE id = ?`,
    [now, palletId]
  );
}

export async function deletePallet(palletId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM boxes WHERE pallet_id = ?`, [palletId]);
  await db.runAsync(`DELETE FROM pallets WHERE id = ?`, [palletId]);
}

export async function getPalletByCode(code: string): Promise<Pallet | null> {
  const db = await getDb();
  const cleanCode = code.trim().toUpperCase();
  const row = await db.getFirstAsync<Pallet>(
    `SELECT * FROM pallets WHERE code = ? ORDER BY created_at DESC LIMIT 1`,
    [cleanCode]
  );
  return row || null;
}

export async function resetPalletBoxes(palletId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(`DELETE FROM boxes WHERE pallet_id = ?`, [palletId]);
  await db.runAsync(
    `UPDATE pallets SET scanned_qty = 0, total_weight = 0, status = 'active', sync_status = 'pending', updated_at = ? WHERE id = ?`,
    [now, palletId]
  );
}

export async function activateExistingPallet(palletId: string): Promise<Pallet | null> {
  const db = await getDb();
  const now = new Date().toISOString();
  // Deactivate others
  await db.runAsync(`UPDATE pallets SET status = 'completed' WHERE id != ? AND status = 'active'`, [palletId]);
  // Activate target
  await db.runAsync(`UPDATE pallets SET status = 'active', updated_at = ? WHERE id = ?`, [now, palletId]);
  return await db.getFirstAsync<Pallet>(`SELECT * FROM pallets WHERE id = ?`, [palletId]);
}

// ── Box operations ───────────────────────────────────────────

export async function getBoxesByPallet(palletId: string): Promise<BoxLabel[]> {
  const db = await getDb();
  return await db.getAllAsync<BoxLabel>(
    `SELECT * FROM boxes WHERE pallet_id = ? ORDER BY created_at DESC`,
    [palletId]
  );
}

export async function addBoxToPallet(
  palletId: string,
  data: ParsedLabelData
): Promise<{ box: BoxLabel }> {
  const db = await getDb();

  // DUPLICATE CHECK: Verify if this box (lot_code + box_index) is already scanned in this pallet!
  if (data.box_index && data.lot_code) {
    const existing = await db.getFirstAsync<BoxLabel>(
      `SELECT * FROM boxes WHERE pallet_id = ? AND lot_code = ? AND box_index = ?`,
      [palletId, data.lot_code, data.box_index]
    );

    if (existing) {
      throw new Error(`Thùng #${data.box_index} (Lô ${data.lot_code}) đã được quét trên Pallet này rồi!`);
    }
  }

  const id = 'bx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO boxes (
      id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
      shift_group, region, production_date, packaging_date, spec, raw_text, sync_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id, palletId, data.sku || 'UNKNOWN', data.lot_code || 'UNKNOWN',
      data.product_name, data.box_index || 'N/A', data.weight || 20, data.unit || 'Kg',
      data.shift_group || '', data.region || '', data.production_date || '',
      data.packaging_date || '', data.spec || '', data.raw_text || '', now
    ]
  );

  // Update scanned_qty and total_weight in pallets table
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );

  const newBox: BoxLabel = {
    id,
    pallet_id: palletId,
    sku: data.sku,
    lot_code: data.lot_code,
    product_name: data.product_name,
    box_index: data.box_index,
    weight: data.weight,
    unit: data.unit,
    shift_group: data.shift_group,
    region: data.region,
    production_date: data.production_date,
    packaging_date: data.packaging_date,
    spec: data.spec,
    raw_text: data.raw_text,
    scan_type: 'label',
    sync_status: 'pending',
    created_at: now
  };

  return { box: newBox };
}

export async function addStampBoxToPallet(
  palletId: string,
  stampData: ParsedStampData,
  weight: number = 20,
  customIndex?: string
): Promise<{ box: BoxLabel }> {
  const db = await getDb();
  const existingCountRow = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM boxes WHERE pallet_id = ?`,
    [palletId]
  );
  const currentCount = existingCountRow?.count || 0;
  const boxIdx = customIndex || String(currentCount + 1);

  // Kiểm tra trùng: Nếu cả 2 dòng số đóng dấu đã được quét trên cùng Pallet này
  if (stampData.stamp_line1 && stampData.stamp_line2) {
    const existing = await db.getFirstAsync<BoxLabel>(
      `SELECT * FROM boxes WHERE pallet_id = ? AND stamp_line1 = ? AND stamp_line2 = ?`,
      [palletId, stampData.stamp_line1, stampData.stamp_line2]
    );
    if (existing) {
      throw new Error(`Dấu đóng này (#${existing.box_index} - Dòng 1: ${stampData.stamp_line1}) đã được quét trên Pallet này rồi!`);
    }
  }

  // Lấy bộ từ điển để tự động giải mã dãy số đóng dấu sang tiếng Việt
  let dictMap: Record<string, Record<string, string>> = DEFAULT_STAMP_DICTIONARY;
  try {
    dictMap = await getStampDictionariesMap();
  } catch {}

  const decoded = decodeStamp(stampData.stamp_line1, stampData.stamp_line2, dictMap);

  const productName = decoded.product_name_full || 'Thùng đóng dấu mực';
  const cleanSku = decoded.fruit_type_code 
    ? `${decoded.fruit_type_code}${decoded.freeze_style_code || '00'}${decoded.variety_code || '00'}${decoded.product_grade_code || '00'}`
    : (stampData.stamp_line1 || 'STAMP');
  const specText = decoded.package_spec_name 
    ? `${decoded.package_spec_name} (${decoded.freeze_method_name || 'Hầm đông'})` 
    : '';

  const id = 'bx_st_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO boxes (
      id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
      shift_group, region, production_date, packaging_date, spec, raw_text,
      scan_type, stamp_line1, stamp_line2, sync_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Kg', ?, ?, ?, ?, ?, ?, 'stamp', ?, ?, 'pending', ?)`,
    [
      id, palletId, cleanSku, stampData.stamp_line2 || 'STAMP',
      productName, boxIdx, weight,
      decoded.factory_name || '', decoded.province_name || '',
      decoded.inbound_date || '', decoded.packaging_date || '', specText,
      stampData.raw_text, stampData.stamp_line1, stampData.stamp_line2, now
    ]
  );

  // Update scanned_qty and total_weight in pallets table
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );

  const newBox: BoxLabel = {
    id,
    pallet_id: palletId,
    sku: cleanSku,
    lot_code: stampData.stamp_line2 || 'STAMP',
    product_name: productName,
    box_index: boxIdx,
    weight,
    unit: 'Kg',
    shift_group: decoded.factory_name || '',
    region: decoded.province_name || '',
    production_date: decoded.inbound_date || '',
    packaging_date: decoded.packaging_date || '',
    spec: specText,
    scan_type: 'stamp',
    stamp_line1: stampData.stamp_line1,
    stamp_line2: stampData.stamp_line2,
    raw_text: stampData.raw_text,
    sync_status: 'pending',
    created_at: now
  };

  return { box: newBox };
}

export async function deleteBox(boxId: string, palletId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM boxes WHERE id = ?`, [boxId]);
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );
}

// ── Sync status ───────────────────────────────────────────────

export async function markPalletSynced(palletId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE pallets SET sync_status = 'synced', sync_error = NULL, updated_at = ? WHERE id = ?`,
    [now, palletId]
  );
  await db.runAsync(
    `UPDATE boxes SET sync_status = 'synced' WHERE pallet_id = ?`,
    [palletId]
  );
}

export async function markPalletSyncError(palletId: string, error: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE pallets SET sync_status = 'error', sync_error = ?, updated_at = ? WHERE id = ?`,
    [error, now, palletId]
  );
}

export async function getPendingSyncPallets(): Promise<{ pallet: Pallet; boxes: BoxLabel[] }[]> {
  const db = await getDb();
  const pallets = await db.getAllAsync<Pallet>(
    `SELECT * FROM pallets WHERE sync_status = 'pending' OR sync_status = 'error'`
  );
  
  const results = [];
  for (const p of pallets) {
    const boxes = await db.getAllAsync<BoxLabel>(
      `SELECT * FROM boxes WHERE pallet_id = ?`,
      [p.id]
    );
    results.push({ pallet: p, boxes });
  }
  return results;
}

export async function replacePalletBoxesFromCloud(
  palletId: string,
  cloudBoxes: any[]
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  // Xóa các thùng hiện tại của Pallet này trong SQLite để nạp lại từ Cloud
  await db.runAsync('DELETE FROM boxes WHERE pallet_id = ?', [palletId]);

  for (const cb of cloudBoxes) {
    const id = cb.id || ('bx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));
    let boxIndex = 'N/A';
    if (cb.code) {
      const parts = cb.code.split('-');
      const last = parts[parts.length - 1];
      if (!isNaN(parseInt(last))) {
        boxIndex = parseInt(last, 10).toString();
      }
    }
    const weight = parseFloat(cb.quantity) || 20;

    await db.runAsync(
      `INSERT INTO boxes (
        id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
        shift_group, region, production_date, packaging_date, spec, raw_text, sync_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
      [
        id,
        palletId,
        cb.products?.sku || cb.sku || 'SKU',
        cb.finished_lot_code || cb.semi_finished_lot_code || 'LOT',
        cb.products?.name || cb.products?.internal_name || 'Hàng đông lạnh',
        boxIndex,
        weight,
        cb.unit || 'Kg',
        cb.shift_group || '',
        cb.region || '',
        cb.production_date || '',
        cb.packaging_date || '',
        cb.spec || '',
        cb.raw_text || '',
        cb.created_at || now
      ]
    );
  }

  // Cập nhật lại số lượng và tổng kg của Pallet
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       sync_status = 'synced',
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );
}

// ── QUẢN LÝ TỪ ĐIỂN DẤU ĐÓNG TRONG SQLITE ───────────────────────

export async function saveStampDictionaries(items: StampDictionaryItem[]): Promise<number> {
  const db = await getDb();
  let count = 0;

  for (const item of items) {
    if (!item.category || !item.code || !item.name) continue;
    await db.runAsync(
      `INSERT OR REPLACE INTO stamp_dictionaries (category, code, name, description, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [
        item.category.trim(),
        item.code.trim().toUpperCase(),
        item.name.trim(),
        item.description || null,
        item.sort_order || 0
      ]
    );
    count++;
  }

  return count;
}

export async function getStampDictionariesMap(): Promise<Record<string, Record<string, string>>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ category: string; code: string; name: string }>(
    `SELECT category, code, name FROM stamp_dictionaries ORDER BY category, sort_order, code`
  );

  const map: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    if (!map[r.category]) {
      map[r.category] = {};
    }
    map[r.category][r.code.toUpperCase()] = r.name;
  }

  // Merge với fallback mặc định để luôn có giá trị cơ bản
  for (const [cat, codes] of Object.entries(DEFAULT_STAMP_DICTIONARY)) {
    if (!map[cat]) map[cat] = {};
    for (const [c, n] of Object.entries(codes)) {
      if (!map[cat][c]) {
        map[cat][c] = n;
      }
    }
  }

  return map;
}

export async function getStampDictionariesCount(): Promise<number> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM stamp_dictionaries`
    );
    return row?.count || 0;
  } catch {
    return 0;
  }
}

