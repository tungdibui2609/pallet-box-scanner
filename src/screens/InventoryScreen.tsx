import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { Ionicons, Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import {
  getSupabaseClient,
  getWarehouseMapOfflineData,
  getMemoryWarehouseMapCache,
  syncWarehouseMapOffline,
  ZoneItem,
  PositionItem,
} from '../services/supabase';
import { useAuth } from '../contexts/AuthContext';

const INVENTORY_KEYS = {
  SESSIONS: 'offline_inventory_sessions_v1',
  RESULTS: 'offline_inventory_results_v1',
  USERS_MAP: 'offline_inventory_users_map_v1',
  MEMBERS_MAP: 'offline_inventory_members_map_v1',
};

const isUUID = (str: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(str || ''));

/**
 * Sắp xếp các vị trí trong cùng 1 Ô / Tầng theo quy chuẩn thực tế kho:
 * 1. 2 số cuối cùng của mã vị trí: Nhóm 02 trước, nhóm 01 sau (xếp giảm dần 02 -> 01)
 * 2. Cùng số cuối: Xếp theo chữ cái kệ A -> B -> C
 * Kết quả: A02, B02, C02 rồi đến A01, B01, C01
 */
export function sortPositionsByDepthAndCol<T extends { code?: string | null }>(list: T[]): T[] {
  return [...list].sort((pa, pb) => {
    const codeA = (pa.code || '').trim().toUpperCase();
    const codeB = (pb.code || '').trim().toUpperCase();

    // 1. Lấy 2 số cuối cùng (ví dụ K1D1A08T502 -> 2, K1D1B08T501 -> 1)
    const matchA = codeA.match(/(\d{2})$/);
    const matchB = codeB.match(/(\d{2})$/);
    const depthA = matchA ? parseInt(matchA[1], 10) : 0;
    const depthB = matchB ? parseInt(matchB[1], 10) : 0;

    if (depthA !== depthB) {
      return depthB - depthA;
    }

    // 2. Nếu cùng số cuối (cùng là 02 hoặc cùng là 01): xếp theo chữ cái kệ A -> B -> C
    const colMatchA = codeA.match(/D\d+([A-Z])/i) || codeA.match(/([A-Z])\d{2}T/i) || codeA.match(/([A-Z])\d+/i);
    const colMatchB = codeB.match(/D\d+([A-Z])/i) || codeB.match(/([A-Z])\d{2}T/i) || codeB.match(/([A-Z])\d+/i);
    const colA = colMatchA ? colMatchA[1].toUpperCase() : '';
    const colB = colMatchB ? colMatchB[1].toUpperCase() : '';

    if (colA && colB && colA !== colB) {
      return colA.localeCompare(colB);
    }

    return codeA.localeCompare(codeB, undefined, { numeric: true });
  });
}

/**
 * Gom nhóm các Ô kệ có cùng hậu tố số (A01, B01, C01 -> Ô 01) và các Tầng bên trong,
 * tương đương 100% với hàm groupWarehouseData của qlk-app & Web /work/inventory
 */
function groupInventoryWarehouseData(
  zones: ZoneItem[],
  positions: PositionItem[]
): {
  zones: ZoneItem[];
  positions: Array<PositionItem & { zone_id: string | null; real_zone_id: string | null; real_bin_id: string | null }>;
} {
  const parentToChildren = new Map<string, ZoneItem[]>();
  const zoneParentMap = new Map<string, string>();

  zones.forEach(z => {
    if (z.parent_id) {
      zoneParentMap.set(z.id, z.parent_id);
      const list = parentToChildren.get(z.parent_id) || [];
      list.push(z);
      parentToChildren.set(z.parent_id, list);
    }
  });

  const finalZones: ZoneItem[] = [];
  const zoneIdMap = new Map<string, string>(); // real zone_id -> virtual zone_id
  const processedOldZoneIds = new Set<string>();

  const getChildren = (parentId: string): ZoneItem[] => parentToChildren.get(parentId) || [];

  const processZoneRecursively = (zone: ZoneItem) => {
    if (processedOldZoneIds.has(zone.id)) return;

    finalZones.push(zone);
    processedOldZoneIds.add(zone.id);

    const children = getChildren(zone.id);
    if (children.length === 0) return;

    const isGroupingContainer = /DÃY|SẢNH|KỆ|KHU|SÀNH/i.test(zone.name || '');

    if (isGroupingContainer) {
      const binGroups: Record<string, ZoneItem[]> = {};
      children.forEach(c => {
        const match = (c.name || '').match(/\d+$/);
        const suffix = match ? match[0] : c.name;
        binGroups[suffix] = binGroups[suffix] || [];
        binGroups[suffix].push(c);
      });

      Object.entries(binGroups).forEach(([suffix, members]) => {
        if (members.length > 1) {
          const vBinId = `v-bin-${zone.id}-${suffix}`;
          finalZones.push({
            ...members[0],
            id: vBinId,
            parent_id: zone.id,
            name: `Ô ${suffix}`,
          });

          const levelGroups: Record<string, ZoneItem[]> = {};
          members.forEach(m => {
            const mChildren = getChildren(m.id);
            mChildren.forEach(lvl => {
              const key = (lvl.name || '').trim().toUpperCase();
              levelGroups[key] = levelGroups[key] || [];
              levelGroups[key].push(lvl);
            });
            processedOldZoneIds.add(m.id);
            zoneIdMap.set(m.id, vBinId);
          });

          Object.entries(levelGroups).forEach(([lvlName, lMembers]) => {
            const vLvlId = `v-lvl-${vBinId}-${lvlName}`;
            finalZones.push({
              ...lMembers[0],
              id: vLvlId,
              parent_id: vBinId,
              name: lMembers[0].name,
            });

            lMembers.forEach(lm => {
              zoneIdMap.set(lm.id, vLvlId);
              processedOldZoneIds.add(lm.id);
            });
          });
        } else {
          processZoneRecursively(members[0]);
        }
      });
    } else {
      children.forEach(c => processZoneRecursively(c));
    }
  };

  const roots = zones.filter(z => !z.parent_id);
  roots.forEach(processZoneRecursively);

  zones.forEach(z => {
    if (!processedOldZoneIds.has(z.id)) finalZones.push(z);
  });

  const finalPositions = positions.map(p => {
    const rawZoneId = p.zone_ids && p.zone_ids.length > 0 ? p.zone_ids[0] : null;
    const targetZoneId = (rawZoneId && zoneIdMap.get(rawZoneId)) || rawZoneId;
    const realBinId = rawZoneId ? zoneParentMap.get(rawZoneId) || null : null;
    return {
      ...p,
      real_zone_id: rawZoneId,
      real_bin_id: realBinId,
      zone_id: targetZoneId,
    };
  });

  return { zones: finalZones, positions: finalPositions };
}

// ── Modal Kiểm Kê Chi Tiết Từng Tầng / Nhóm Sảnh ─────────────────────────
const LevelInventoryModal = ({
  level,
  visible,
  onClose,
  inventoryResults,
  togglePositionChecked,
  updatePositionNote,
  bulkCheckPositions,
}: {
  level: any;
  visible: boolean;
  onClose: () => void;
  inventoryResults: Record<string, { checked?: boolean; note?: string }>;
  togglePositionChecked: (posId: string) => void;
  updatePositionNote: (posId: string, note: string) => void;
  bulkCheckPositions: (posIds: string[], checked: boolean) => void;
}) => {
  if (!level) return null;

  const allSlotIds: string[] = (level.slots || []).map((s: any) => s.id);
  const allChecked = allSlotIds.length > 0 && allSlotIds.every(id => inventoryResults[id]?.checked);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View style={styles.levelModalOverlay}>
          <View style={styles.levelModalCard}>
            {/* Header */}
            <View style={styles.levelModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <Text style={styles.levelModalTitle} numberOfLines={1}>
                  {level.name}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    bulkCheckPositions(allSlotIds, !allChecked);
                  }}
                  style={[
                    styles.bulkCheckBtn,
                    allChecked && { backgroundColor: '#065f46', borderColor: '#10b981' },
                  ]}
                >
                  <Feather
                    name={allChecked ? 'rotate-ccw' : 'check-circle'}
                    size={12}
                    color="#34d399"
                  />
                  <Text style={styles.bulkCheckBtnText}>
                    {allChecked ? 'Bỏ tích tất cả' : 'Tích tất cả'}
                  </Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeCircleBtn}>
                <Feather name="x" size={18} color="#e2e8f0" />
              </TouchableOpacity>
            </View>

            {/* Danh sách vị trí trong tầng (được sắp xếp A02, B02, C02 rồi đến A01, B01, C01) */}
            <ScrollView
              style={{ paddingHorizontal: 16, paddingVertical: 10 }}
              keyboardShouldPersistTaps="handled"
            >
              {sortPositionsByDepthAndCol(level.slots || []).map((slot: any, idx: number) => {
                const posKey = slot.id;
                const res = inventoryResults[posKey] || { checked: false, note: '' };
                const isOccupied = Boolean(slot.lot_id);
                const posCode = slot.code || 'N/A';
                const suffix = posCode ? `-${posCode.slice(-2)}` : '';

                return (
                  <View key={`slot-${posKey || idx}`} style={styles.slotCheckCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        {/* Hàng 1: Mã vị trí + Ô thực + STT + LOT + Mã phụ */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 }}>
                          <Text style={styles.slotPosCode}>{posCode}</Text>

                          {slot.zone_name ? (
                            <View style={styles.realBinBadge}>
                              <Text style={styles.realBinBadgeText}>
                                Ô {slot.zone_name}{suffix}
                              </Text>
                            </View>
                          ) : null}

                          {slot.stt ? (
                            <View style={styles.sttPill}>
                              <Text style={styles.sttPillText}>#{slot.stt}</Text>
                            </View>
                          ) : null}

                          {slot.lot_code ? (
                            <View style={styles.lotCodePill}>
                              <Text style={styles.lotCodePillText}>LOT: {slot.lot_code}</Text>
                            </View>
                          ) : null}

                          {(slot.tags || [])
                            .filter((t: string) => t && !t.startsWith('MERGED_') && !t.startsWith('SPLIT_'))
                            .map((tag: string, i: number) => (
                              <View key={`tag-${i}`} style={styles.tagPill}>
                                <Text style={styles.tagPillText}>Mã phụ: {tag}</Text>
                              </View>
                            ))}
                        </View>

                        {/* Hàng 2: Thông tin sản phẩm + Số lượng */}
                        {isOccupied ? (
                          <View style={{ gap: 3, marginTop: 2 }}>
                            <View style={{ borderLeftWidth: 2, borderLeftColor: '#334155', paddingLeft: 8, paddingVertical: 2 }}>
                              {slot.sku ? (
                                <Text style={styles.slotSkuText}>{slot.sku}</Text>
                              ) : null}
                              <Text style={styles.slotProdName}>
                                {slot.product_name || 'Hàng đông lạnh'}
                              </Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 3 }}>
                                <Text style={styles.slotQtyLabel}>
                                  SL:{' '}
                                  <Text style={styles.slotQtyValue}>
                                    {slot.quantity ?? 0} {slot.unit || 'Thùng'}
                                  </Text>
                                </Text>
                                {slot.packaging_date ? (
                                  <Text style={styles.slotDateMeta}>
                                    ĐG: {slot.packaging_date.split('-').reverse().join('/')}
                                  </Text>
                                ) : null}
                                {slot.material_zone ? (
                                  <Text style={styles.slotZoneMeta}>{slot.material_zone}</Text>
                                ) : null}
                              </View>
                            </View>

                            {slot.extra_info ? (
                              <View style={styles.lotNoteBox}>
                                <Feather name="info" size={11} color="#fbbf24" />
                                <Text style={styles.lotNoteText}>{slot.extra_info}</Text>
                              </View>
                            ) : null}
                          </View>
                        ) : (
                          <Text style={styles.emptyPosLabel}>Vị trí trống</Text>
                        )}
                      </View>

                      {/* Nút tích kiểm */}
                      <TouchableOpacity
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          togglePositionChecked(posKey);
                        }}
                        style={[
                          styles.checkBoxBtn,
                          res.checked ? styles.checkBoxBtnChecked : styles.checkBoxBtnUnchecked,
                        ]}
                      >
                        <Feather
                          name="check"
                          size={22}
                          color={res.checked ? '#ffffff' : '#64748b'}
                        />
                      </TouchableOpacity>
                    </View>

                    {/* Ô nhập ghi chú sai lệch */}
                    <View style={[styles.noteInputWrap, Boolean(res.note) && styles.noteInputWrapActive]}>
                      <Feather
                        name="edit-3"
                        size={14}
                        color={res.note ? '#fb7185' : '#64748b'}
                      />
                      <TextInput
                        style={styles.noteInput}
                        placeholder="Ghi chú sai lệch (nếu có)..."
                        placeholderTextColor="#64748b"
                        value={res.note || ''}
                        onChangeText={val => updatePositionNote(posKey, val)}
                      />
                      {res.note ? (
                        <TouchableOpacity onPress={() => updatePositionNote(posKey, '')}>
                          <Feather name="x-circle" size={14} color="#fb7185" />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                );
              })}
              <View style={{ height: 12 }} />
            </ScrollView>

            {/* Footer */}
            <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: '#1e293b' }}>
              <TouchableOpacity onPress={onClose} style={styles.doneModalBtn}>
                <Text style={styles.doneModalBtnText}>HOÀN TẤT</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

// ── Màn Hình Chính: Kiểm Kê Kho ──────────────────────────────────────────
export default function InventoryScreen({ isActive }: { isActive?: boolean } = {}) {
  const { user } = useAuth();
  const initialMemory = getMemoryWarehouseMapCache();

  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');
  const [loading, setLoading] = useState(false);
  const [downloadingMap, setDownloadingMap] = useState(false);

  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSession, setCurrentSession] = useState<any>(null);
  const [inventoryResults, setInventoryResults] = useState<Record<string, any>>({});
  const [allInventoryResults, setAllInventoryResults] = useState<Record<string, Record<string, any>>>({});
  const [syncingRef, setSyncingRef] = useState<Record<string, boolean>>({});
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' | 'warning' | 'info' } | null>(null);

  const [zones, setZones] = useState<ZoneItem[]>(initialMemory?.zones || []);
  const [rawPositions, setRawPositions] = useState<PositionItem[]>(initialMemory?.positions || []);
  const [lastSync, setLastSync] = useState<string>('');

  const [selectedWh, setSelectedWh] = useState<string | null>(null);
  const [selectedDetailZoneId, setSelectedDetailZoneId] = useState<string | null>(null);
  const [selectedDetailKhuId, setSelectedDetailKhuId] = useState<string>('ALL');
  const [isGrouped, setIsGrouped] = useState(true);

  const [userMap, setUserMap] = useState<Record<string, string>>({});
  const [memberMap, setMemberMap] = useState<Record<string, string>>({});

  const [selectedLevelInfo, setSelectedLevelInfo] = useState<any>(null);
  const [isNewSessionModalVisible, setIsNewSessionModalVisible] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionWhId, setNewSessionWhId] = useState<string | null>(null);
  const [showHallSummary, setShowHallSummary] = useState(false);
  const [selectedSummaryGroup, setSelectedSummaryGroup] = useState<any>(null);

  const showToast = useCallback((text: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
    setToastMsg({ text, type });
    setTimeout(() => {
      setToastMsg(prev => (prev?.text === text ? null : prev));
    }, 2800);
  }, []);

  const { displayZones, displayPositions } = useMemo(() => {
    if (!isGrouped) {
      const ungroupedPos = rawPositions.map((p: any) => ({
        ...p,
        zone_id: p.zone_ids && p.zone_ids.length > 0 ? p.zone_ids[0] : null,
        real_zone_id: p.zone_ids && p.zone_ids.length > 0 ? p.zone_ids[0] : null,
        real_bin_id: null,
      }));
      return { displayZones: zones, displayPositions: ungroupedPos };
    }
    const grouped = groupInventoryWarehouseData(zones, rawPositions);
    return { displayZones: grouped.zones, displayPositions: grouped.positions };
  }, [zones, rawPositions, isGrouped]);

  // Nạp dữ liệu từ bộ nhớ máy trước (0ms), chỉ tải từ Supabase khi forceOnline = true hoặc chưa có phiếu nào
  const loadData = useCallback(async (forceOnline = false) => {
    try {
      // 1. Nạp Sơ đồ vị trí từ RAM / SQLite cache (0ms)
      const mapData = await getWarehouseMapOfflineData();
      if (mapData && mapData.zones.length > 0) {
        setZones(mapData.zones);
        setRawPositions(mapData.positions);
        if (mapData.cachedAt) {
          const d = new Date(mapData.cachedAt);
          setLastSync(
            `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`
          );
        }
      }

      // 2. Nạp danh sách phiếu kiểm & kết quả kiểm từ AsyncStorage trước (0ms)
      const [sessLocal, resLocal, usersLocal, membersLocal] = await Promise.all([
        AsyncStorage.getItem(INVENTORY_KEYS.SESSIONS),
        AsyncStorage.getItem(INVENTORY_KEYS.RESULTS),
        AsyncStorage.getItem(INVENTORY_KEYS.USERS_MAP),
        AsyncStorage.getItem(INVENTORY_KEYS.MEMBERS_MAP),
      ]);

      let parsedSessions: any[] = [];
      if (sessLocal) {
        try {
          parsedSessions = JSON.parse(sessLocal);
          setSessions(parsedSessions.filter((s: any) => s.status === 'active'));
        } catch {}
      }

      let allResults: Record<string, Record<string, any>> = {};
      if (resLocal) {
        try {
          allResults = JSON.parse(resLocal);
          setAllInventoryResults(allResults);
        } catch {}
      }

      if (usersLocal) {
        try { setUserMap(JSON.parse(usersLocal)); } catch {}
      }
      if (membersLocal) {
        try { setMemberMap(JSON.parse(membersLocal)); } catch {}
      }

      // Nếu không bấm "Tải mới" và trong máy đã có sẵn danh sách phiếu kiểm -> Mở tức thì 0ms!
      if (!forceOnline && parsedSessions.length > 0) {
        if (currentSession) {
          setInventoryResults(allResults[currentSession.id] || {});
        }
        return;
      }

      // 3. Tải danh sách phiếu kiểm từ Supabase (khi người dùng bấm Tải mới hoặc máy chưa có phiếu nào)
      setLoading(true);
      const client = await getSupabaseClient();
      const systemCode = (await AsyncStorage.getItem('config_system_code')) || 'KHO_DONG_LANH';

      const { data: supabaseSessions, error } = await client
        .from('internal_inventory_sessions')
        .select('*')
        .eq('system_code', systemCode)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (supabaseSessions) {
        const localOfflineSessions = parsedSessions.filter((s: any) => String(s.id).startsWith('off-'));
        const mergedSessions = [...localOfflineSessions, ...supabaseSessions];

        // Lấy tên người tạo & thành viên tham gia
        const userIds = [...new Set(mergedSessions.map((s: any) => s.created_by).filter(Boolean))];
        if (userIds.length > 0) {
          const { data: users } = await client.from('user_profiles').select('id, full_name').in('id', userIds);
          if (users) {
            const uMap: Record<string, string> = {};
            users.forEach((u: any) => { uMap[u.id] = u.full_name; });
            setUserMap(uMap);
            await AsyncStorage.setItem(INVENTORY_KEYS.USERS_MAP, JSON.stringify(uMap));
          }
        }

        const allParticipantIds = [
          ...new Set(
            mergedSessions.flatMap((s: any) => {
              try {
                if (s.note && s.note.startsWith('{')) {
                  const parsed = JSON.parse(s.note);
                  return parsed.p || [];
                }
              } catch {}
              return [];
            })
          ),
        ];

        if (allParticipantIds.length > 0) {
          const { data: members } = await client
            .from('construction_members')
            .select('id, full_name')
            .in('id', allParticipantIds);
          if (members) {
            const mMap: Record<string, string> = {};
            members.forEach((m: any) => { mMap[m.id] = m.full_name; });
            setMemberMap(mMap);
            await AsyncStorage.setItem(INVENTORY_KEYS.MEMBERS_MAP, JSON.stringify(mMap));
          }
        }

        const activeSessions = mergedSessions.filter((s: any) => s.status === 'active');
        setSessions(activeSessions);
        await AsyncStorage.setItem(INVENTORY_KEYS.SESSIONS, JSON.stringify(mergedSessions));

        // Tải kết quả đã kiểm trên máy chủ cho các phiếu active
        const activeCloudIds = activeSessions.map((s: any) => s.id).filter(isUUID);
        if (activeCloudIds.length > 0) {
          const { data: cloudItems } = await client
            .from('internal_inventory_items')
            .select('session_id, position_id, checked, note')
            .in('session_id', activeCloudIds);

          if (cloudItems) {
            const nextAllResults = { ...allResults };
            cloudItems.forEach((item: any) => {
              if (!nextAllResults[item.session_id]) nextAllResults[item.session_id] = {};
              nextAllResults[item.session_id][item.position_id] = {
                checked: item.checked,
                note: item.note || '',
              };
            });
            setAllInventoryResults(nextAllResults);
            await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(nextAllResults));

            if (currentSession && nextAllResults[currentSession.id]) {
              setInventoryResults(nextAllResults[currentSession.id]);
            }
          }
        }
      }
    } catch (e: any) {
      if (forceOnline) {
        showToast('Không thể kết nối máy chủ, đang dùng dữ liệu trong máy', 'warning');
      }
    } finally {
      setLoading(false);
    }
  }, [currentSession, showToast]);

  useEffect(() => {
    loadData(false);
  }, []);

  // Tự động nhận diện dữ liệu mới nhất từ RAM cache khi chuyển vào tab Kiểm Kê
  useEffect(() => {
    if (isActive) {
      const mem = getMemoryWarehouseMapCache();
      if (mem && mem.positions && mem.positions.length > 0) {
        if (rawPositions.length === 0 || (mem.cachedAt && mem.cachedAt !== lastSync)) {
          setZones(mem.zones);
          setRawPositions(mem.positions);
          if (mem.cachedAt) {
            const d = new Date(mem.cachedAt);
            setLastSync(
              `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')} ${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`
            );
          }
        }
      }
    }
  }, [isActive]);

  const handleRefreshAllFromCloud = async () => {
    setDownloadingMap(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const mapRes = await syncWarehouseMapOffline();
      if (mapRes.success && (mapRes as any).zones && (mapRes as any).positions) {
        setZones((mapRes as any).zones);
        setRawPositions((mapRes as any).positions);
      }
      await loadData(true);
      showToast('Đã tải mới Sơ đồ kho & Danh sách phiếu kiểm!', 'success');
    } catch (e: any) {
      showToast('Lỗi tải mới: ' + e.message, 'error');
    } finally {
      setDownloadingMap(false);
    }
  };

  const fetchSessionItems = async (sessionId: string) => {
    // 1. Hiển thị ngay lập tức từ bộ nhớ máy (0ms)
    const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
    const allResults = resStr ? JSON.parse(resStr) : {};
    const localResults = allResults[sessionId] || {};
    setInventoryResults(localResults);

    if (!isUUID(sessionId)) return;

    // 2. Đồng bộ kết quả mới nhất của phiếu này từ Supabase (nếu có mạng)
    try {
      const client = await getSupabaseClient();
      const { data, error } = await client
        .from('internal_inventory_items')
        .select('*')
        .eq('session_id', sessionId);

      if (error || !data) return;

      const fetchedResults: Record<string, any> = {};
      data.forEach((item: any) => {
        fetchedResults[item.position_id] = {
          checked: item.checked,
          note: item.note || '',
        };
      });

      const mergedResults = { ...localResults, ...fetchedResults };
      setInventoryResults(mergedResults);

      allResults[sessionId] = mergedResults;
      await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allResults));
      setAllInventoryResults({ ...allResults });
    } catch {}
  };

  const syncItemToSupabase = async (posId: string, checked: boolean, note: string | null) => {
    if (!currentSession || !isUUID(currentSession.id) || !user) return;
    try {
      const client = await getSupabaseClient();
      const pos = displayPositions.find((p: any) => p.id === posId);
      await client.from('internal_inventory_items').upsert(
        {
          session_id: currentSession.id,
          position_id: posId,
          zone_id: pos?.real_zone_id || pos?.zone_id || null,
          checked,
          note: note || null,
          checked_by: user.id,
          checked_at: new Date().toISOString(),
          lot_id_snapshot: pos?.lot_id || null,
        },
        { onConflict: 'session_id,position_id' }
      );
    } catch {}
  };

  const bulkCheckPositions = async (posIds: string[], checked: boolean) => {
    if (!currentSession || !posIds.length) {
      if (!currentSession) showToast('Vui lòng chọn hoặc tạo phiếu kiểm trước', 'warning');
      return;
    }
    if (currentSession.status === 'completed') {
      showToast('Phiếu đã hoàn thành/khóa, không thể chỉnh sửa', 'warning');
      return;
    }

    const updateWithChecked = (prevResults: Record<string, any>) => {
      const next = { ...prevResults };
      posIds.forEach(id => {
        next[id] = { ...(next[id] || { note: '' }), checked };
      });
      return next;
    };

    setInventoryResults(prev => updateWithChecked(prev));
    setAllInventoryResults(prev => ({
      ...prev,
      [currentSession.id]: updateWithChecked(prev[currentSession.id] || {}),
    }));

    try {
      const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
      const allRes = resStr ? JSON.parse(resStr) : {};
      allRes[currentSession.id] = updateWithChecked(allRes[currentSession.id] || {});
      await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allRes));

      showToast(`Đã ${checked ? 'tích kiểm' : 'bỏ tích'} ${posIds.length} vị trí`, 'success');

      if (!isUUID(currentSession.id) || !user) return;

      const client = await getSupabaseClient();
      const itemsToUpsert = posIds.map(id => {
        const pos = displayPositions.find((p: any) => p.id === id);
        return {
          session_id: currentSession.id,
          position_id: id,
          zone_id: pos?.real_zone_id || pos?.zone_id || null,
          checked,
          note: (inventoryResults[id] || { note: null }).note || null,
          checked_by: user.id,
          checked_at: new Date().toISOString(),
          lot_id_snapshot: pos?.lot_id || null,
        };
      });

      await client
        .from('internal_inventory_items')
        .upsert(itemsToUpsert, { onConflict: 'session_id,position_id' });
    } catch (e: any) {
      console.warn('Bulk check sync offline fallback:', e);
    }
  };

  const syncFullSession = async (session: any) => {
    if (!user) return;
    const sessionId = session.id;
    setSyncingRef(prev => ({ ...prev, [sessionId]: true }));
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const client = await getSupabaseClient();
      const systemCode = (await AsyncStorage.getItem('config_system_code')) || 'KHO_DONG_LANH';

      let targetSessionId = sessionId;

      // Nếu là phiếu tạo Offline ('off-...'), tạo phiếu thật trên Supabase trước
      if (String(sessionId).startsWith('off-')) {
        const { data: createdSess, error: createErr } = await client
          .from('internal_inventory_sessions')
          .insert({
            name: session.name,
            status: 'active',
            system_code: systemCode,
            company_id: user.company_id || null,
            created_by: user.id,
            warehouse_id: session.warehouse_id || null,
          })
          .select()
          .single();

        if (createErr) throw createErr;
        targetSessionId = createdSess.id;
      }

      const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
      const allResults = resStr ? JSON.parse(resStr) : {};
      const localResults = allResults[sessionId] || {};

      const entries = Object.entries(localResults).filter(([posId]) => !posId.startsWith('summary|'));
      if (entries.length === 0) {
        showToast('Chưa có vị trí nào được tích trong phiếu này', 'info');
        return;
      }

      const itemsToUpsert = entries.map(([posId, res]: [string, any]) => {
        const pos = displayPositions.find((p: any) => p.id === posId);
        return {
          session_id: targetSessionId,
          position_id: posId,
          zone_id: pos?.real_zone_id || pos?.zone_id || null,
          checked: Boolean(res.checked),
          note: res.note || null,
          checked_by: user.id,
          checked_at: new Date().toISOString(),
          lot_id_snapshot: pos?.lot_id || null,
        };
      });

      // Chia nhỏ chunk 200 dòng để đẩy lên ổn định
      const CHUNK = 200;
      for (let i = 0; i < itemsToUpsert.length; i += CHUNK) {
        const slice = itemsToUpsert.slice(i, i + CHUNK);
        const { error } = await client
          .from('internal_inventory_items')
          .upsert(slice, { onConflict: 'session_id,position_id' });
        if (error) throw error;
      }

      // Nếu vừa chuyển từ off-... sang UUID thật, cập nhật lại key trong local
      if (targetSessionId !== sessionId) {
        allResults[targetSessionId] = localResults;
        delete allResults[sessionId];
        await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allResults));
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(`Đã đồng bộ ${itemsToUpsert.length} vị trí lên hệ thống!`, 'success');
      await loadData(true);
    } catch (e: any) {
      showToast('Lỗi đồng bộ: ' + (e.message || 'Mất kết nối mạng'), 'error');
    } finally {
      setSyncingRef(prev => ({ ...prev, [sessionId]: false }));
    }
  };

  const togglePositionChecked = async (posId: string) => {
    if (!currentSession || !posId) {
      if (!currentSession) showToast('Vui lòng chọn hoặc tạo phiếu kiểm để bắt đầu', 'warning');
      return;
    }
    if (currentSession.status === 'completed') {
      showToast('Phiếu đã bị khóa từ hệ thống', 'warning');
      return;
    }

    const sId = String(posId);

    // Nếu là nhóm thống kê Sảnh (summary|...)
    if (sId.startsWith('summary|')) {
      const group = hallSummary.find((g: any) => g.groupKey === sId);
      if (!group) return;

      const isCurrentlyChecked = !!inventoryResults[sId]?.checked;
      const newChecked = !isCurrentlyChecked;

      await bulkCheckPositions(group.positionIds, newChecked);

      setInventoryResults(prev => ({
        ...prev,
        [sId]: { ...(prev[sId] || { note: '' }), checked: newChecked },
      }));

      const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
      const allResults = resStr ? JSON.parse(resStr) : {};
      allResults[currentSession.id] = {
        ...(allResults[currentSession.id] || {}),
        [sId]: { ...(allResults[currentSession.id]?.[sId] || { note: '' }), checked: newChecked },
      };
      await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allResults));
      setAllInventoryResults(allResults);
      return;
    }

    const currentItem = inventoryResults[sId] || { checked: false, note: '' };
    const newChecked = !currentItem.checked;

    const updateWithCheck = (prev: Record<string, any>) => ({
      ...prev,
      [sId]: { ...(prev[sId] || { note: '' }), checked: newChecked },
    });

    setInventoryResults(prev => updateWithCheck(prev));
    setAllInventoryResults(prev => ({
      ...prev,
      [currentSession.id]: updateWithCheck(prev[currentSession.id] || {}),
    }));

    try {
      const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
      const allResults = resStr ? JSON.parse(resStr) : {};
      allResults[currentSession.id] = updateWithCheck(allResults[currentSession.id] || {});
      await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allResults));

      syncItemToSupabase(posId, newChecked, currentItem.note);
    } catch {}
  };

  const updatePositionNote = async (posId: string, note: string) => {
    if (!currentSession || !posId) return;
    if (currentSession.status === 'completed') {
      showToast('Phiếu đã bị khóa, không thể thêm ghi chú', 'warning');
      return;
    }

    const sId = String(posId);

    if (sId.startsWith('summary|')) {
      const group = hallSummary.find((g: any) => g.groupKey === sId);
      if (!group) return;

      const newChecked = note.trim() !== '' ? true : inventoryResults[sId]?.checked || false;

      const updateWithHallNote = (prev: Record<string, any>) => {
        const next = { ...prev };
        group.positionIds.forEach((pid: string) => {
          next[pid] = { ...(next[pid] || { checked: false }), note, checked: newChecked };
        });
        next[sId] = { ...(next[sId] || { checked: false }), note, checked: newChecked };
        return next;
      };

      setInventoryResults(prev => updateWithHallNote(prev));
      setAllInventoryResults(prev => ({
        ...prev,
        [currentSession.id]: updateWithHallNote(prev[currentSession.id] || {}),
      }));

      try {
        const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
        const allRes = resStr ? JSON.parse(resStr) : {};
        allRes[currentSession.id] = updateWithHallNote(allRes[currentSession.id] || {});
        await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allRes));

        if (isUUID(currentSession.id) && user) {
          const client = await getSupabaseClient();
          const itemsToUpsert = group.positionIds.map((pid: string) => {
            const pos = displayPositions.find((p: any) => p.id === pid);
            return {
              session_id: currentSession.id,
              position_id: pid,
              zone_id: pos?.real_zone_id || pos?.zone_id || null,
              checked: newChecked,
              note: note || null,
              checked_by: user.id,
              checked_at: new Date().toISOString(),
              lot_id_snapshot: pos?.lot_id || null,
            };
          });
          await client
            .from('internal_inventory_items')
            .upsert(itemsToUpsert, { onConflict: 'session_id,position_id' });
        }
      } catch {}
      return;
    }

    const updateWithNote = (prev: Record<string, any>) => {
      const curr = prev[sId] || { checked: false, note: '' };
      const newChecked = note.trim() !== '' ? true : curr.checked;
      return {
        ...prev,
        [sId]: { ...curr, note, checked: newChecked },
      };
    };

    setInventoryResults(prev => updateWithNote(prev));
    setAllInventoryResults(prev => ({
      ...prev,
      [currentSession.id]: updateWithNote(prev[currentSession.id] || {}),
    }));

    try {
      const resStr = await AsyncStorage.getItem(INVENTORY_KEYS.RESULTS);
      const allResults = resStr ? JSON.parse(resStr) : {};
      allResults[currentSession.id] = updateWithNote(allResults[currentSession.id] || {});
      await AsyncStorage.setItem(INVENTORY_KEYS.RESULTS, JSON.stringify(allResults));

      const finalResults = updateWithNote(inventoryResults);
      syncItemToSupabase(posId, finalResults[sId].checked, note);
    } catch {}
  };

  const startNewSession = async (customName?: string, warehouseId?: string | null) => {
    if (!user) return;
    const now = new Date();
    const defaultName = `Phiếu kiểm ${now.toLocaleDateString('vi-VN')} ${now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
    const name = customName?.trim() || defaultName;
    const systemCode = (await AsyncStorage.getItem('config_system_code')) || 'KHO_DONG_LANH';

    try {
      const client = await getSupabaseClient();
      const { data, error } = await client
        .from('internal_inventory_sessions')
        .insert({
          name,
          status: 'active',
          system_code: systemCode,
          company_id: user.company_id || null,
          created_by: user.id,
          warehouse_id: warehouseId || null,
        })
        .select()
        .single();

      if (error) throw error;

      const newSession = data;
      const updatedSessions = [newSession, ...sessions];
      setSessions(updatedSessions);
      setCurrentSession(newSession);
      setInventoryResults({});
      setViewMode('detail');

      await AsyncStorage.setItem(INVENTORY_KEYS.SESSIONS, JSON.stringify(updatedSessions));
      showToast(`Đã tạo: ${newSession.name}`, 'success');
    } catch (e: any) {
      // Nếu đang ở trong kho lạnh không có mạng -> tạo phiếu Offline ngay trên máy!
      const offlineSession = {
        id: 'off-' + Date.now().toString(),
        name,
        created_at: now.toISOString(),
        status: 'active',
        system_code: systemCode,
        created_by: user.id,
        warehouse_id: warehouseId || null,
      };
      const updated = [offlineSession, ...sessions];
      setSessions(updated);
      setCurrentSession(offlineSession);
      setInventoryResults({});
      setViewMode('detail');
      await AsyncStorage.setItem(INVENTORY_KEYS.SESSIONS, JSON.stringify(updated));
      showToast(`Đã tạo phiếu Offline: ${offlineSession.name}`, 'warning');
    }
  };

  const selectSession = async (session: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentSession(session);
    await fetchSessionItems(session.id);
    setViewMode('detail');
  };

  const effectiveWhId = useMemo(() => {
    if (!currentSession) return null;
    let virtualWhId: string | null = null;
    try {
      if (currentSession.note && currentSession.note.startsWith('{')) {
        const parsed = JSON.parse(currentSession.note);
        virtualWhId = parsed.v || null;
      }
    } catch {}
    return currentSession.warehouse_id || virtualWhId || null;
  }, [currentSession]);

  const allRootWarehouses = useMemo(
    () =>
      displayZones
        .filter((z: any) => !z.parent_id)
        .sort((a: any, b: any) => {
          const oa = a.display_order ?? 0;
          const ob = b.display_order ?? 0;
          if (oa !== ob) return oa - ob;
          return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
        }),
    [displayZones]
  );

  const warehouses = useMemo(() => {
    if (!effectiveWhId) return allRootWarehouses;

    const zoneMap: Record<string, ZoneItem> = {};
    displayZones.forEach((z: any) => { zoneMap[z.id] = z; });

    const findAncestorInLevel1 = (zid: string): string | null => {
      let cur: string | null = zid;
      while (cur) {
        const zone: ZoneItem | undefined = zoneMap[cur];
        if (!zone) return null;
        if (!zone.parent_id) return cur;
        cur = zone.parent_id;
      }
      return null;
    };

    const rootId = findAncestorInLevel1(effectiveWhId);
    if (rootId) {
      return allRootWarehouses.filter((w: any) => w.id === rootId);
    }
    return allRootWarehouses;
  }, [allRootWarehouses, displayZones, effectiveWhId]);

  useEffect(() => {
    if (warehouses.length > 0) {
      const currentWhExists = warehouses.some((w: any) => w.id === selectedWh);
      if (!selectedWh || !currentWhExists) {
        setSelectedWh(warehouses[0].id);
      }
    } else {
      setSelectedWh(null);
    }
  }, [warehouses, selectedWh]);

  const childrenMap = useMemo(() => {
    const map: Record<string, ZoneItem[]> = {};
    displayZones.forEach((z: any) => {
      if (z.parent_id) {
        if (!map[z.parent_id]) map[z.parent_id] = [];
        map[z.parent_id].push(z);
      }
    });
    return map;
  }, [displayZones]);

  const buildingChildren = useMemo(() => {
    if (!selectedWh) return [];
    let children = displayZones
      .filter((z: any) => z.parent_id === selectedWh)
      .sort((a: any, b: any) => {
        const oa = a.display_order ?? 0;
        const ob = b.display_order ?? 0;
        if (oa !== ob) return oa - ob;
        return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
      });

    if (effectiveWhId && effectiveWhId !== selectedWh) {
      const isDescendantOrSelf = (childId: string, ancestorId: string): boolean => {
        if (childId === ancestorId) return true;
        let cur: string | null = childId;
        while (cur) {
          const z = displayZones.find((x: any) => x.id === cur);
          if (!z || !z.parent_id) break;
          if (z.parent_id === ancestorId) return true;
          cur = z.parent_id;
        }
        return false;
      };
      children = children.filter(
        (c: any) => isDescendantOrSelf(c.id, effectiveWhId) || isDescendantOrSelf(effectiveWhId, c.id)
      );
    }
    return children;
  }, [displayZones, selectedWh, effectiveWhId]);

  const getZonePath = useCallback(
    (zoneId: string | null) => {
      if (!zoneId) return 'Tất cả kho';
      const zoneMap: Record<string, ZoneItem> = {};
      displayZones.forEach((z: any) => { zoneMap[z.id] = z; });

      const parts: string[] = [];
      let cur: string | null = zoneId;
      while (cur && zoneMap[cur]) {
        parts.unshift(zoneMap[cur].name);
        cur = zoneMap[cur].parent_id;
      }
      return parts.length > 0 ? parts.join(' > ') : 'Tất cả kho';
    },
    [displayZones]
  );

  // Tối ưu O(N) thống kê từng khu vực
  const getZoneStats = useCallback(
    (zoneId: string) => {
      const getDescendantIds = (pid: string): Set<string> => {
        const set = new Set<string>([pid]);
        const stack = [pid];
        while (stack.length > 0) {
          const curr = stack.pop()!;
          const ch = childrenMap[curr] || [];
          for (let i = 0; i < ch.length; i++) {
            if (!set.has(ch[i].id)) {
              set.add(ch[i].id);
              stack.push(ch[i].id);
            }
          }
        }
        return set;
      };

      const targetZoneIds = getDescendantIds(zoneId);
      const zonePositions = displayPositions.filter((p: any) => p.zone_id && targetZoneIds.has(p.zone_id));

      const total = zonePositions.length;
      let occupied = 0;
      let checked = 0;
      let discrepancy = 0;

      for (let i = 0; i < zonePositions.length; i++) {
        const p = zonePositions[i];
        if (p.lot_id) occupied++;
        const r = inventoryResults[p.id];
        if (r?.checked) checked++;
        if (r?.note) discrepancy++;
      }

      const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
      return { total, occupied, checked, discrepancy, pct };
    },
    [childrenMap, displayPositions, inventoryResults]
  );

  const summaryCards = useMemo(() => {
    const palettes = [
      { bg: '#1e1b4b', border: '#4f46e5', text: '#a5b4fc', icon: 'clipboard' },
      { bg: '#064e3b', border: '#10b981', text: '#6ee7b7', icon: 'check-square' },
      { bg: '#172554', border: '#0284c7', text: '#7dd3fc', icon: 'layers' },
    ];
    return buildingChildren.map((z: any, idx: number) => {
      const s = getZoneStats(z.id);
      const theme = palettes[idx % palettes.length];
      const displayName =
        z.is_hall && !z.name.toUpperCase().includes('SẢNH') ? `SẢNH ${z.name}` : z.name;
      return { ...z, name: displayName, ...s, theme };
    });
  }, [buildingChildren, getZoneStats]);

  const detailZone = useMemo(
    () => displayZones.find((z: any) => z.id === selectedDetailZoneId) || null,
    [selectedDetailZoneId, displayZones]
  );

  const khuOptions = useMemo(() => {
    if (!selectedDetailZoneId) return [];
    return displayZones
      .filter((z: any) => z.parent_id === selectedDetailZoneId)
      .sort((a: any, b: any) => {
        const oa = a.display_order ?? 0;
        const ob = b.display_order ?? 0;
        if (oa !== ob) return oa - ob;
        return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
      });
  }, [selectedDetailZoneId, displayZones]);

  const detailPositions = useMemo(() => {
    if (!selectedDetailZoneId) return [];
    const getDescendantIds = (pid: string): Set<string> => {
      const set = new Set<string>([pid]);
      const stack = [pid];
      while (stack.length > 0) {
        const curr = stack.pop()!;
        const ch = childrenMap[curr] || [];
        for (let i = 0; i < ch.length; i++) {
          if (!set.has(ch[i].id)) {
            set.add(ch[i].id);
            stack.push(ch[i].id);
          }
        }
      }
      return set;
    };

    const rootId = selectedDetailKhuId === 'ALL' ? selectedDetailZoneId : selectedDetailKhuId;
    const descendantIds = getDescendantIds(rootId);
    return displayPositions.filter((p: any) => p.zone_id && descendantIds.has(p.zone_id));
  }, [selectedDetailZoneId, selectedDetailKhuId, displayPositions, childrenMap]);

  const detailData = useMemo(() => {
    const sectionsMap: Record<string, any> = {};
    const zoneLookup = new Map<string, ZoneItem>();
    displayZones.forEach((z: any) => zoneLookup.set(z.id, z));
    const rawZoneLookup = new Map<string, ZoneItem>();
    zones.forEach((z: any) => rawZoneLookup.set(z.id, z));

    detailPositions.forEach((p: any) => {
      const levelZone = p.zone_id ? zoneLookup.get(p.zone_id) : null;
      if (!levelZone) return;

      let sectionId: string;
      let sectionName: string;
      let rackKey: string;
      let rackName: string;

      if (detailZone?.is_hall) {
        sectionId = detailZone.id;
        sectionName = detailZone.name;
        rackKey = levelZone.id;
        rackName = levelZone.name;
      } else {
        const rackZone = levelZone.parent_id ? zoneLookup.get(levelZone.parent_id) : null;
        const khuZone = rackZone?.parent_id ? zoneLookup.get(rackZone.parent_id) : null;

        sectionId = khuZone?.id || rackZone?.id || levelZone.id;
        sectionName = khuZone?.name || rackZone?.name || levelZone.name;
        rackKey = rackZone?.id || levelZone.id;
        rackName = rackZone?.name || levelZone.name;
      }

      if (!sectionsMap[sectionId]) {
        sectionsMap[sectionId] = { id: sectionId, name: sectionName, racksMap: {} };
      }

      if (!sectionsMap[sectionId].racksMap[rackKey]) {
        sectionsMap[sectionId].racksMap[rackKey] = { id: rackKey, name: rackName, levelsMap: {} };
      }

      if (!sectionsMap[sectionId].racksMap[rackKey].levelsMap[levelZone.id]) {
        sectionsMap[sectionId].racksMap[rackKey].levelsMap[levelZone.id] = {
          id: levelZone.id,
          name: levelZone.name,
          num: (levelZone.name || '').replace(/[^0-9]/g, '') || '1',
          slots: [],
        };
      }

      const realBin = isGrouped && p.real_bin_id ? rawZoneLookup.get(p.real_bin_id) : null;
      sectionsMap[sectionId].racksMap[rackKey].levelsMap[levelZone.id].slots.push({
        ...p,
        zone_name: realBin?.name || '',
      });
    });

    const sections = Object.values(sectionsMap)
      .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((s: any) => ({
        ...s,
        rows: Object.values(s.racksMap)
          .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map((r: any) => ({
            ...r,
            levels: Object.values(r.levelsMap)
              .sort((a: any, b: any) =>
                a.name.localeCompare(b.name, undefined, { numeric: true })
              )
              .map((lvl: any) => ({
                ...lvl,
                slots: sortPositionsByDepthAndCol(lvl.slots || []),
              })),
          })),
      }));

    return { sections, count: detailPositions.length };
  }, [detailPositions, detailZone, displayZones, zones, isGrouped]);

  const hallSummary = useMemo(() => {
    if (!detailZone?.is_hall) return [];
    const groups: Record<string, any> = {};

    detailPositions.forEach((p: any) => {
      if (!p.lot_id) return;
      const tag = p.tags && p.tags.length > 0 ? p.tags[0] : '';
      const sku = p.sku || p.product_name || 'SP';
      const qty = p.quantity ?? 0;
      const unit = p.unit || 'Thùng';
      const groupKey = `summary|${sku}|${qty}|${unit}|${tag}`;
      const posId = p.id;
      const result = inventoryResults[posId] || { checked: false, note: '' };
      const summaryResult = inventoryResults[groupKey] || { checked: false, note: '' };

      if (!groups[groupKey]) {
        groups[groupKey] = {
          groupKey,
          product_sku: p.sku || '---',
          product_name: p.product_name || 'Hàng đông lạnh',
          quantity: qty,
          unit,
          tag,
          count: 1,
          positionIds: [posId],
          checkedCount: result.checked ? 1 : 0,
          hasNote: !!result.note,
          summaryChecked: summaryResult.checked,
          summaryNote: summaryResult.note,
        };
      } else {
        groups[groupKey].count += 1;
        groups[groupKey].positionIds.push(posId);
        if (result.checked) groups[groupKey].checkedCount += 1;
        if (result.note) groups[groupKey].hasNote = true;
      }
    });

    return Object.values(groups).sort((a: any, b: any) =>
      (a.product_name || '').localeCompare(b.product_name || '')
    );
  }, [detailZone, detailPositions, inventoryResults]);

  const groupLevel = useMemo(() => {
    if (!selectedSummaryGroup) return null;
    const slots = detailPositions.filter((p: any) => selectedSummaryGroup.positionIds.includes(p.id));
    return {
      id: 'group-modal',
      name: `Nhóm: ${selectedSummaryGroup.product_name}`,
      slots: sortPositionsByDepthAndCol(slots),
    };
  }, [selectedSummaryGroup, detailPositions]);

  return (
    <View style={styles.container}>
      {/* Toast thông báo nổi */}
      {toastMsg && (
        <View
          style={[
            styles.toastBanner,
            toastMsg.type === 'success'
              ? { backgroundColor: '#065f46', borderColor: '#10b981' }
              : toastMsg.type === 'error'
              ? { backgroundColor: '#881337', borderColor: '#f43f5e' }
              : toastMsg.type === 'warning'
              ? { backgroundColor: '#78350f', borderColor: '#f59e0b' }
              : { backgroundColor: '#1e293b', borderColor: '#38bdf8' },
          ]}
        >
          <Text style={styles.toastText}>{toastMsg.text}</Text>
        </View>
      )}

      {viewMode === 'list' ? (
        /* ── MÀN HÌNH 1: DANH SÁCH PHIẾU KIỂM KÊ ─────────────────── */
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.headerTitle}>KIỂM KÊ KHO</Text>
                <View style={styles.badgeCold}>
                  <Text style={styles.badgeColdText}>THEO TẦNG & PHIÊN</Text>
                </View>
              </View>
              <Text style={styles.headerSub}>
                {rawPositions.length} vị trí trong máy{lastSync ? ` · 🕒 ${lastSync}` : ''}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity
                style={styles.downloadBtn}
                onPress={handleRefreshAllFromCloud}
                disabled={downloadingMap || loading}
              >
                {downloadingMap || loading ? (
                  <ActivityIndicator size="small" color="#34d399" />
                ) : (
                  <>
                    <Ionicons name="cloud-download-outline" size={16} color="#34d399" />
                    <Text style={styles.downloadBtnText}>Tải mới</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.addSessionBtn}
                onPress={() => {
                  setNewSessionName('');
                  setNewSessionWhId(null);
                  setIsNewSessionModalVisible(true);
                }}
              >
                <Feather name="plus" size={18} color="#0f172a" />
                <Text style={styles.addSessionBtnText}>Tạo phiếu</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={styles.sectionLabel}>DANH SÁCH PHIẾU ĐANG KIỂM ({sessions.length})</Text>
              {loading && <ActivityIndicator size="small" color="#a78bfa" />}
            </View>

            {sessions.length === 0 && !loading && (
              <View style={styles.emptySessionsBox}>
                <Feather name="clipboard" size={48} color="#475569" />
                <Text style={styles.emptySessionsTitle}>Chưa có phiếu kiểm kê nào</Text>
                <Text style={styles.emptySessionsSub}>
                  Bấm nút "+ Tạo phiếu" để tạo mới hoặc bấm "Tải mới" để nhận phiếu từ Web
                </Text>
              </View>
            )}

            {sessions.map((s: any, idx: number) => {
              const isSyncing = syncingRef[s.id];
              let participants: string[] = [];
              let virtualWhId: string | null = null;
              try {
                if (s.note && s.note.startsWith('{')) {
                  const parsed = JSON.parse(s.note);
                  participants = parsed.p || [];
                  virtualWhId = parsed.v || null;
                }
              } catch {}

              const sessWhId = s.warehouse_id || virtualWhId;
              const zonePathName = getZonePath(sessWhId);
              const creatorName = s.created_by ? userMap[s.created_by] || user?.full_name || 'Nhân viên' : 'Hệ thống';
              const participantNames = participants.map(pid => memberMap[pid]).filter(Boolean);

              const getDescendantIdsStrict = (pid: string): Set<string> => {
                const set = new Set<string>([pid]);
                const stack = [pid];
                while (stack.length > 0) {
                  const curr = stack.pop()!;
                  const ch = childrenMap[curr] || [];
                  for (let i = 0; i < ch.length; i++) {
                    if (!set.has(ch[i].id)) {
                      set.add(ch[i].id);
                      stack.push(ch[i].id);
                    }
                  }
                }
                return set;
              };

              const sResults = allInventoryResults[s.id] || {};
              let sTotal = 0;
              let sChecked = 0;
              let sDiff = 0;

              if (sessWhId) {
                const sZoneIds = getDescendantIdsStrict(sessWhId);
                const sPositions = displayPositions.filter((p: any) => p.zone_id && sZoneIds.has(p.zone_id));
                sTotal = sPositions.length;
                sChecked = sPositions.filter((p: any) => sResults[p.id]?.checked).length;
                sDiff = sPositions.filter((p: any) => sResults[p.id]?.note).length;
              } else {
                sTotal = displayPositions.length;
                sChecked = displayPositions.filter((p: any) => sResults[p.id]?.checked).length;
                sDiff = displayPositions.filter((p: any) => sResults[p.id]?.note).length;
              }

              const isOfflineSess = String(s.id).startsWith('off-');

              return (
                <TouchableOpacity
                  key={`sess-${s.id || idx}`}
                  onPress={() => selectSession(s)}
                  activeOpacity={0.85}
                  style={[
                    styles.sessionCard,
                    currentSession?.id === s.id && styles.sessionCardActive,
                  ]}
                >
                  {/* Header: Tên phiếu & Trạng thái */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <View style={{ flex: 1, marginRight: 10 }}>
                      <Text style={styles.sessionCardTitle}>{s.name}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Feather name="calendar" size={11} color="#94a3b8" />
                          <Text style={styles.sessionMetaText}>
                            {new Date(s.created_at || Date.now()).toLocaleDateString('vi-VN')}
                          </Text>
                        </View>
                        <Text style={{ color: '#475569' }}>•</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Feather name="user" size={11} color="#94a3b8" />
                          <Text style={styles.sessionMetaText} numberOfLines={1}>
                            {creatorName}
                          </Text>
                        </View>
                      </View>
                    </View>

                    <View
                      style={[
                        styles.sessionStatusBadge,
                        isOfflineSess
                          ? { backgroundColor: '#78350f', borderColor: '#f59e0b' }
                          : { backgroundColor: '#1e1b4b', borderColor: '#8b5cf6' },
                      ]}
                    >
                      <Text
                        style={[
                          styles.sessionStatusText,
                          isOfflineSess ? { color: '#fcd34d' } : { color: '#c4b5fd' },
                        ]}
                      >
                        {isOfflineSess ? 'Offline' : s.status === 'active' ? 'Đang kiểm' : 'Hoàn thành'}
                      </Text>
                    </View>
                  </View>

                  {/* Khu vực kiểm kê & Nhóm tham gia */}
                  <View style={styles.sessionInfoBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Feather name="map-pin" size={13} color="#a78bfa" />
                      <Text style={styles.sessionInfoLabel}>Khu vực:</Text>
                      <Text style={styles.sessionInfoValue} numberOfLines={1}>
                        {zonePathName}
                      </Text>
                    </View>

                    {participantNames.length > 0 && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#1e293b' }}>
                        <Feather name="users" size={13} color="#fbbf24" />
                        <Text style={styles.sessionInfoLabel}>Nhóm:</Text>
                        <Text style={[styles.sessionInfoValue, { color: '#fde68a' }]} numberOfLines={1}>
                          {participantNames.join(', ')}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Footer: Nút Đồng bộ & Tiến độ */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                    <TouchableOpacity
                      disabled={isSyncing}
                      onPress={() => syncFullSession(s)}
                      style={[styles.syncSessionBtn, isSyncing && { opacity: 0.6 }]}
                    >
                      {isSyncing ? (
                        <ActivityIndicator size="small" color="#ffffff" />
                      ) : (
                        <Feather name="upload-cloud" size={15} color="#ffffff" />
                      )}
                      <Text style={styles.syncSessionBtnText}>Đồng bộ lên Web</Text>
                    </TouchableOpacity>

                    <View style={{ alignItems: 'flex-end' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
                        <Text style={styles.progressBigNum}>{sChecked}</Text>
                        <Text style={styles.progressTotalNum}>/ {sTotal} vị trí</Text>
                      </View>
                      {sDiff > 0 ? (
                        <View style={styles.diffBadge}>
                          <Text style={styles.diffBadgeText}>⚠️ {sDiff} SAI LỆCH</Text>
                        </View>
                      ) : (
                        <Text style={styles.progressSubLabel}>CHẠM ĐỂ VÀO KIỂM →</Text>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      ) : (
        /* ── MÀN HÌNH 2: CHI TIẾT KHU VỰC KIỂM KÊ (CHỌN KHO -> DÃY/SẢNH) ── */
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <TouchableOpacity
                onPress={() => setViewMode('list')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 }}
              >
                <Feather name="arrow-left" size={13} color="#a78bfa" />
                <Text style={{ color: '#a78bfa', fontSize: 11, fontWeight: '800' }}>
                  QUAY LẠI DANH SÁCH PHIẾU
                </Text>
              </TouchableOpacity>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {currentSession?.name || 'Kiểm Kê'}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <TouchableOpacity
                onPress={() => currentSession && syncFullSession(currentSession)}
                disabled={Boolean(currentSession && syncingRef[currentSession.id])}
                style={styles.downloadBtn}
              >
                {currentSession && syncingRef[currentSession.id] ? (
                  <ActivityIndicator size="small" color="#34d399" />
                ) : (
                  <>
                    <Feather name="upload-cloud" size={14} color="#34d399" />
                    <Text style={styles.downloadBtnText}>Đồng bộ</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => setIsGrouped(!isGrouped)}
                style={[
                  styles.groupToggleBtn,
                  isGrouped && { backgroundColor: '#312e81', borderColor: '#818cf8' },
                ]}
              >
                <Feather name="layers" size={15} color={isGrouped ? '#c7d2fe' : '#94a3b8'} />
                <Text style={{ color: isGrouped ? '#c7d2fe' : '#94a3b8', fontSize: 11, fontWeight: '800' }}>
                  {isGrouped ? 'Gộp Ô' : 'Tách Kệ'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Thanh chọn Kho */}
          <View style={styles.whTabsBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
              {warehouses.map((w: any, idx: number) => {
                const isAct = selectedWh === w.id;
                return (
                  <TouchableOpacity
                    key={`wh-${w.id || idx}`}
                    onPress={() => setSelectedWh(w.id)}
                    style={[styles.whTabPill, isAct && styles.whTabPillActive]}
                  >
                    <Text style={[styles.whTabPillText, isAct && styles.whTabPillTextActive]}>
                      🏢 {w.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Danh sách thẻ Dãy / Sảnh trong Kho */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
            {summaryCards.map((item: any, idx: number) => (
              <TouchableOpacity
                key={`summary-${item.id || idx}`}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedDetailKhuId('ALL');
                  setSelectedDetailZoneId(item.id);
                }}
                activeOpacity={0.85}
                style={[
                  styles.aisleSummaryCard,
                  { backgroundColor: item.theme.bg, borderColor: item.theme.border },
                ]}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <Feather name={item.theme.icon as any} size={18} color={item.theme.text} />
                    <Text style={[styles.aisleSummaryTitle, { color: '#ffffff' }]}>{item.name}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: item.theme.text, fontSize: 13, fontWeight: '900' }}>
                      {item.pct}% Đã kiểm
                    </Text>
                    <Feather name="chevron-right" size={16} color={item.theme.text} />
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={styles.aisleKpiBox}>
                    <Text style={styles.aisleKpiLabel}>TỔNG</Text>
                    <Text style={styles.aisleKpiValue}>{item.total}</Text>
                  </View>
                  <View style={styles.aisleKpiBox}>
                    <Text style={styles.aisleKpiLabel}>CÓ HÀNG</Text>
                    <Text style={[styles.aisleKpiValue, { color: '#fbbf24' }]}>{item.occupied}</Text>
                  </View>
                  <View style={styles.aisleKpiBox}>
                    <Text style={styles.aisleKpiLabel}>ĐÃ KIỂM</Text>
                    <Text style={[styles.aisleKpiValue, { color: '#34d399' }]}>{item.checked}</Text>
                  </View>
                  <View style={[styles.aisleKpiBox, item.discrepancy > 0 && { borderColor: '#f43f5e', borderWidth: 1 }]}>
                    <Text style={[styles.aisleKpiLabel, { color: '#fb7185' }]}>SAI LỆCH</Text>
                    <Text style={[styles.aisleKpiValue, { color: '#fb7185' }]}>{item.discrepancy}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── MODAL SƠ ĐỒ KIỂM KÊ THEO Ô & TẦNG ─────────────────────── */}
      <Modal
        visible={!!selectedDetailZoneId}
        animationType="slide"
        onRequestClose={() => setSelectedDetailZoneId(null)}
      >
        <View style={styles.container}>
          {/* Header Modal */}
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => {
                setSelectedDetailZoneId(null);
                setShowHallSummary(false);
              }}
              style={styles.backBtn}
            >
              <Feather name="arrow-left" size={20} color="#e2e8f0" />
            </TouchableOpacity>

            <View style={{ flex: 1, marginHorizontal: 10 }}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                Kiểm kê: {detailZone?.name}
              </Text>
              <Text style={styles.headerSub} numberOfLines={1}>
                {currentSession?.name} · Nhấn giữ vào Tầng để tích nhanh cả tầng
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {detailZone?.is_hall && (
                <TouchableOpacity
                  onPress={() => setShowHallSummary(!showHallSummary)}
                  style={[
                    styles.groupToggleBtn,
                    showHallSummary && { backgroundColor: '#7c2d12', borderColor: '#f97316' },
                  ]}
                >
                  <Feather
                    name="bar-chart-2"
                    size={15}
                    color={showHallSummary ? '#fdba74' : '#94a3b8'}
                  />
                  <Text style={{ color: showHallSummary ? '#fdba74' : '#94a3b8', fontSize: 11, fontWeight: '800' }}>
                    Gom nhóm
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={() => setIsGrouped(!isGrouped)}
                style={[
                  styles.groupToggleBtn,
                  isGrouped && { backgroundColor: '#312e81', borderColor: '#818cf8' },
                ]}
              >
                <Feather name="layers" size={15} color={isGrouped ? '#c7d2fe' : '#94a3b8'} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Bộ lọc Ô con nếu có */}
          {khuOptions.length > 0 && !showHallSummary && (
            <View style={styles.whTabsBar}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}>
                <TouchableOpacity
                  onPress={() => setSelectedDetailKhuId('ALL')}
                  style={[styles.whTabPill, selectedDetailKhuId === 'ALL' && styles.whTabPillActive]}
                >
                  <Text style={[styles.whTabPillText, selectedDetailKhuId === 'ALL' && styles.whTabPillTextActive]}>
                    Tất cả ({detailData.count})
                  </Text>
                </TouchableOpacity>
                {khuOptions.map((khu: any, idx: number) => (
                  <TouchableOpacity
                    key={`khu-${khu.id || idx}`}
                    onPress={() => setSelectedDetailKhuId(khu.id)}
                    style={[styles.whTabPill, selectedDetailKhuId === khu.id && styles.whTabPillActive]}
                  >
                    <Text style={[styles.whTabPillText, selectedDetailKhuId === khu.id && styles.whTabPillTextActive]}>
                      {khu.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Nội dung Sơ đồ Tầng hoặc Thống kê Sảnh */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 50 }}>
            {showHallSummary && detailZone?.is_hall ? (
              <View style={{ gap: 10 }}>
                <View style={styles.hallSummaryBanner}>
                  <Feather name="bar-chart-2" size={15} color="#fb923c" />
                  <Text style={styles.hallSummaryBannerText}>
                    THỐNG KÊ SẢNH (Gom theo Sản phẩm + Số lượng + Mã phụ)
                  </Text>
                </View>

                {hallSummary.map((item: any, idx: number) => (
                  <View key={`sum-${idx}`} style={styles.hallGroupCard}>
                    <TouchableOpacity
                      onPress={() => setSelectedSummaryGroup(item)}
                      activeOpacity={0.8}
                      style={{ padding: 14 }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <TouchableOpacity
                          onPress={() => togglePositionChecked(item.groupKey)}
                          style={[
                            styles.hallLotCountBtn,
                            item.summaryChecked && { backgroundColor: '#10b981', borderColor: '#34d399' },
                          ]}
                        >
                          <Text style={styles.hallLotCountNum}>{item.count}</Text>
                          <Text style={styles.hallLotCountSub}>LOT</Text>
                        </TouchableOpacity>

                        <View style={{ flex: 1 }}>
                          <Text style={styles.slotSkuText}>{item.product_sku}</Text>
                          <Text style={styles.slotProdName} numberOfLines={2}>
                            {item.product_name}
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                            <View style={styles.lotCodePill}>
                              <Text style={styles.lotCodePillText}>
                                {item.quantity} {item.unit}
                              </Text>
                            </View>
                            {item.tag ? (
                              <View style={styles.tagPill}>
                                <Text style={styles.tagPillText}>{item.tag}</Text>
                              </View>
                            ) : null}
                          </View>
                        </View>

                        <View style={{ alignItems: 'flex-end', gap: 4 }}>
                          <Text
                            style={{
                              color: item.checkedCount === item.count ? '#34d399' : '#cbd5e1',
                              fontSize: 12,
                              fontWeight: '900',
                            }}
                          >
                            {item.checkedCount}/{item.count} LOT
                          </Text>
                          <Feather name="chevron-right" size={16} color="#64748b" />
                        </View>
                      </View>
                    </TouchableOpacity>

                    <View style={[styles.noteInputWrap, { marginHorizontal: 12, marginBottom: 12 }]}>
                      <Feather name="edit-3" size={14} color="#64748b" />
                      <TextInput
                        style={styles.noteInput}
                        placeholder="Ghi chú dòng tổng (VD: thực tế có 25 lot)..."
                        placeholderTextColor="#64748b"
                        value={item.summaryNote || ''}
                        onChangeText={val => updatePositionNote(item.groupKey, val)}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : detailData.sections.length === 0 ? (
              <View style={styles.emptySessionsBox}>
                <Feather name="map" size={48} color="#475569" />
                <Text style={styles.emptySessionsTitle}>Khu vực trống</Text>
              </View>
            ) : (
              detailData.sections.map((section: any, idx: number) => (
                <View key={`section-${section.id || idx}`} style={{ marginBottom: 20 }}>
                  {!detailZone?.is_hall && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <View style={{ width: 24, height: 3, backgroundColor: '#a78bfa', borderRadius: 2 }} />
                      <Text style={styles.sectionHeaderTitle}>{section.name}</Text>
                    </View>
                  )}

                  <View style={{ gap: 12 }}>
                    {section.rows.map((row: any, ridx: number) => (
                      <View key={`row-${row.id || ridx}`} style={styles.rackRowCard}>
                        {!detailZone?.is_hall && (
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <Text style={styles.rackRowTitle}>{row.name}</Text>
                            <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '700' }}>
                              Chạm xem chi tiết · Nhấn giữ để tích cả tầng
                            </Text>
                          </View>
                        )}

                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {row.levels.map((lvl: any, lidx: number) => {
                            const totalLvl = lvl.slots.length;
                            const occupiedLvl = lvl.slots.filter((s: any) => Boolean(s.lot_id)).length;
                            const checkedLvl = lvl.slots.filter((s: any) => inventoryResults[s.id]?.checked).length;
                            const hasNote = lvl.slots.some((s: any) => Boolean(inventoryResults[s.id]?.note));
                            const isFull = totalLvl > 0 && checkedLvl === totalLvl;

                            return (
                              <TouchableOpacity
                                key={`lvl-${lvl.id || lidx}`}
                                style={[
                                  styles.levelCellBtn,
                                  detailZone?.is_hall ? { flex: 1, minWidth: '45%', paddingVertical: 12 } : { width: '18.5%' },
                                  isFull
                                    ? styles.levelCellBtnFull
                                    : hasNote
                                    ? styles.levelCellBtnNote
                                    : checkedLvl > 0
                                    ? styles.levelCellBtnPartial
                                    : null,
                                ]}
                                onPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  setSelectedLevelInfo({
                                    ...lvl,
                                    name: detailZone?.is_hall ? lvl.name : `${row.name} - ${lvl.name}`,
                                  });
                                }}
                                onLongPress={() => {
                                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                                  Alert.alert(
                                    'Tích nhanh cả tầng',
                                    `Xác nhận đã kiểm toàn bộ ${totalLvl} vị trí ở ${row.name} - ${lvl.name}?`,
                                    [
                                      { text: 'Hủy', style: 'cancel' },
                                      {
                                        text: 'Xác nhận',
                                        onPress: () =>
                                          bulkCheckPositions(
                                            lvl.slots.map((s: any) => s.id),
                                            true
                                          ),
                                      },
                                    ]
                                  );
                                }}
                              >
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                  <Text style={styles.levelCellTitle}>
                                    {detailZone?.is_hall ? lvl.name : `T${lvl.num}`}
                                  </Text>
                                  <View
                                    style={[
                                      styles.levelCountBadge,
                                      isFull && { backgroundColor: '#10b981' },
                                    ]}
                                  >
                                    <Text
                                      style={[
                                        styles.levelCountText,
                                        isFull && { color: '#022c22', fontWeight: '900' },
                                      ]}
                                    >
                                      {checkedLvl}/{totalLvl}
                                    </Text>
                                  </View>
                                </View>

                                {/* Thanh chấm hiển thị vị trí có hàng vs đã kiểm */}
                                <View style={{ flexDirection: 'row', gap: 2, height: 5, width: '100%' }}>
                                  {lvl.slots.map((s: any, sid: number) => {
                                    const isSlotChecked = Boolean(inventoryResults[s.id]?.checked);
                                    const isSlotNote = Boolean(inventoryResults[s.id]?.note);
                                    const isSlotOcc = Boolean(s.lot_id);
                                    const dotColor = isSlotNote
                                      ? '#f43f5e'
                                      : isSlotChecked
                                      ? '#10b981'
                                      : isSlotOcc
                                      ? '#f59e0b'
                                      : '#334155';
                                    return (
                                      <View
                                        key={`dot-${s.id || sid}`}
                                        style={{ flex: 1, borderRadius: 2, backgroundColor: dotColor }}
                                      />
                                    );
                                  })}
                                </View>

                                <Text style={styles.levelSubOccText}>
                                  {occupiedLvl} có hàng
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))
            )}
          </ScrollView>

          {/* Modal kiểm kê từng vị trí trong Tầng */}
          <LevelInventoryModal
            level={selectedLevelInfo || groupLevel}
            visible={!!selectedLevelInfo || !!selectedSummaryGroup}
            onClose={() => {
              setSelectedLevelInfo(null);
              setSelectedSummaryGroup(null);
            }}
            inventoryResults={inventoryResults}
            togglePositionChecked={togglePositionChecked}
            updatePositionNote={updatePositionNote}
            bulkCheckPositions={bulkCheckPositions}
          />
        </View>
      </Modal>

      {/* ── MODAL TẠO PHIẾU KIỂM KÊ MỚI ───────────────────────────── */}
      <Modal
        visible={isNewSessionModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsNewSessionModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <View style={styles.levelModalOverlay}>
            <View style={[styles.levelModalCard, { padding: 20 }]}>
              <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '900', marginBottom: 4 }}>
                Tạo Phiếu Kiểm Kê Mới
              </Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, marginBottom: 14 }}>
                Đặt tên phiếu và chọn phạm vi kho cần kiểm kê
              </Text>

              <Text style={styles.inputLabel}>TÊN PHIẾU KIỂM KÊ:</Text>
              <TextInput
                style={styles.sessionNameInput}
                placeholder={`VD: Kiểm kho tháng ${new Date().getMonth() + 1}`}
                placeholderTextColor="#64748b"
                value={newSessionName}
                onChangeText={setNewSessionName}
                autoFocus
              />

              <Text style={[styles.inputLabel, { marginTop: 12 }]}>KHU VỰC KIỂM KÊ:</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                <TouchableOpacity
                  onPress={() => setNewSessionWhId(null)}
                  style={[styles.whSelectChip, !newSessionWhId && styles.whSelectChipActive]}
                >
                  <Text style={[styles.whSelectChipText, !newSessionWhId && styles.whSelectChipTextActive]}>
                    🌐 Toàn bộ kho
                  </Text>
                </TouchableOpacity>
                {allRootWarehouses.map((w: any) => (
                  <TouchableOpacity
                    key={w.id}
                    onPress={() => setNewSessionWhId(w.id)}
                    style={[styles.whSelectChip, newSessionWhId === w.id && styles.whSelectChipActive]}
                  >
                    <Text style={[styles.whSelectChipText, newSessionWhId === w.id && styles.whSelectChipTextActive]}>
                      🏢 {w.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity
                  onPress={() => setIsNewSessionModalVisible(false)}
                  style={[styles.doneModalBtn, { flex: 1, backgroundColor: '#1e293b' }]}
                >
                  <Text style={[styles.doneModalBtnText, { color: '#94a3b8' }]}>Hủy</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    startNewSession(newSessionName, newSessionWhId);
                    setIsNewSessionModalVisible(false);
                  }}
                  style={[styles.doneModalBtn, { flex: 1, backgroundColor: '#7c3aed' }]}
                >
                  <Text style={styles.doneModalBtnText}>Bắt đầu kiểm</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  toastBanner: {
    position: 'absolute',
    top: 10,
    left: 16,
    right: 16,
    zIndex: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  toastText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0b1324',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  headerSub: {
    color: '#94a3b8',
    fontSize: 10.5,
    marginTop: 2,
  },
  badgeCold: {
    backgroundColor: '#4c1d9566',
    borderWidth: 1,
    borderColor: '#8b5cf688',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  badgeColdText: {
    color: '#c4b5fd',
    fontSize: 9,
    fontWeight: '800',
  },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#10b981',
  },
  downloadBtnText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '800',
  },
  addSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 36,
    paddingHorizontal: 11,
    borderRadius: 10,
    backgroundColor: '#a78bfa',
  },
  addSessionBtnText: {
    color: '#0f172a',
    fontSize: 11.5,
    fontWeight: '900',
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  emptySessionsBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 24,
  },
  emptySessionsTitle: {
    color: '#cbd5e1',
    fontSize: 15,
    fontWeight: '800',
    marginTop: 12,
  },
  emptySessionsSub: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  sessionCard: {
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  sessionCardActive: {
    borderColor: '#8b5cf6',
    backgroundColor: '#17153b',
  },
  sessionCardTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  sessionMetaText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  sessionStatusBadge: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  sessionStatusText: {
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  sessionInfoBox: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  sessionInfoLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  sessionInfoValue: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '800',
    flex: 1,
  },
  syncSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#7c3aed',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
  },
  syncSessionBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  progressBigNum: {
    color: '#34d399',
    fontSize: 20,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  progressTotalNum: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  diffBadge: {
    backgroundColor: '#881337',
    borderWidth: 1,
    borderColor: '#f43f5e',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    marginTop: 2,
  },
  diffBadgeText: {
    color: '#fecdd3',
    fontSize: 9.5,
    fontWeight: '900',
  },
  progressSubLabel: {
    color: '#a78bfa',
    fontSize: 9.5,
    fontWeight: '800',
    marginTop: 2,
  },
  groupToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  whTabsBar: {
    paddingVertical: 8,
    backgroundColor: '#0c1322',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  whTabPill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  whTabPillActive: {
    backgroundColor: '#7c3aed',
    borderColor: '#a78bfa',
  },
  whTabPillText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  whTabPillTextActive: {
    color: '#ffffff',
    fontWeight: '900',
  },
  aisleSummaryCard: {
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
  },
  aisleSummaryTitle: {
    fontSize: 16,
    fontWeight: '900',
  },
  aisleKpiBox: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  aisleKpiLabel: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '800',
    marginBottom: 2,
  },
  aisleKpiValue: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionHeaderTitle: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  rackRowCard: {
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  rackRowTitle: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '900',
  },
  levelCellBtn: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 7,
    borderWidth: 1,
    borderColor: '#334155',
  },
  levelCellBtnFull: {
    backgroundColor: '#064e3b',
    borderColor: '#10b981',
  },
  levelCellBtnPartial: {
    backgroundColor: '#1e1b4b',
    borderColor: '#818cf8',
  },
  levelCellBtnNote: {
    backgroundColor: '#4c0519',
    borderColor: '#f43f5e',
  },
  levelCellTitle: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '900',
  },
  levelCountBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  levelCountText: {
    color: '#cbd5e1',
    fontSize: 8.5,
    fontWeight: '800',
  },
  levelSubOccText: {
    color: '#94a3b8',
    fontSize: 8.5,
    marginTop: 4,
    textAlign: 'center',
  },
  hallSummaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#431407',
    borderWidth: 1,
    borderColor: '#f9731666',
    padding: 12,
    borderRadius: 12,
  },
  hallSummaryBannerText: {
    color: '#fdba74',
    fontSize: 11,
    fontWeight: '800',
    flex: 1,
  },
  hallGroupCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
    overflow: 'hidden',
  },
  hallLotCountBtn: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hallLotCountNum: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '900',
  },
  hallLotCountSub: {
    color: '#94a3b8',
    fontSize: 8.5,
    fontWeight: '800',
  },
  levelModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  levelModalCard: {
    backgroundColor: '#111827',
    borderRadius: 22,
    maxHeight: '86%',
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  levelModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    backgroundColor: '#0b1324',
  },
  levelModalTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
    flexShrink: 1,
  },
  bulkCheckBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  bulkCheckBtnText: {
    color: '#34d399',
    fontSize: 10.5,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  closeCircleBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotCheckCard: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  slotPosCode: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  realBinBadge: {
    backgroundColor: '#be123c',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  realBinBadgeText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '900',
  },
  sttPill: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  sttPillText: {
    color: '#0f172a',
    fontSize: 10,
    fontWeight: '900',
  },
  lotCodePill: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  lotCodePillText: {
    color: '#cbd5e1',
    fontSize: 9.5,
    fontWeight: '800',
  },
  tagPill: {
    backgroundColor: '#431407',
    borderWidth: 1,
    borderColor: '#f9731666',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  tagPillText: {
    color: '#fdba74',
    fontSize: 9.5,
    fontWeight: '800',
  },
  slotSkuText: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  slotProdName: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '800',
    lineHeight: 17,
  },
  slotQtyLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  slotQtyValue: {
    color: '#34d399',
    fontWeight: '900',
  },
  slotDateMeta: {
    color: '#fcd34d',
    fontSize: 10.5,
    fontWeight: '700',
  },
  slotZoneMeta: {
    color: '#6ee7b7',
    fontSize: 10.5,
    fontWeight: '700',
  },
  lotNoteBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#451a0366',
    borderWidth: 1,
    borderColor: '#f59e0b55',
    padding: 6,
    borderRadius: 8,
    marginTop: 4,
  },
  lotNoteText: {
    color: '#fde68a',
    fontSize: 10.5,
    fontWeight: '600',
    flex: 1,
  },
  emptyPosLabel: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '700',
    fontStyle: 'italic',
  },
  checkBoxBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxBtnChecked: {
    backgroundColor: '#10b981',
  },
  checkBoxBtnUnchecked: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  noteInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  noteInputWrapActive: {
    borderColor: '#f43f5e88',
    backgroundColor: '#4c051944',
  },
  noteInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 2,
  },
  doneModalBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  doneModalBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  inputLabel: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '800',
    marginBottom: 6,
  },
  sessionNameInput: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  whSelectChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  whSelectChipActive: {
    backgroundColor: '#312e81',
    borderColor: '#818cf8',
  },
  whSelectChipText: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '700',
  },
  whSelectChipTextActive: {
    color: '#ffffff',
    fontWeight: '900',
  },
});

