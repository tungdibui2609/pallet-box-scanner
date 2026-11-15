import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LocalPickedImage } from './operationImagesService';

export interface QuickSnapItem {
  id: string;
  shiftId: string;
  jobName: string;
  systemCode: string;
  capturedAt: string;
  image: LocalPickedImage;
}

const QUICK_SNAPS_KEY = '@wms_quick_snaps_v1';

async function readAllSnaps(): Promise<QuickSnapItem[]> {
  try {
    const raw = await AsyncStorage.getItem(QUICK_SNAPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAllSnaps(items: QuickSnapItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUICK_SNAPS_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn('quickSnapStore write error:', e);
  }
}

export async function getAllQuickSnaps(): Promise<QuickSnapItem[]> {
  const all = await readAllSnaps();
  return all.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export async function getQuickSnapsForShift(shiftId: string): Promise<QuickSnapItem[]> {
  if (!shiftId) return [];
  const all = await readAllSnaps();
  return all
    .filter(x => x.shiftId === shiftId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export async function addQuickSnap(item: QuickSnapItem): Promise<void> {
  const all = await readAllSnaps();
  all.push(item);
  await writeAllSnaps(all);
}

export async function updateQuickSnapShift(
  id: string,
  shiftId: string,
  jobName: string
): Promise<void> {
  const all = await readAllSnaps();
  const next = all.map(x => (x.id === id ? { ...x, shiftId, jobName } : x));
  await writeAllSnaps(next);
}

export async function removeQuickSnap(id: string): Promise<void> {
  const all = await readAllSnaps();
  await writeAllSnaps(all.filter(x => x.id !== id));
}
