import * as SQLite from 'expo-sqlite';
import { Pallet, BoxLabel, ParsedLabelData, ParsedStampData, AppConfig, StampDictionaryItem, StampFormat, CloudPallet } from '../types';
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
      tag TEXT,
      notes TEXT,
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

    CREATE TABLE IF NOT EXISTS stamp_formats (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      is_default INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      line1_config TEXT NOT NULL,
      line2_config TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cloud_pallets_cache (
      id TEXT PRIMARY KEY,
      stt TEXT NOT NULL,
      lot_code TEXT,
      lot_id TEXT,
      boxes_count INTEGER DEFAULT 0,
      total_weight REAL DEFAULT 0,
      is_linked INTEGER DEFAULT 1,
      status TEXT,
      product_name TEXT,
      sku TEXT,
      product_aliases TEXT,
      tag TEXT,
      notes TEXT,
      production_place TEXT,
      material_zone TEXT,
      packaging_date TEXT,
      production_date TEXT,
      location_code TEXT,
      created_at TEXT,
      cached_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cpc_stt ON cloud_pallets_cache (stt);
    CREATE INDEX IF NOT EXISTS idx_cpc_lot_code ON cloud_pallets_cache (lot_code);
    CREATE INDEX IF NOT EXISTS idx_cpc_product_name ON cloud_pallets_cache (product_name);
    CREATE INDEX IF NOT EXISTS idx_cpc_packaging_date ON cloud_pallets_cache (packaging_date);
    CREATE INDEX IF NOT EXISTS idx_cpc_production_date ON cloud_pallets_cache (production_date);

    CREATE TABLE IF NOT EXISTS products_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT,
      aliases TEXT,
      system_type TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cloud_boxes_cache (
      id TEXT PRIMARY KEY,
      pallet_stt TEXT NOT NULL,
      lot_id TEXT,
      code TEXT,
      box_index TEXT,
      quantity REAL,
      unit TEXT,
      sku TEXT,
      product_name TEXT,
      lot_code TEXT,
      shift_group TEXT,
      region TEXT,
      production_date TEXT,
      packaging_date TEXT,
      spec TEXT,
      scan_type TEXT,
      stamp_line1 TEXT,
      stamp_line2 TEXT,
      raw_text TEXT,
      created_at TEXT,
      cached_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cbc_pallet_stt ON cloud_boxes_cache (pallet_stt);
    CREATE INDEX IF NOT EXISTS idx_cbc_lot_id ON cloud_boxes_cache (lot_id);
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
    await db.execAsync(`ALTER TABLE pallets ADD COLUMN tag TEXT;`);
  } catch {}
  try {
    await db.execAsync(`ALTER TABLE pallets ADD COLUMN notes TEXT;`);
  } catch {}
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

export async function createNewPallet(
  code: string,
  targetQty: number = 30,
  systemCode: string = 'KHO_DONG_LANH',
  tag?: string | null,
  notes?: string | null
): Promise<Pallet> {
  const db = await getDb();
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const now = new Date().toISOString();
  const cleanTag = tag ? tag.trim().toUpperCase() : null;
  const cleanNotes = notes ? notes.trim() : null;

  await db.runAsync(
    `INSERT INTO pallets (id, code, tag, notes, target_qty, scanned_qty, total_weight, system_code, status, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'active', 'pending', ?, ?)`,
    [id, code.trim().toUpperCase(), cleanTag, cleanNotes, targetQty, systemCode, now, now]
  );

  return {
    id,
    code: code.trim().toUpperCase(),
    tag: cleanTag,
    notes: cleanNotes,
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

export async function updatePalletTag(palletId: string, tag: string | null): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const cleanTag = tag ? tag.trim().toUpperCase() : null;
  await db.runAsync(
    `UPDATE pallets SET tag = ?, updated_at = ? WHERE id = ?`,
    [cleanTag, now, palletId]
  );
}

export async function updatePalletNotes(palletId: string, notes: string | null): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const cleanNotes = notes ? notes.trim() : null;
  await db.runAsync(
    `UPDATE pallets SET notes = ?, updated_at = ? WHERE id = ?`,
    [cleanNotes, now, palletId]
  );
}

export async function updatePalletTagAndNotes(palletId: string, tag: string | null, notes: string | null): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const cleanTag = tag ? tag.trim().toUpperCase() : null;
  const cleanNotes = notes ? notes.trim() : null;
  await db.runAsync(
    `UPDATE pallets SET tag = ?, notes = ?, updated_at = ? WHERE id = ?`,
    [cleanTag, cleanNotes, now, palletId]
  );
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
      throw new Error(`Thùng #${data.box_index} (LOT ${data.lot_code}) đã được quét trên Pallet này rồi!`);
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
  const cleanSku = decoded.special_12_code
    ? decoded.special_12_code
    : (decoded.fruit_type_code 
        ? `${decoded.fruit_type_code}${decoded.freeze_style_code || '00'}${decoded.variety_code || '00'}${decoded.product_grade_code || '00'}`
        : (stampData.stamp_line1 || 'STAMP'));
  const specText = decoded.is_special_12
    ? (decoded.package_spec_name ? `${decoded.package_spec_name}${decoded.freeze_method_name ? ` (${decoded.freeze_method_name})` : ''}` : 'Ngoại lệ trọn gói')
    : (decoded.package_spec_name ? `${decoded.package_spec_name} (${decoded.freeze_method_name || 'Hầm đông'})` : '');

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
    production_date: '',
    packaging_date: decoded.packaging_date || '',
    raw_material_date: decoded.raw_material_date || decoded.inbound_date || '',
    supplier: decoded.supplier_code,
    supplier_name: decoded.supplier_name,
    is_special_12: decoded.is_special_12,
    special_12_code: decoded.special_12_code,
    special_12_name: decoded.special_12_name,
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

/**
 * Nhân bản một thùng mẫu sang nhiều thùng tiếp theo trên cùng một Pallet
 * - Tự động bỏ qua số index trên tem gốc và gán index liên tiếp chưa sử dụng
 * - Sao chép toàn bộ thông tin (SKU, Lot, Ngày SX, Ngày ĐG, Vùng, Dấu mực...)
 */
export async function cloneBoxToPallet(
  palletId: string,
  sampleBox: BoxLabel,
  quantityToClone: number
): Promise<{ addedCount: number; newBoxes: BoxLabel[] }> {
  if (quantityToClone <= 0) return { addedCount: 0, newBoxes: [] };

  const db = await getDb();
  const existingBoxes = await db.getAllAsync<{ box_index: string }>(
    `SELECT box_index FROM boxes WHERE pallet_id = ?`,
    [palletId]
  );

  const usedIndexes = new Set<number>();
  existingBoxes.forEach(b => {
    const num = parseInt(b.box_index, 10);
    if (!isNaN(num) && num > 0) usedIndexes.add(num);
  });

  // Tìm danh sách số index chưa sử dụng tiếp theo
  let candidateIndex = 1;
  const newIndexes: string[] = [];
  while (newIndexes.length < quantityToClone) {
    if (!usedIndexes.has(candidateIndex)) {
      newIndexes.push(String(candidateIndex));
      usedIndexes.add(candidateIndex);
    }
    candidateIndex++;
  }

  const now = new Date().toISOString();
  const createdBoxes: BoxLabel[] = [];

  for (let i = 0; i < newIndexes.length; i++) {
    const newIdx = newIndexes[i];
    const newId = 'bx_cl_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 6);

    await db.runAsync(
      `INSERT INTO boxes (
        id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
        shift_group, region, production_date, packaging_date, spec, raw_text,
        scan_type, stamp_line1, stamp_line2, sync_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        newId, palletId, sampleBox.sku || 'UNKNOWN', sampleBox.lot_code || 'UNKNOWN',
        sampleBox.product_name, newIdx, sampleBox.weight || 20, sampleBox.unit || 'Kg',
        sampleBox.shift_group || '', sampleBox.region || '', sampleBox.production_date || '',
        sampleBox.packaging_date || '', sampleBox.spec || '', sampleBox.raw_text || '',
        sampleBox.scan_type || 'label', sampleBox.stamp_line1 || null, sampleBox.stamp_line2 || null,
        now
      ]
    );

    createdBoxes.push({
      ...sampleBox,
      id: newId,
      box_index: newIdx,
      created_at: now,
      sync_status: 'pending'
    });
  }

  // Cập nhật lại số lượng và tổng trọng lượng của Pallet
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );

  return { addedCount: createdBoxes.length, newBoxes: createdBoxes };
}

/**
 * Thêm hàng loạt thùng từ con dấu mực vừa quét vào Pallet (nhân bản dấu mực)
 */
export async function addStampBoxesBulkToPallet(
  palletId: string,
  stampData: ParsedStampData,
  weight: number = 20,
  countToCreate: number = 1
): Promise<{ addedCount: number; newBoxes: BoxLabel[] }> {
  if (countToCreate <= 0) return { addedCount: 0, newBoxes: [] };

  const db = await getDb();

  let dictMap: Record<string, Record<string, string>> = DEFAULT_STAMP_DICTIONARY;
  try {
    dictMap = await getStampDictionariesMap();
  } catch {}

  const decoded = decodeStamp(stampData.stamp_line1, stampData.stamp_line2, dictMap);
  const productName = decoded.product_name_full || 'Thùng đóng dấu mực';
  const cleanSku = decoded.special_12_code
    ? decoded.special_12_code
    : (decoded.fruit_type_code 
        ? `${decoded.fruit_type_code}${decoded.freeze_style_code || '00'}${decoded.variety_code || '00'}${decoded.product_grade_code || '00'}`
        : (stampData.stamp_line1 || 'STAMP'));
  const specText = decoded.is_special_12
    ? (decoded.package_spec_name ? `${decoded.package_spec_name}${decoded.freeze_method_name ? ` (${decoded.freeze_method_name})` : ''}` : 'Ngoại lệ trọn gói')
    : (decoded.package_spec_name ? `${decoded.package_spec_name} (${decoded.freeze_method_name || 'Hầm đông'})` : '');

  // Lấy danh sách số index đang có
  const existingBoxes = await db.getAllAsync<{ box_index: string }>(
    `SELECT box_index FROM boxes WHERE pallet_id = ?`,
    [palletId]
  );
  const usedIndexes = new Set<number>();
  existingBoxes.forEach(b => {
    const num = parseInt(b.box_index, 10);
    if (!isNaN(num) && num > 0) usedIndexes.add(num);
  });

  let candidateIndex = 1;
  const newIndexes: string[] = [];
  while (newIndexes.length < countToCreate) {
    if (!usedIndexes.has(candidateIndex)) {
      newIndexes.push(String(candidateIndex));
      usedIndexes.add(candidateIndex);
    }
    candidateIndex++;
  }

  const now = new Date().toISOString();
  const createdBoxes: BoxLabel[] = [];

  for (let i = 0; i < newIndexes.length; i++) {
    const newIdx = newIndexes[i];
    const newId = 'bx_st_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substring(2, 7);

    await db.runAsync(
      `INSERT INTO boxes (
        id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
        shift_group, region, production_date, packaging_date, spec, raw_text,
        scan_type, stamp_line1, stamp_line2, sync_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Kg', ?, ?, ?, ?, ?, ?, 'stamp', ?, ?, 'pending', ?)`,
      [
        newId, palletId, cleanSku, stampData.stamp_line2 || 'STAMP',
        productName, newIdx, weight,
        decoded.factory_name || '', decoded.province_name || '',
        decoded.inbound_date || '', decoded.packaging_date || '', specText,
        stampData.raw_text, stampData.stamp_line1, stampData.stamp_line2, now
      ]
    );

    createdBoxes.push({
      id: newId,
      pallet_id: palletId,
      sku: cleanSku,
      lot_code: stampData.stamp_line2 || 'STAMP',
      product_name: productName,
      box_index: newIdx,
      weight,
      unit: 'Kg',
      shift_group: decoded.factory_name || '',
      region: decoded.province_name || '',
      production_date: '',
      packaging_date: decoded.packaging_date || '',
      raw_material_date: decoded.raw_material_date || decoded.inbound_date || '',
      supplier: decoded.supplier_code,
      supplier_name: decoded.supplier_name,
      is_special_12: decoded.is_special_12,
      special_12_code: decoded.special_12_code,
      special_12_name: decoded.special_12_name,
      spec: specText,
      scan_type: 'stamp',
      stamp_line1: stampData.stamp_line1,
      stamp_line2: stampData.stamp_line2,
      raw_text: stampData.raw_text,
      sync_status: 'pending',
      created_at: now
    });
  }

  // Cập nhật lại số lượng và tổng trọng lượng của Pallet
  await db.runAsync(
    `UPDATE pallets SET 
       scanned_qty = (SELECT COUNT(*) FROM boxes WHERE pallet_id = ?),
       total_weight = (SELECT COALESCE(SUM(weight), 0) FROM boxes WHERE pallet_id = ?),
       updated_at = ?
     WHERE id = ?`,
    [palletId, palletId, now, palletId]
  );

  return { addedCount: createdBoxes.length, newBoxes: createdBoxes };
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

export async function saveStampFormats(formats: StampFormat[]): Promise<void> {
  if (!formats || formats.length === 0) return;
  const db = await getDb();

  for (const f of formats) {
    await db.runAsync(
      `INSERT OR REPLACE INTO stamp_formats (id, code, name, description, is_default, is_active, line1_config, line2_config, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id || f.code,
        f.code,
        f.name,
        f.description || null,
        f.is_default ? 1 : 0,
        f.is_active !== false ? 1 : 0,
        typeof f.line1_config === 'string' ? f.line1_config : JSON.stringify(f.line1_config),
        typeof f.line2_config === 'string' ? f.line2_config : JSON.stringify(f.line2_config),
        f.updated_at || new Date().toISOString()
      ]
    );
  }
}

export async function getActiveStampFormat(): Promise<StampFormat | null> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{
      id: string;
      code: string;
      name: string;
      description: string | null;
      is_default: number;
      is_active: number;
      line1_config: string;
      line2_config: string;
      updated_at: string | null;
    }>(
      `SELECT * FROM stamp_formats WHERE is_active = 1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`
    );

    if (!row) return null;

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      is_default: row.is_default === 1,
      is_active: row.is_active === 1,
      line1_config: typeof row.line1_config === 'string' ? JSON.parse(row.line1_config) : row.line1_config,
      line2_config: typeof row.line2_config === 'string' ? JSON.parse(row.line2_config) : row.line2_config,
      updated_at: row.updated_at || undefined
    };
  } catch (err) {
    console.warn('Error reading active stamp format:', err);
    return null;
  }
}

export async function saveCloudPalletToLocal(
  cloudPallet: import('../types').CloudPallet,
  boxes: BoxLabel[]
): Promise<Pallet> {
  const db = await getDb();
  const cleanCode = cloudPallet.stt.trim().toUpperCase();
  let existing = await getPalletByCode(cleanCode);
  const now = cloudPallet.created_at || new Date().toISOString();
  let palletId = existing?.id;

  if (!existing) {
    palletId = 'pl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    await db.runAsync(
      `INSERT INTO pallets (
        id, code, tag, notes, target_qty, scanned_qty, total_weight,
        system_code, status, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'default', 'completed', 'synced', ?, ?)`,
      [
        palletId,
        cleanCode,
        cloudPallet.tag || null,
        cloudPallet.notes || null,
        cloudPallet.boxes_count || boxes.length || 30,
        boxes.length,
        cloudPallet.total_weight || 0,
        now,
        now
      ]
    );
  } else {
    palletId = existing.id;
    await db.runAsync(
      `UPDATE pallets SET
         tag = COALESCE(?, tag),
         notes = COALESCE(?, notes),
         scanned_qty = ?,
         total_weight = ?,
         sync_status = 'synced',
         updated_at = ?
       WHERE id = ?`,
      [
        cloudPallet.tag || null,
        cloudPallet.notes || null,
        boxes.length,
        cloudPallet.total_weight || 0,
        now,
        palletId
      ]
    );
  }

  if (boxes.length > 0) {
    await db.runAsync(`DELETE FROM boxes WHERE pallet_id = ?`, [palletId]);
    for (const b of boxes) {
      await db.runAsync(
        `INSERT INTO boxes (
          id, pallet_id, sku, lot_code, product_name, box_index, weight, unit,
          shift_group, region, production_date, packaging_date, spec, raw_text,
          scan_type, stamp_line1, stamp_line2, sync_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`,
        [
          b.id,
          palletId,
          b.sku || 'SKU',
          b.lot_code || 'LOT',
          b.product_name || 'Hàng đông lạnh',
          b.box_index || '1',
          b.weight || 20,
          b.unit || 'Kg',
          b.shift_group || '',
          b.region || '',
          b.production_date || '',
          b.packaging_date || '',
          b.spec || '',
          b.raw_text || '',
          b.scan_type || 'stamp',
          b.stamp_line1 || null,
          b.stamp_line2 || null,
          b.created_at || now
        ]
      );
    }
  }

  const result = await db.getFirstAsync<Pallet>(`SELECT * FROM pallets WHERE id = ?`, [palletId]);
  return result!;
}

// ── CLOUD PALLETS OFFLINE CACHE (XEM OFFLINE) ─────────────────────

/**
 * Lưu danh sách LOT đã lên Web mẹ vào SQLite để xem ngoại tuyến (Offline)
 */
export async function saveCloudPalletsToCache(
  items: CloudPallet[],
  isFullReplace = false
): Promise<number> {
  if (!items || items.length === 0) return 0;
  try {
    const db = await getDb();
    const now = new Date().toISOString();

    if (isFullReplace) {
      await db.runAsync('DELETE FROM cloud_pallets_cache');
    }

    for (const cp of items) {
      await db.runAsync(
        `INSERT OR REPLACE INTO cloud_pallets_cache (
          id, stt, lot_code, lot_id, boxes_count, total_weight, is_linked,
          status, product_name, sku, product_aliases, tag, notes,
          production_place, material_zone, packaging_date, production_date,
          location_code, created_at, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cp.id,
          cp.stt,
          cp.lot_code || null,
          cp.lot_id || null,
          cp.boxes_count || 0,
          cp.total_weight || 0,
          cp.is_linked ? 1 : 0,
          cp.status || null,
          cp.product_name || null,
          cp.sku || null,
          cp.product_aliases || null,
          cp.tag || null,
          cp.notes || null,
          cp.production_place || null,
          cp.material_zone || null,
          cp.packaging_date || null,
          cp.production_date || null,
          cp.location_code || null,
          cp.created_at || now,
          now
        ]
      );
    }
    return items.length;
  } catch (err) {
    console.warn('saveCloudPalletsToCache warning:', err);
    return 0;
  }
}

/**
 * Đọc toàn bộ danh sách LOT từ SQLite cache (không cần mạng, 0ms)
 */
export async function getCloudPalletsFromCache(): Promise<CloudPallet[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<any>(
      `SELECT * FROM cloud_pallets_cache ORDER BY created_at DESC`
    );

    return rows.map(r => ({
      id: r.id,
      stt: r.stt,
      lot_code: r.lot_code,
      lot_id: r.lot_id,
      boxes_count: r.boxes_count,
      total_weight: r.total_weight,
      is_linked: r.is_linked === 1,
      status: r.status,
      product_name: r.product_name,
      sku: r.sku,
      product_aliases: r.product_aliases,
      tag: r.tag,
      notes: r.notes,
      production_place: r.production_place,
      material_zone: r.material_zone,
      packaging_date: r.packaging_date,
      production_date: r.production_date,
      location_code: r.location_code,
      created_at: r.created_at
    }));
  } catch (err) {
    console.warn('Error reading cloud_pallets_cache:', err);
    return [];
  }
}

/**
 * Lấy số lượng LOT đang lưu trong SQLite cache
 */
export async function getCloudPalletsCacheCount(): Promise<number> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM cloud_pallets_cache`
    );
    return row?.count || 0;
  } catch {
    return 0;
  }
}

/**
 * Lưu danh mục sản phẩm vào SQLite để tìm kiếm gõ tắt offline
 */
export async function saveProductsToCache(items: any[]): Promise<number> {
  if (!items || items.length === 0) return 0;
  try {
    const db = await getDb();
    const now = new Date().toISOString();

    for (const p of items) {
      await db.runAsync(
        `INSERT OR REPLACE INTO products_cache (id, name, sku, aliases, system_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [p.id, p.name, p.sku || null, p.aliases || null, p.system_type || null, now]
      );
    }
    return items.length;
  } catch (err) {
    console.warn('saveProductsToCache warning:', err);
    return 0;
  }
}

/**
 * Đọc danh mục sản phẩm từ SQLite cache
 */
export async function getProductsFromCache(): Promise<any[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<any>(
      `SELECT id, name, sku, aliases, system_type FROM products_cache ORDER BY name ASC`
    );
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * Lưu danh sách tem thùng của Pallet vào SQLite cache
 */
export async function saveCloudBoxesToCache(stt: string, lotId: string | null | undefined, boxes: BoxLabel[]): Promise<number> {
  if (!boxes || boxes.length === 0) return 0;
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const cleanStt = (stt || '').trim().toUpperCase();

    for (const b of boxes) {
      await db.runAsync(
        `INSERT OR REPLACE INTO cloud_boxes_cache (
          id, pallet_stt, lot_id, code, box_index, quantity, unit,
          sku, product_name, lot_code, shift_group, region,
          production_date, packaging_date, spec, scan_type,
          stamp_line1, stamp_line2, raw_text, created_at, cached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          b.id,
          cleanStt,
          lotId || null,
          (b as any).code || b.id,
          b.box_index || null,
          b.weight || 0,
          b.unit || 'Kg',
          b.sku || null,
          b.product_name || null,
          b.lot_code || null,
          b.shift_group || null,
          b.region || null,
          b.production_date || null,
          b.packaging_date || null,
          b.spec || null,
          b.scan_type || null,
          b.stamp_line1 || null,
          b.stamp_line2 || null,
          b.raw_text || null,
          b.created_at || now,
          now
        ]
      );
    }
    return boxes.length;
  } catch (err) {
    console.warn('saveCloudBoxesToCache warning:', err);
    return 0;
  }
}

/**
 * Đọc danh sách tem thùng của Pallet từ SQLite cache
 */
export async function getCloudBoxesFromCache(stt: string, lotId?: string | null): Promise<BoxLabel[]> {
  try {
    const db = await getDb();
    const cleanStt = (stt || '').trim().toUpperCase();
    let query = `SELECT * FROM cloud_boxes_cache WHERE pallet_stt = ?`;
    let params: any[] = [cleanStt];

    if (lotId) {
      query = `SELECT * FROM cloud_boxes_cache WHERE lot_id = ? OR pallet_stt = ?`;
      params = [lotId, cleanStt];
    }

    const rows = await db.getAllAsync<any>(query, params);
    if (!rows || rows.length === 0) return [];

    const boxes: BoxLabel[] = rows.map(r => {
      const isStamp = r.scan_type === 'stamp' || !!r.stamp_line1 || !!r.stamp_line2;
      let isSpecial12 = false;
      let special12Code = '';
      let special12Name = '';
      const c12 = (r.stamp_line1 || r.sku || '').replace(/[^0-9]/g, '').slice(0, 12);
      if (c12.length >= 12 && DEFAULT_STAMP_DICTIONARY.special_12?.[c12]) {
        isSpecial12 = true;
        special12Code = c12;
        special12Name = DEFAULT_STAMP_DICTIONARY.special_12[c12];
      }

      let supplierCode = '';
      let supplierName = '';
      let rawMaterialDate = r.production_date || '';
      if (isStamp && r.stamp_line2) {
        const cleanL2 = r.stamp_line2.replace(/[^0-9]/g, '');
        if (cleanL2.length >= 16) {
          const DD = cleanL2.substring(5, 7);
          const MM = cleanL2.substring(7, 9);
          const YY = cleanL2.substring(9, 11);
          rawMaterialDate = `${DD}/${MM}/20${YY}`;
          supplierCode = cleanL2.substring(11, 14);
          supplierName = `Mã NCC ${supplierCode}`;
        }
      }

      let specVal = r.spec || '';
      if (isSpecial12 && special12Name) {
        const parts = special12Name.split(' - ').map((s: string) => s.trim());
        specVal = parts.length >= 2 ? `${parts[1]}${parts[2] ? ` (${parts[2]})` : ''}` : 'Ngoại lệ trọn gói';
      }

      return {
        id: r.id,
        pallet_id: 'cloud_' + cleanStt,
        sku: r.sku || 'SKU',
        lot_code: r.lot_code || 'LOT',
        product_name: isSpecial12 ? special12Name : (r.product_name || 'Hàng đông lạnh'),
        box_index: r.box_index || '1',
        weight: Number(r.quantity) || 20,
        unit: r.unit || 'Kg',
        shift_group: r.shift_group || '',
        region: r.region || '',
        production_date: r.production_date || '',
        packaging_date: r.packaging_date || '',
        raw_material_date: rawMaterialDate,
        supplier: supplierCode,
        supplier_name: supplierName,
        spec: specVal,
        raw_text: r.raw_text || '',
        scan_type: isStamp ? 'stamp' : (r.scan_type || 'label'),
        stamp_line1: r.stamp_line1 || null,
        stamp_line2: r.stamp_line2 || null,
        is_special_12: isSpecial12,
        special_12_code: special12Code,
        special_12_name: special12Name,
        sync_status: 'synced',
        created_at: r.created_at
      };
    });

    boxes.sort((a, b) => (parseInt(a.box_index, 10) || 0) - (parseInt(b.box_index, 10) || 0));
    return boxes;
  } catch (err) {
    console.warn('Error reading cloud_boxes_cache:', err);
    return [];
  }
}



