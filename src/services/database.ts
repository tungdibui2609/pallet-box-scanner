import * as SQLite from 'expo-sqlite';
import { Pallet, BoxLabel, ParsedLabelData, AppConfig } from '../types';

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
      sync_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (pallet_id) REFERENCES pallets (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
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