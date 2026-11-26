import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  TextInput,
  Alert,
  ActivityIndicator,
  Modal,
  ScrollView,
  Dimensions,
  Switch,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import {
  getSupabaseClient,
  withTimeout,
  getWarehouseMapOfflineData,
} from '../services/supabase';
import { decodeSTT } from '../utils/numberUtils';
import { groupWarehouseData, ZoneItem as BaseZoneItem } from '../utils/warehouseUtils';
import { WorkTaskMapView } from '../components/work/WorkTaskMapView';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const WORK_TASKS_CACHE_KEY_PREFIX = 'work_offline_export_tasks_v1_';
const WORK_PENDING_OPS_KEY = 'work_offline_pending_ops_v1';

export interface WorkExportTaskItem {
  id: string;
  task_id: string;
  lot_id: string;
  product_id: string | null;
  position_id: string | null;
  quantity: number | null;
  exported_quantity: number | null;
  unit: string | null;
  status: string;
  priority: number;
  lot_code: string | null;
  lot_stt: number | string | null;
  production_code: string | null;
  tags?: string[];
  lot_notes: string | null;
  product_name: string | null;
  product_sku: string | null;
  position_code: string | null;
  display_status: string;
}

export interface WorkExportTask {
  id: string;
  code: string;
  status: string;
  system_code: string;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  items: WorkExportTaskItem[];
}

export interface WorkPendingOp {
  id: string;
  type: 'HA_SANH';
  system_code: string;
  lotId: string;
  lotCode: string;
  hallPosId: string;
  hallPosCode: string;
  oldPosId: string | null;
  taskItemId: string;
  taskId: string;
  timestamp: string;
}

interface WorkMapZone extends BaseZoneItem {
  is_hall?: boolean;
  display_order?: number;
}

interface WorkMapPosition {
  id: string;
  code: string;
  lot_id?: string | null;
  zone_id?: string | null;
  zone_ids?: string[];
  [key: string]: any;
}

function getPriorityInfo(priority: number) {
  switch (priority) {
    case 1:
      return { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)', border: '#ef4444', label: 'Mức 1 (Đỏ)' };
    case 2:
      return { color: '#eab308', bg: 'rgba(234, 179, 8, 0.14)', border: '#eab308', label: 'Mức 2 (Vàng)' };
    case 3:
      return { color: '#a16207', bg: 'rgba(161, 98, 7, 0.16)', border: '#a16207', label: 'Mức 3 (Nâu)' };
    case 4:
      return { color: '#a855f7', bg: 'rgba(168, 85, 247, 0.14)', border: '#a855f7', label: 'Mức 4 (Tím)' };
    default:
      return null;
  }
}

function formatSttDisplay(stt: number | string | null | undefined): string | null {
  if (stt === null || stt === undefined || stt === '') return null;
  if (typeof stt === 'number') {
    return decodeSTT(stt) || String(stt);
  }
  const num = Number(stt);
  if (!Number.isNaN(num) && /^\d+$/.test(String(stt)) && num > 1000) {
    return decodeSTT(num) || String(stt);
  }
  return String(stt);
}

// ============================================================================
// SUB-MODAL CHI TIẾT DÃY / KỆ & GÁN ƯU TIÊN
// ============================================================================
interface ZoneDetailSubModalProps {
  visible: boolean;
  onClose: () => void;
  zoneId: string | null;
  zonePath: string;
  items: WorkExportTaskItem[];
  onRefresh: () => void;
  onOptimisticPriorityUpdate: (itemIds: string[], priority: number) => void;
}

const ZoneDetailSubModal: React.FC<ZoneDetailSubModalProps> = ({
  visible,
  onClose,
  zonePath,
  items,
  onRefresh,
  onOptimisticPriorityUpdate,
}) => {
  const styles = useThemedStyles(BASE_STYLES);
  const { colors } = useTheme();
  const [updating, setUpdating] = useState(false);

  const handleSetPriority = async (level: number) => {
    setUpdating(true);
    try {
      const itemIds = items.map(i => i.id);
      onOptimisticPriorityUpdate(itemIds, level);
      try {
        const client = await getSupabaseClient();
        await withTimeout(
          client.from('export_task_items').update({ priority: level }).in('id', itemIds),
          5000
        );
      } catch {
        // Giữ nguyên cập nhật trên máy nếu đang ngoại tuyến
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onRefresh();
    } finally {
      setUpdating(false);
    }
  };

  const currentZonePriority = useMemo(() => {
    const priorities = items.map(i => i.priority || 0).filter(p => p > 0);
    return priorities.length > 0 ? Math.min(...priorities) : 0;
  }, [items]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.subModalOverlay}>
        <View style={[styles.subModalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.subModalHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={[styles.subModalTitle, { color: colors.text }]} numberOfLines={2}>
                {zonePath}
              </Text>
              <Text style={[styles.subModalSubtitle, { color: colors.textMuted }]}>
                {items.length} kiện hàng trong kệ này
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeIconBtn}>
              <Feather name="x" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={[styles.priorityToolbar, { borderBottomColor: colors.border }]}>
            <Text style={[styles.priorityLabel, { color: colors.textMuted }]}>
              ĐẶT MỨC ƯU TIÊN CHO KỆ NÀY:
            </Text>
            <View style={styles.priorityBtnRow}>
              {[
                { level: 1, color: '#ef4444', label: '1 - Đỏ' },
                { level: 2, color: '#eab308', label: '2 - Vàng' },
                { level: 3, color: '#a16207', label: '3 - Nâu' },
                { level: 4, color: '#a855f7', label: '4 - Tím' },
                { level: 0, color: '#64748b', label: 'Xóa' },
              ].map(p => {
                const isSelected = currentZonePriority === p.level;
                return (
                  <TouchableOpacity
                    key={p.level}
                    disabled={updating}
                    onPress={() => handleSetPriority(p.level)}
                    style={[
                      styles.priorityChip,
                      {
                        borderColor: p.color,
                        backgroundColor: isSelected ? p.color : 'transparent',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.priorityChipText,
                        { color: isSelected ? '#ffffff' : p.color },
                      ]}
                    >
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <FlatList
            data={items}
            keyExtractor={it => it.id}
            style={{ maxHeight: SCREEN_HEIGHT * 0.48 }}
            contentContainerStyle={{ padding: 14 }}
            renderItem={({ item }) => {
              const pInfo = getPriorityInfo(item.priority);
              const isMoved = item.display_status === 'Moved to Hall';
              const sttLabel = formatSttDisplay(item.lot_stt);
              return (
                <View
                  style={[
                    styles.subItemCard,
                    {
                      backgroundColor: colors.surfaceAlt,
                      borderColor: pInfo ? pInfo.border : colors.border,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {pInfo && <View style={[styles.priorityDot, { backgroundColor: pInfo.color }]} />}
                      <Text style={[styles.subItemCode, { color: colors.text }]}>
                        {item.lot_code}
                      </Text>
                      {sttLabel ? (
                        <View style={styles.sttMiniBadge}>
                          <Text style={styles.sttMiniBadgeText}>#{sttLabel}</Text>
                        </View>
                      ) : null}
                      {item.production_code ? (
                        <View style={styles.prodCodeBadge}>
                          <Text style={styles.prodCodeBadgeText}>SX: {item.production_code}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.subItemProduct, { color: colors.textSecondary }]} numberOfLines={1}>
                      {item.product_name || 'Sản phẩm'}
                    </Text>
                    <Text style={[styles.subItemPos, { color: colors.primary }]}>
                      Vị trí: {item.position_code || 'Chưa gán'} • SL: {item.quantity ?? 0} {item.unit || ''}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      isMoved ? styles.statusMoved : styles.statusPending,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadgeText,
                        { color: isMoved ? '#22c55e' : '#eab308' },
                      ]}
                    >
                      {isMoved ? 'Ở sảnh' : 'Trên kệ'}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
};

// ============================================================================
// MODAL THỐNG KÊ VỊ TRÍ LỆNH XUẤT & HẠ SẢNH NHANH THEO DÃY/KỆ
// ============================================================================
interface ExportOrderStatsModalProps {
  visible: boolean;
  onClose: () => void;
  taskCode: string;
  taskItems: WorkExportTaskItem[];
  zones: WorkMapZone[];
  positions: WorkMapPosition[];
  onRefresh: () => void;
  onToggleZoneMovedToHall: (itemsInRow: WorkExportTaskItem[], shouldMoveToHall: boolean) => Promise<void>;
  onOptimisticPriorityUpdate: (itemIds: string[], priority: number) => void;
}

const ExportOrderStatsModal: React.FC<ExportOrderStatsModalProps> = ({
  visible,
  onClose,
  taskCode,
  taskItems,
  zones: rawZones,
  positions: rawPositions,
  onRefresh,
  onToggleZoneMovedToHall,
  onOptimisticPriorityUpdate,
}) => {
  const styles = useThemedStyles(BASE_STYLES);
  const { colors } = useTheme();
  const [isGrouped, setIsGrouped] = useState(true);
  const [selectedWhId, setSelectedWhId] = useState<string | null>(null);
  const [updatingZoneId, setUpdatingZoneId] = useState<string | null>(null);
  const [detailZone, setDetailZone] = useState<{
    id: string;
    path: string;
    items: WorkExportTaskItem[];
  } | null>(null);

  const { zones, virtualToRealMap } = useMemo(() => {
    if (!isGrouped) {
      return { zones: rawZones, virtualToRealMap: new Map<string, string[]>() };
    }
    return groupWarehouseData(rawZones, rawPositions);
  }, [rawZones, rawPositions, isGrouped]);

  const zoneMap = useMemo(() => {
    const map = new Map<string, WorkMapZone>();
    zones.forEach(z => map.set(z.id, z));
    return map;
  }, [zones]);

  const posToZoneMap = useMemo(() => {
    const map = new Map<string, string>();
    const realToVirtual = new Map<string, string>();
    if (isGrouped) {
      virtualToRealMap.forEach((realIds, vId) => {
        realIds.forEach(rId => realToVirtual.set(rId, vId));
      });
    }
    rawPositions.forEach(p => {
      const zIds: string[] = Array.isArray(p.zone_ids)
        ? p.zone_ids
        : p.zone_id
          ? [p.zone_id]
          : [];
      const primaryZId = zIds[zIds.length - 1] || zIds[0];
      if (primaryZId) {
        const zId = isGrouped ? realToVirtual.get(primaryZId) || primaryZId : primaryZId;
        map.set(p.id, zId);
        if (p.code) map.set(p.code.toUpperCase(), zId);
      }
    });
    return map;
  }, [rawPositions, isGrouped, virtualToRealMap]);

  const getRootWarehouse = useCallback(
    (zoneId: string): WorkMapZone | null => {
      let curr = zoneMap.get(zoneId);
      let depth = 0;
      while (curr && curr.parent_id && depth < 15) {
        const parent = zoneMap.get(curr.parent_id);
        if (!parent) break;
        curr = parent;
        depth++;
      }
      return curr || null;
    },
    [zoneMap]
  );

  const getGroupingZone = useCallback(
    (zoneId: string): WorkMapZone | null => {
      const path: WorkMapZone[] = [];
      let curr = zoneMap.get(zoneId);
      let depth = 0;
      while (curr && depth < 15) {
        path.unshift(curr);
        curr = curr.parent_id ? zoneMap.get(curr.parent_id) : undefined;
        depth++;
      }
      if (path.length === 0) return null;
      if (path.length >= 3) return path[2];
      return path[path.length - 1];
    },
    [zoneMap]
  );

  const getFullZonePath = useCallback(
    (zoneId: string, rootId: string): string => {
      const parts: string[] = [];
      let curr = zoneMap.get(zoneId);
      let depth = 0;
      while (curr && curr.id !== rootId && depth < 15) {
        parts.unshift(curr.name);
        curr = curr.parent_id ? zoneMap.get(curr.parent_id) : undefined;
        depth++;
      }
      return parts.join(' • ') || 'Khu vực chung';
    },
    [zoneMap]
  );

  const statsData = useMemo(() => {
    const whGroups: Record<
      string,
      {
        whName: string;
        totalRequired: number;
        totalPicked: number;
        zones: Record<
          string,
          {
            zoneId: string;
            zonePath: string;
            required: number;
            picked: number;
            maxPriority: number;
            items: WorkExportTaskItem[];
          }
        >;
      }
    > = {};

    let totalValidItems = 0;
    let totalPickedItems = 0;

    taskItems.forEach(item => {
      if (item.status === 'Exported') return;
      totalValidItems++;
      const isPicked = item.display_status === 'Moved to Hall';
      if (isPicked) totalPickedItems++;

      let zoneId = item.position_id ? posToZoneMap.get(item.position_id) : undefined;
      if (!zoneId && item.position_code) {
        zoneId = posToZoneMap.get(item.position_code.toUpperCase());
      }

      if (!zoneId) {
        const unknownWhId = 'unknown';
        if (!whGroups[unknownWhId]) {
          whGroups[unknownWhId] = {
            whName: 'Chưa rõ vị trí / Kệ',
            totalRequired: 0,
            totalPicked: 0,
            zones: {},
          };
        }
        whGroups[unknownWhId].totalRequired++;
        if (isPicked) whGroups[unknownWhId].totalPicked++;

        if (!whGroups[unknownWhId].zones['none']) {
          whGroups[unknownWhId].zones['none'] = {
            zoneId: 'none',
            zonePath: 'Không xác định trên sơ đồ',
            required: 0,
            picked: 0,
            maxPriority: 0,
            items: [],
          };
        }
        const zEntry = whGroups[unknownWhId].zones['none'];
        zEntry.required++;
        if (isPicked) zEntry.picked++;
        if (item.priority > 0) {
          zEntry.maxPriority =
            zEntry.maxPriority === 0 ? item.priority : Math.min(zEntry.maxPriority, item.priority);
        }
        zEntry.items.push(item);
        return;
      }

      const rootWh = getRootWarehouse(zoneId);
      const whId = rootWh?.id || 'other';
      const whName = rootWh?.name || 'Kho khác';

      if (!whGroups[whId]) {
        whGroups[whId] = { whName, totalRequired: 0, totalPicked: 0, zones: {} };
      }
      whGroups[whId].totalRequired++;
      if (isPicked) whGroups[whId].totalPicked++;

      const groupZone = getGroupingZone(zoneId);
      const gId = groupZone?.id || zoneId;
      const zPath = getFullZonePath(gId, whId);

      if (!whGroups[whId].zones[gId]) {
        whGroups[whId].zones[gId] = {
          zoneId: gId,
          zonePath: zPath,
          required: 0,
          picked: 0,
          maxPriority: 0,
          items: [],
        };
      }
      const zEntry = whGroups[whId].zones[gId];
      zEntry.required++;
      if (isPicked) zEntry.picked++;
      if (item.priority > 0) {
        zEntry.maxPriority =
          zEntry.maxPriority === 0 ? item.priority : Math.min(zEntry.maxPriority, item.priority);
      }
      zEntry.items.push(item);
    });

    return { whGroups, totalValidItems, totalPickedItems };
  }, [taskItems, posToZoneMap, getRootWarehouse, getGroupingZone, getFullZonePath]);

  const whKeys = useMemo(() => {
    return Object.keys(statsData.whGroups).sort((a, b) =>
      statsData.whGroups[a].whName.localeCompare(statsData.whGroups[b].whName, undefined, {
        numeric: true,
      })
    );
  }, [statsData]);

  useEffect(() => {
    if (visible && whKeys.length > 0 && (!selectedWhId || !statsData.whGroups[selectedWhId])) {
      setSelectedWhId(whKeys[0]);
    }
  }, [visible, whKeys, selectedWhId, statsData]);

  const activeWh = selectedWhId ? statsData.whGroups[selectedWhId] : null;
  const activeZones = useMemo(() => {
    if (!activeWh) return [];
    return Object.values(activeWh.zones).sort((a, b) => {
      if (a.maxPriority !== b.maxPriority) {
        if (a.maxPriority === 0) return 1;
        if (b.maxPriority === 0) return -1;
        return a.maxPriority - b.maxPriority;
      }
      return a.zonePath.localeCompare(b.zonePath, undefined, { numeric: true });
    });
  }, [activeWh]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContainer, { backgroundColor: colors.bg, borderColor: colors.border }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Thống kê vị trí lấy hàng</Text>
              <Text style={[styles.modalSubtitle, { color: colors.primary }]}>Lệnh: {taskCode}</Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={[styles.groupToggleBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.groupToggleLabel, { color: colors.textSecondary }]}>Gom ô</Text>
                <Switch
                  value={isGrouped}
                  onValueChange={setIsGrouped}
                  trackColor={{ false: '#334155', true: '#3b82f6' }}
                  thumbColor={isGrouped ? '#ffffff' : '#94a3b8'}
                  style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                />
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeIconBtn}>
                <Feather name="x" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Chú thích mức ưu tiên */}
          <View style={[styles.legendBar, { backgroundColor: colors.surfaceAlt, borderBottomColor: colors.border }]}>
            <Text style={[styles.legendTitle, { color: colors.textMuted }]}>ƯU TIÊN:</Text>
            {[
              { color: '#ef4444', label: '1-Đỏ' },
              { color: '#eab308', label: '2-Vàng' },
              { color: '#a16207', label: '3-Nâu' },
              { color: '#a855f7', label: '4-Tím' },
            ].map(l => (
              <View key={l.label} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: l.color }]} />
                <Text style={[styles.legendText, { color: colors.textSecondary }]}>{l.label}</Text>
              </View>
            ))}
          </View>

          {whKeys.length === 0 ? (
            <View style={styles.emptyBox}>
              <Feather name="inbox" size={44} color={colors.textMuted} />
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                Không có dữ liệu vị trí cho lệnh xuất này
              </Text>
            </View>
          ) : (
            <>
              <View style={[styles.whTabBar, { borderBottomColor: colors.border }]}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 14, gap: 8 }}
                >
                  {whKeys.map(whId => {
                    const wh = statsData.whGroups[whId];
                    const isSelected = whId === selectedWhId;
                    const isAllDone = wh.totalPicked === wh.totalRequired && wh.totalRequired > 0;
                    return (
                      <TouchableOpacity
                        key={whId}
                        onPress={() => setSelectedWhId(whId)}
                        style={[
                          styles.whTab,
                          {
                            backgroundColor: isSelected ? colors.primary : colors.surface,
                            borderColor: isSelected ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.whTabName,
                            { color: isSelected ? '#ffffff' : colors.textSecondary },
                          ]}
                        >
                          {wh.whName}
                        </Text>
                        <View
                          style={[
                            styles.whBadge,
                            {
                              backgroundColor: isAllDone
                                ? 'rgba(34, 197, 94, 0.25)'
                                : 'rgba(15, 23, 42, 0.25)',
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.whBadgeText,
                              {
                                color: isAllDone
                                  ? '#22c55e'
                                  : isSelected
                                    ? '#ffffff'
                                    : colors.textMuted,
                              },
                            ]}
                          >
                            {wh.totalPicked}/{wh.totalRequired}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              <FlatList
                data={activeZones}
                keyExtractor={z => z.zoneId}
                contentContainerStyle={{ padding: 14, paddingBottom: 24 }}
                renderItem={({ item: z }) => {
                  const isDone = z.picked === z.required && z.required > 0;
                  const percent = z.required > 0 ? (z.picked / z.required) * 100 : 0;
                  const pInfo = getPriorityInfo(z.maxPriority);
                  const isUpdating = updatingZoneId === z.zoneId;

                  return (
                    <TouchableOpacity
                      activeOpacity={0.75}
                      onPress={() =>
                        setDetailZone({
                          id: z.zoneId,
                          path: z.zonePath,
                          items: z.items,
                        })
                      }
                      style={[
                        styles.zoneStatCard,
                        {
                          backgroundColor: pInfo ? pInfo.bg : colors.surface,
                          borderColor: pInfo
                            ? pInfo.border
                            : isDone
                              ? 'rgba(34, 197, 94, 0.45)'
                              : colors.border,
                        },
                      ]}
                    >
                      <View style={styles.zoneStatRow}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, paddingRight: 8 }}>
                          <View
                            style={[
                              styles.zoneIconBox,
                              {
                                backgroundColor: pInfo
                                  ? 'rgba(0,0,0,0.18)'
                                  : isDone
                                    ? 'rgba(34, 197, 94, 0.14)'
                                    : 'rgba(59, 130, 246, 0.14)',
                              },
                            ]}
                          >
                            <Feather
                              name={isDone ? 'check-circle' : 'layers'}
                              size={16}
                              color={pInfo ? pInfo.color : isDone ? '#22c55e' : '#3b82f6'}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={[styles.zonePathText, { color: colors.text }]} numberOfLines={2}>
                              {z.zonePath}
                            </Text>
                            {pInfo && (
                              <Text style={{ fontSize: 11, fontWeight: '700', color: pInfo.color, marginTop: 2 }}>
                                Ưu tiên: {pInfo.label}
                              </Text>
                            )}
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <View style={{ alignItems: 'flex-end' }}>
                            <Text style={[styles.zoneCountBig, { color: isDone ? '#22c55e' : colors.text }]}>
                              {z.picked}
                              <Text style={{ fontSize: 13, color: colors.textMuted }}>/{z.required}</Text>
                            </Text>
                            <Text style={{ fontSize: 10, color: colors.textMuted }}>Kiện (LOT)</Text>
                          </View>

                          <View style={[styles.quickMoveSwitchBox, { borderLeftColor: colors.border }]}>
                            <Text style={{ fontSize: 9, color: colors.textMuted, marginBottom: 2 }}>Đã hạ</Text>
                            {isUpdating ? (
                              <ActivityIndicator size="small" color={colors.primary} />
                            ) : (
                              <Switch
                                value={isDone}
                                onValueChange={async val => {
                                  setUpdatingZoneId(z.zoneId);
                                  try {
                                    await onToggleZoneMovedToHall(z.items, val);
                                  } finally {
                                    setUpdatingZoneId(null);
                                  }
                                }}
                                trackColor={{ false: '#334155', true: '#22c55e' }}
                                thumbColor={isDone ? '#ffffff' : '#94a3b8'}
                                style={{ transform: [{ scaleX: 0.78 }, { scaleY: 0.78 }] }}
                              />
                            )}
                          </View>
                        </View>
                      </View>

                      <View style={styles.miniProgressTrack}>
                        <View
                          style={[
                            styles.miniProgressFill,
                            {
                              width: `${percent}%`,
                              backgroundColor: pInfo ? pInfo.color : isDone ? '#22c55e' : '#3b82f6',
                            },
                          ]}
                        />
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
            </>
          )}

          <View style={[styles.modalFooter, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 14, color: colors.textSecondary, fontWeight: '600' }}>
                Tổng tiến độ toàn lệnh:
              </Text>
              <Text style={{ fontSize: 15, color: colors.text, fontWeight: '800' }}>
                {statsData.totalPickedItems} / {statsData.totalValidItems} LOT
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeFullBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.closeFullBtnText}>Đóng bảng thống kê</Text>
            </TouchableOpacity>
          </View>
        </View>

        {detailZone && (
          <ZoneDetailSubModal
            visible={!!detailZone}
            onClose={() => setDetailZone(null)}
            zoneId={detailZone.id}
            zonePath={detailZone.path}
            items={detailZone.items}
            onRefresh={() => {
              onRefresh();
              setDetailZone(null);
            }}
            onOptimisticPriorityUpdate={onOptimisticPriorityUpdate}
          />
        )}
      </View>
    </Modal>
  );
};

// ============================================================================
// MÀN HÌNH CHÍNH: CÔNG VIỆC (LỆNH XUẤT & HẠ SẢNH)
// ============================================================================
interface WorkScreenProps {
  isActive?: boolean;
}

export default function WorkScreen({ isActive = true }: WorkScreenProps) {
  const styles = useThemedStyles(BASE_STYLES);
  const { colors } = useTheme();
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();

  const [systemCode, setSystemCode] = useState<string>('KHO_DONG_LANH');
  const [step, setStep] = useState<'select' | 'scan'>('select');
  const [loading, setLoading] = useState<boolean>(false);

  const [exportTasks, setExportTasks] = useState<WorkExportTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<WorkExportTask | null>(null);
  const [taskItems, setTaskItems] = useState<WorkExportTaskItem[]>([]);

  const [allZones, setAllZones] = useState<WorkMapZone[]>([]);
  const [allPositions, setAllPositions] = useState<WorkMapPosition[]>([]);

  const [pendingOps, setPendingOps] = useState<WorkPendingOp[]>([]);
  const [syncingOps, setSyncingOps] = useState<boolean>(false);

  // Camera & Quét mã
  const [showCamera, setShowCamera] = useState<boolean>(false);
  const [isScanningPaused, setIsScanningPaused] = useState<boolean>(false);
  const [scannedResult, setScannedResult] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statsModalVisible, setStatsModalVisible] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const pauseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Nạp system_code đang cấu hình
  useEffect(() => {
    AsyncStorage.getItem('config_system_code')
      .then(saved => {
        if (saved) setSystemCode(saved);
      })
      .catch(() => {});
  }, [isActive]);

  // Nạp hàng đợi thao tác Hạ Sảnh ngoại tuyến
  const loadPendingOps = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(WORK_PENDING_OPS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setPendingOps(parsed);
      } else {
        setPendingOps([]);
      }
    } catch {
      setPendingOps([]);
    }
  }, []);

  const savePendingOps = useCallback(async (ops: WorkPendingOp[]) => {
    setPendingOps(ops);
    try {
      if (ops.length > 0) {
        await AsyncStorage.setItem(WORK_PENDING_OPS_KEY, JSON.stringify(ops));
      } else {
        await AsyncStorage.removeItem(WORK_PENDING_OPS_KEY);
      }
    } catch {}
  }, []);

  // Nạp dữ liệu sơ đồ kho (zones + positions) từ bộ nhớ Offline hoặc Supabase
  const loadWarehouseMapStructure = useCallback(
    async (sysCode: string) => {
      try {
        const offlineMap = await getWarehouseMapOfflineData();
        if (offlineMap && offlineMap.zones.length > 0 && offlineMap.positions.length > 0) {
          setAllZones(offlineMap.zones as WorkMapZone[]);
          setAllPositions(offlineMap.positions as WorkMapPosition[]);
          return {
            zones: offlineMap.zones as WorkMapZone[],
            positions: offlineMap.positions as WorkMapPosition[],
          };
        }
      } catch {}

      // Fallback tải trực tiếp từ Supabase nếu chưa tải sơ đồ kho ngoại tuyến
      try {
        const client = await getSupabaseClient();
        const [{ data: zonesData }, { data: posData }] = await Promise.all([
          withTimeout(
            client
              .from('zones')
              .select('id, code, name, parent_id, is_hall, display_order, system_type')
              .eq('system_type', sysCode),
            8000
          ),
          withTimeout(
            client
              .from('positions')
              .select('id, code, lot_id, system_type, zone_positions(zone_id)')
              .eq('system_type', sysCode)
              .limit(10000),
            10000
          ),
        ]);

        const zList: WorkMapZone[] = (zonesData || []).map((z: any) => ({
          id: z.id,
          code: z.code,
          name: z.name,
          parent_id: z.parent_id,
          system_type: z.system_type,
          is_hall: Boolean(z.is_hall || /s[ảàa]nh|lobby/i.test(z.name || '')),
          display_order: z.display_order ?? 0,
        }));

        const pList: WorkMapPosition[] = (posData || []).map((p: any) => {
          const zps = Array.isArray(p.zone_positions)
            ? p.zone_positions
            : p.zone_positions
              ? [p.zone_positions]
              : [];
          const zIds = zps.map((zp: any) => zp.zone_id).filter(Boolean);
          return {
            id: p.id,
            code: p.code,
            lot_id: p.lot_id || null,
            zone_id: zIds[0] || null,
            zone_ids: zIds,
          };
        });

        setAllZones(zList);
        setAllPositions(pList);
        return { zones: zList, positions: pList };
      } catch {
        return { zones: allZones, positions: allPositions };
      }
    },
    [allZones, allPositions]
  );

  // Nạp danh sách Lệnh Xuất (export_tasks) từ Supabase + lưu cache ngoại tuyến
  const loadExportTasks = useCallback(
    async (sysCode = systemCode) => {
      setLoading(true);
      const cacheKey = `${WORK_TASKS_CACHE_KEY_PREFIX}${sysCode}`;

      // 1. Nạp trước từ cache trong máy để hiển thị tức thì
      try {
        const cachedRaw = await AsyncStorage.getItem(cacheKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw);
          if (Array.isArray(parsed)) {
            setExportTasks(parsed);
          }
        }
      } catch {}

      try {
        const mapStruct = await loadWarehouseMapStructure(sysCode);
        const currentZones = mapStruct.zones;
        const currentPositions = mapStruct.positions;

        // Xác định tập hợp vị trí thuộc Sảnh (is_hall)
        const hallZoneIds = new Set(currentZones.filter(z => z.is_hall).map(z => z.id));
        let added = true;
        while (added) {
          added = false;
          for (const z of currentZones) {
            if (z.parent_id && hallZoneIds.has(z.parent_id) && !hallZoneIds.has(z.id)) {
              hallZoneIds.add(z.id);
              added = true;
            }
          }
        }

        const posByLotId = new Map<string, { id: string; code: string; isHall: boolean }>();
        for (const p of currentPositions) {
          if (p.lot_id) {
            const zIds = Array.isArray(p.zone_ids)
              ? p.zone_ids
              : p.zone_id
                ? [p.zone_id]
                : [];
            const isHall = zIds.some(zid => hallZoneIds.has(zid));
            posByLotId.set(p.lot_id, { id: p.id, code: p.code, isHall });
          }
        }

        const client = await getSupabaseClient();
        // 2. Tải danh sách export_tasks chuẩn theo Web Scanner (tránh lỗi embed/cột không tồn tại)
        const { data: tasksData, error: tErr } = await withTimeout(
          client
            .from('export_tasks')
            .select('*')
            .eq('system_code', sysCode)
            .in('status', ['Pending', 'In Progress', 'Processing'])
            .order('created_at', { ascending: false }),
          10000,
          'Quá thời gian tải lệnh xuất'
        );
        if (tErr) throw tErr;

        const taskList = Array.isArray(tasksData) ? tasksData : [];
        if (taskList.length === 0) {
          setExportTasks([]);
          await AsyncStorage.setItem(cacheKey, JSON.stringify([]));
          return;
        }

        const taskIds = taskList.map((t: any) => t.id).filter(Boolean);
        const { data: itemsData, error: iErr } = await withTimeout(
          client
            .from('export_task_items')
            .select(
              `
              id,
              task_id,
              lot_id,
              product_id,
              position_id,
              quantity,
              unit,
              status,
              priority,
              positions:positions!export_task_items_position_id_fkey (id, code),
              lots (
                id,
                code,
                daily_seq,
                notes,
                status,
                production_code,
                lot_tags (tag),
                positions!positions_lot_id_fkey (id, code)
              ),
              products (id, name, sku)
            `
            )
            .in('task_id', taskIds),
          12000,
          'Quá thời gian tải chi tiết lệnh xuất'
        );
        if (iErr) throw iErr;

        const allRawItems = Array.isArray(itemsData) ? itemsData : [];
        const itemsByTaskId = new Map<string, any[]>();
        for (const rawIt of allRawItems) {
          const tid = rawIt.task_id;
          if (!tid) continue;
          const arr = itemsByTaskId.get(tid);
          if (arr) arr.push(rawIt);
          else itemsByTaskId.set(tid, [rawIt]);
        }

        const formatted: WorkExportTask[] = taskList.map((t: any) => {
          const rawItems = itemsByTaskId.get(t.id) || [];
          const items: WorkExportTaskItem[] = rawItems
            .filter((it: any) => it.status !== 'Exported' && it.lots?.status !== 'exported')
            .map((it: any) => {
              const lotLivePos = it.lot_id ? posByLotId.get(it.lot_id) : undefined;
              const lotPositions = it.lots?.positions;
              const livePosFromLot = Array.isArray(lotPositions) ? lotPositions[0] : lotPositions;
              const origPosCode = it.positions?.code || null;
              const posId = lotLivePos?.id || livePosFromLot?.id || it.position_id || it.positions?.id || null;
              const posCode = lotLivePos?.code || livePosFromLot?.code || origPosCode || null;
              const isAtHall = Boolean(
                lotLivePos?.isHall ||
                  (origPosCode && posCode && origPosCode !== posCode)
              );
              const displayStatus =
                it.status === 'Exported'
                  ? 'Exported'
                  : isAtHall
                    ? 'Moved to Hall'
                    : it.status || 'Pending';

              return {
                id: it.id,
                task_id: it.task_id || t.id,
                lot_id: it.lot_id,
                product_id: it.product_id || it.products?.id || null,
                position_id: posId,
                quantity: it.quantity ?? null,
                exported_quantity: it.exported_quantity ?? null,
                unit: it.unit || 'Thùng',
                status: it.status || 'Pending',
                priority: Number(it.priority) || 0,
                lot_code: it.lots?.code || null,
                lot_stt: it.lots?.daily_seq ?? null,
                production_code: it.lots?.production_code || null,
                tags: Array.isArray(it.lots?.lot_tags)
                  ? Array.from(
                      new Set(
                        it.lots.lot_tags
                          .map((lt: any) => (lt?.tag || '').trim())
                          .filter(Boolean)
                      )
                    )
                  : [],
                lot_notes: it.lots?.notes || null,
                product_name: it.products?.name || null,
                product_sku: it.products?.sku || null,
                position_code: posCode,
                display_status: displayStatus,
              };
            });

          return {
            id: t.id,
            code: t.code,
            status: t.status,
            system_code: t.system_code,
            notes: t.notes || null,
            created_at: t.created_at,
            created_by: t.created_by || null,
            items,
          };
        });

        setExportTasks(formatted);
        await AsyncStorage.setItem(cacheKey, JSON.stringify(formatted));

        // Nếu đang mở 1 lệnh xuất thì đồng bộ danh sách items mới
        setSelectedTask(prev => {
          if (!prev) return null;
          const updated = formatted.find(f => f.id === prev.id);
          if (updated) {
            setTaskItems(updated.items);
            return updated;
          }
          return prev;
        });
      } catch (err: any) {
        console.warn('Lỗi tải danh sách Lệnh Xuất:', err?.message || err);
      } finally {
        setLoading(false);
      }
    },
    [systemCode, loadWarehouseMapStructure]
  );

  useEffect(() => {
    if (isActive) {
      loadPendingOps();
      loadExportTasks();
    }
  }, [isActive, loadPendingOps, loadExportTasks]);

  // Tự động tạm dừng camera sau 15 giây không quét để tiết kiệm pin
  const resetPauseTimer = useCallback(() => {
    if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
    setIsScanningPaused(false);
    if (step === 'scan' && showCamera) {
      pauseTimeoutRef.current = setTimeout(() => {
        setIsScanningPaused(true);
      }, 15000);
    }
  }, [step, showCamera]);

  useEffect(() => {
    if (step === 'scan' && showCamera && isActive) {
      resetPauseTimer();
    } else if (pauseTimeoutRef.current) {
      clearTimeout(pauseTimeoutRef.current);
    }
    return () => {
      if (pauseTimeoutRef.current) clearTimeout(pauseTimeoutRef.current);
    };
  }, [step, showCamera, isActive, resetPauseTimer]);

  // Đồng bộ hàng đợi Hạ Sảnh ngoại tuyến lên Supabase
  const handleSyncPendingOps = useCallback(async () => {
    if (pendingOps.length === 0 || syncingOps) return;
    setSyncingOps(true);
    try {
      const client = await getSupabaseClient();
      const remaining: WorkPendingOp[] = [];
      let syncedCount = 0;

      for (const op of pendingOps) {
        try {
          if (op.oldPosId) {
            await withTimeout(
              client.from('positions').update({ lot_id: null }).eq('id', op.oldPosId),
              5000
            );
          }
          const { error } = await withTimeout(
            client.from('positions').update({ lot_id: op.lotId }).eq('id', op.hallPosId),
            5000
          );
          if (error) {
            remaining.push(op);
          } else {
            syncedCount++;
          }
        } catch {
          remaining.push(op);
        }
      }

      await savePendingOps(remaining);
      if (syncedCount > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert(
          'Đồng bộ thành công',
          `Đã đẩy ${syncedCount} thao tác hạ sảnh lên hệ thống.${
            remaining.length > 0 ? ` Còn ${remaining.length} thao tác chờ mạng.` : ''
          }`
        );
        await loadExportTasks();
      } else if (remaining.length > 0) {
        Alert.alert('Chưa thể đồng bộ', 'Vui lòng kiểm tra kết nối mạng và thử lại.');
      }
    } finally {
      setSyncingOps(false);
    }
  }, [pendingOps, syncingOps, savePendingOps, loadExportTasks]);

  const handleSelectTask = (task: WorkExportTask) => {
    setSelectedTask(task);
    setTaskItems(task.items || []);
    setStep('scan');
  };

  // Tìm danh sách các vị trí trống thuộc khu vực Sảnh (is_hall)
  const findEmptyHallPositions = useCallback(
    (count: number, excludePosIds = new Set<string>()): WorkMapPosition[] => {
      const hallZoneIds = new Set(allZones.filter(z => z.is_hall).map(z => z.id));
      let added = true;
      while (added) {
        added = false;
        for (const z of allZones) {
          if (z.parent_id && hallZoneIds.has(z.parent_id) && !hallZoneIds.has(z.id)) {
            hallZoneIds.add(z.id);
            added = true;
          }
        }
      }

      const emptyHallPositions = allPositions
        .filter(p => {
          if (p.lot_id || excludePosIds.has(p.id)) return false;
          const zIds = Array.isArray(p.zone_ids)
            ? p.zone_ids
            : p.zone_id
              ? [p.zone_id]
              : [];
          return zIds.some(zid => hallZoneIds.has(zid));
        })
        .sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));

      return emptyHallPositions.slice(0, count);
    },
    [allZones, allPositions]
  );

  // Thực thi Hạ Sảnh cho 1 hoặc nhiều kiện hàng (LOT)
  const executeMoveItemsToHall = useCallback(
    async (itemsToMove: WorkExportTaskItem[]) => {
      const validItems = itemsToMove.filter(it => it.display_status !== 'Moved to Hall');
      if (validItems.length === 0) return;

      const emptyHallList = findEmptyHallPositions(validItems.length);
      if (emptyHallList.length < validItems.length) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(
          'Hết vị trí Sảnh',
          `Cần ${validItems.length} ô trống tại khu vực Sảnh (is_hall) nhưng chỉ còn ${emptyHallList.length} ô trống!`
        );
        return;
      }

      const assignments = validItems.map((it, idx) => ({
        item: it,
        hallPos: emptyHallList[idx],
      }));

      // 1. Cập nhật Optimistic UI ngay lập tức
      const movedMap = new Map<string, WorkMapPosition>();
      assignments.forEach(a => movedMap.set(a.item.id, a.hallPos));

      setTaskItems(prev =>
        prev.map(it => {
          const hallPos = movedMap.get(it.id);
          if (!hallPos) return it;
          return {
            ...it,
            display_status: 'Moved to Hall',
            position_id: hallPos.id,
            position_code: hallPos.code,
          };
        })
      );

      setAllPositions(prev => {
        const oldPosSet = new Set(
          assignments.map(a => a.item.position_id).filter(Boolean) as string[]
        );
        const hallAssignMap = new Map<string, string>();
        assignments.forEach(a => hallAssignMap.set(a.hallPos.id, a.item.lot_id));

        return prev.map(p => {
          if (hallAssignMap.has(p.id)) {
            return { ...p, lot_id: hallAssignMap.get(p.id) || null };
          }
          if (oldPosSet.has(p.id)) {
            return { ...p, lot_id: null };
          }
          return p;
        });
      });

      // 2. Đẩy trực tiếp lên Supabase hoặc lưu vào hàng đợi Offline nếu mất mạng
      const client = await getSupabaseClient();
      const newFailedOps: WorkPendingOp[] = [];

      for (const { item, hallPos } of assignments) {
        try {
          if (item.position_id) {
            await withTimeout(
              client.from('positions').update({ lot_id: null }).eq('id', item.position_id),
              5000
            );
          }
          const { error } = await withTimeout(
            client.from('positions').update({ lot_id: item.lot_id }).eq('id', hallPos.id),
            5000
          );
          if (error) throw error;
        } catch {
          newFailedOps.push({
            id: `${Date.now()}_${item.id}`,
            type: 'HA_SANH',
            system_code: systemCode,
            lotId: item.lot_id,
            lotCode: item.lot_code || '',
            hallPosId: hallPos.id,
            hallPosCode: hallPos.code,
            oldPosId: item.position_id,
            taskItemId: item.id,
            taskId: item.task_id,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (newFailedOps.length > 0) {
        await savePendingOps([...pendingOps, ...newFailedOps]);
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    },
    [findEmptyHallPositions, pendingOps, savePendingOps, systemCode]
  );

  // Xử lý bật/tắt công tắc "Đã hạ" theo cả Kệ trong bảng thống kê
  const handleToggleZoneMovedToHall = useCallback(
    async (itemsInRow: WorkExportTaskItem[], shouldMoveToHall: boolean) => {
      if (shouldMoveToHall) {
        await executeMoveItemsToHall(itemsInRow);
      } else {
        // Hoàn tác trạng thái hiển thị về Pending trên máy
        const targetIds = new Set(itemsInRow.map(i => i.id));
        setTaskItems(prev =>
          prev.map(it => (targetIds.has(it.id) ? { ...it, display_status: 'Pending' } : it))
        );
      }
    },
    [executeMoveItemsToHall]
  );

  // Xử lý khi quét mã QR / Barcode hoặc nhập tay mã LOT / STT / Vị trí
  const handleProcessCode = useCallback(
    async (rawInput: string) => {
      let cleanCode = (rawInput || '').trim().toUpperCase();
      if (!cleanCode) return;

      // Hỗ trợ bóc tách URL QR nếu có
      if (cleanCode.includes('/')) {
        const parts = cleanCode.split('/');
        cleanCode = parts[parts.length - 1] || cleanCode;
      }

      setScannedResult(cleanCode);
      setTimeout(() => setScannedResult(null), 1500);

      const targetItem = taskItems.find(item => {
        const lCode = (item.lot_code || '').toUpperCase();
        const pCode = (item.position_code || '').toUpperCase();
        const prodCode = (item.production_code || '').toUpperCase();
        const sttDisplay = (formatSttDisplay(item.lot_stt) || '').toUpperCase();
        const sttRaw = item.lot_stt ? String(item.lot_stt).toUpperCase() : '';
        return (
          lCode === cleanCode ||
          pCode === cleanCode ||
          prodCode === cleanCode ||
          sttDisplay === cleanCode ||
          sttRaw === cleanCode
        );
      });

      if (!targetItem) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        Alert.alert(
          'Không khớp Lệnh Xuất',
          `Mã "${cleanCode}" không nằm trong danh sách cần lấy của Lệnh Xuất ${selectedTask?.code || ''}.`
        );
        return;
      }

      if (targetItem.display_status === 'Moved to Hall') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        Alert.alert(
          'Đã ở Sảnh',
          `LOT ${targetItem.lot_code} đã được hạ xuống sảnh (${targetItem.position_code || 'Sảnh'}).`
        );
        return;
      }

      await executeMoveItemsToHall([targetItem]);
      setManualCode('');
    },
    [taskItems, selectedTask, executeMoveItemsToHall]
  );

  // Xuất kho hàng loạt cho toàn bộ các LOT đã Hạ Sảnh ('Moved to Hall')
  const handleBulkExport = useCallback(() => {
    const hallItems = taskItems.filter(i => i.display_status === 'Moved to Hall');
    if (hallItems.length === 0) {
      Alert.alert('Chưa có hàng ở Sảnh', 'Không có kiện hàng nào ở trạng thái "Ở sảnh" để xuất kho.');
      return;
    }

    Alert.alert(
      'Xác nhận Xuất Kho',
      `Bạn có chắc chắn muốn xuất kho ${hallItems.length} LOT đã hạ sảnh thuộc lệnh ${selectedTask?.code || ''}?`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xuất Kho Ngay',
          style: 'default',
          onPress: async () => {
            setLoading(true);
            try {
              const client = await getSupabaseClient();
              let successCount = 0;

              for (const item of hallItems) {
                const { data: freshLot, error: lotError } = await withTimeout(
                  client
                    .from('lots')
                    .select('*, lot_items(*, products(name, sku, unit))')
                    .eq('id', item.lot_id)
                    .single(),
                  7000
                );

                if (lotError || !freshLot) continue;

                const lotItems: any[] = Array.isArray(freshLot.lot_items) ? freshLot.lot_items : [];
                let targetLotItem = lotItems.find(
                  li => item.product_id && li.product_id === item.product_id
                );
                if (!targetLotItem && lotItems.length === 1) {
                  targetLotItem = lotItems[0];
                }

                const currentItemQty = targetLotItem
                  ? Number(targetLotItem.quantity) || 0
                  : Number(freshLot.quantity) || 0;
                const exportQty =
                  item.quantity && item.quantity > 0 ? Number(item.quantity) : currentItemQty;
                const remainingItemQty = Math.max(0, currentItemQty - exportQty);

                if (targetLotItem) {
                  if (remainingItemQty <= 0.000001) {
                    await client.from('lot_items').delete().eq('id', targetLotItem.id);
                  } else {
                    await client
                      .from('lot_items')
                      .update({ quantity: remainingItemQty })
                      .eq('id', targetLotItem.id);
                  }
                }

                const otherItemsQty = lotItems
                  .filter(li => !targetLotItem || li.id !== targetLotItem.id)
                  .reduce((sum, li) => sum + (Number(li.quantity) || 0), 0);
                const totalRemaining = Number((remainingItemQty + otherItemsQty).toFixed(6));

                const currentMetadata =
                  freshLot.metadata && typeof freshLot.metadata === 'object'
                    ? freshLot.metadata
                    : {};
                const systemHistory = currentMetadata.system_history || {};
                const exportsHistory = Array.isArray(systemHistory.exports)
                  ? systemHistory.exports
                  : [];

                const newExportRecord = {
                  id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                  date: new Date().toISOString(),
                  customer: `Lệnh xuất ${selectedTask?.code || ''}`,
                  description: `Xuất từ App Công Việc (${user?.full_name || 'Nhân viên kho'})`,
                  location_code: item.position_code || 'Sảnh',
                  OrderCode: selectedTask?.code || '',
                  draft: true,
                  items: {
                    [targetLotItem?.id || item.lot_id]: {
                      product_id: item.product_id || targetLotItem?.product_id,
                      product_sku: item.product_sku || targetLotItem?.products?.sku || '',
                      product_name: item.product_name || targetLotItem?.products?.name || '',
                      exported_quantity: exportQty,
                      unit: item.unit || targetLotItem?.unit || 'Thùng',
                      production_code: item.production_code || freshLot.production_code || '',
                    },
                  },
                };

                const updatedMetadata = {
                  ...currentMetadata,
                  system_history: {
                    ...systemHistory,
                    exports: [newExportRecord, ...exportsHistory],
                  },
                };

                const updateLotPayload: Record<string, any> = {
                  quantity: totalRemaining,
                  metadata: updatedMetadata,
                };
                if (totalRemaining <= 0.000001) {
                  updateLotPayload.status = 'exported';
                }

                await client.from('lots').update(updateLotPayload).eq('id', item.lot_id);

                if (totalRemaining <= 0.000001) {
                  await client
                    .from('positions')
                    .update({ lot_id: null })
                    .eq('lot_id', item.lot_id);
                }

                await client
                  .from('export_task_items')
                  .update({
                    status: 'Exported',
                    exported_quantity: exportQty,
                  })
                  .eq('id', item.id);

                successCount++;
              }

              const exportedIds = new Set(hallItems.map(i => i.id));
              const remainingItems = taskItems.filter(i => !exportedIds.has(i.id));
              setTaskItems(remainingItems);

              if (remainingItems.length === 0 && selectedTask) {
                await client
                  .from('export_tasks')
                  .update({ status: 'Completed' })
                  .eq('id', selectedTask.id);
              }

              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              Alert.alert(
                'Xuất kho hoàn tất',
                `Đã xuất thành công ${successCount}/${hallItems.length} LOT.`
              );

              if (remainingItems.length === 0) {
                setStep('select');
                setSelectedTask(null);
              }
              await loadExportTasks();
            } catch (err: any) {
              Alert.alert(
                'Lỗi xuất kho',
                err?.message || 'Cần có kết nối mạng ổn định khi chốt xuất kho.'
              );
            } finally {
              setLoading(false);
            }
          },
        },
      ]
    );
  }, [taskItems, selectedTask, user?.full_name, loadExportTasks]);

  const handleOptimisticPriorityUpdate = useCallback((itemIds: string[], priority: number) => {
    const idSet = new Set(itemIds);
    setTaskItems(prev => prev.map(it => (idSet.has(it.id) ? { ...it, priority } : it)));
  }, []);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = !q
      ? taskItems
      : taskItems.filter(item => {
          const lCode = (item.lot_code || '').toLowerCase();
          const pName = (item.product_name || '').toLowerCase();
          const pSku = (item.product_sku || '').toLowerCase();
          const posCode = (item.position_code || '').toLowerCase();
          const prodCode = (item.production_code || '').toLowerCase();
          const sttStr = (formatSttDisplay(item.lot_stt) || '').toLowerCase();
          return (
            lCode.includes(q) ||
            pName.includes(q) ||
            pSku.includes(q) ||
            posCode.includes(q) ||
            prodCode.includes(q) ||
            sttStr.includes(q)
          );
        });

    return [...list].sort((a, b) => {
      const aMoved = a.display_status === 'Moved to Hall' ? 1 : 0;
      const bMoved = b.display_status === 'Moved to Hall' ? 1 : 0;
      if (aMoved !== bMoved) return aMoved - bMoved;

      const pA = a.priority || 0;
      const pB = b.priority || 0;
      if (pA !== pB) {
        if (pA === 0) return 1;
        if (pB === 0) return -1;
        return pA - pB;
      }
      return (a.position_code || '').localeCompare(b.position_code || '', undefined, {
        numeric: true,
      });
    });
  }, [taskItems, searchQuery]);

  // ── BƯỚC 1: DANH SÁCH LỆNH XUẤT ─────────────────────────────────────────────
  if (step === 'select') {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        {/* Header siêu gọn 1 dòng */}
        <View style={[styles.headerRow, { marginBottom: 10 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                backgroundColor: 'rgba(59, 130, 246, 0.14)',
                borderWidth: 1,
                borderColor: 'rgba(59, 130, 246, 0.35)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="briefcase" size={16} color="#3b82f6" />
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[styles.screenTitle, { fontSize: 16, color: colors.text }]}>
                  Công Việc
                </Text>
                <View
                  style={{
                    backgroundColor: 'rgba(59, 130, 246, 0.14)',
                    paddingHorizontal: 6,
                    paddingVertical: 1.5,
                    borderRadius: 6,
                  }}
                >
                  <Text style={{ fontSize: 10, fontWeight: '800', color: '#3b82f6' }}>
                    {exportTasks.length} lệnh
                  </Text>
                </View>
              </View>
              <Text style={[styles.screenSubtitle, { fontSize: 11, color: colors.textMuted }]}>
                Chọn lệnh xuất để hạ sảnh & xuất kho
              </Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={() => loadExportTasks()}
            disabled={loading}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              backgroundColor: '#2563eb',
              paddingHorizontal: 11,
              height: 34,
              borderRadius: 10,
            }}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Feather name="refresh-cw" size={13} color="#ffffff" />
            )}
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>Tải lại</Text>
          </TouchableOpacity>
        </View>

        {pendingOps.length > 0 && (
          <View style={styles.pendingBanner}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              <Ionicons name="cloud-upload-outline" size={18} color="#f59e0b" />
              <Text style={styles.pendingBannerText}>
                {pendingOps.length} thao tác chờ đồng bộ
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleSyncPendingOps}
              disabled={syncingOps}
              style={styles.pendingSyncBtn}
            >
              {syncingOps ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text style={styles.pendingSyncBtnText}>Đồng bộ</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {loading && exportTasks.length === 0 ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ color: colors.textMuted, marginTop: 10 }}>
              Đang tải danh sách lệnh xuất...
            </Text>
          </View>
        ) : (
          <FlatList
            data={exportTasks}
            keyExtractor={item => item.id}
            contentContainerStyle={{ paddingBottom: 32 }}
            renderItem={({ item }) => {
              const totalCount = item.items?.length || 0;
              const hallCount =
                item.items?.filter(it => it.display_status === 'Moved to Hall').length || 0;
              const totalQty =
                item.items?.reduce((s, it) => s + (Number(it.quantity) || 0), 0) || 0;
              const unit = item.items?.find(it => it.unit)?.unit || '';
              const pct = totalCount > 0 ? Math.round((hallCount / totalCount) * 100) : 0;

              return (
                <TouchableOpacity
                  activeOpacity={0.78}
                  onPress={() => handleSelectTask(item)}
                  style={[
                    styles.taskCard,
                    {
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      padding: 11,
                      gap: 8,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        backgroundColor: 'rgba(16, 185, 129, 0.14)',
                        borderWidth: 1,
                        borderColor: 'rgba(16, 185, 129, 0.3)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Feather name="file-text" size={17} color="#10b981" />
                    </View>

                    <View style={{ flex: 1 }}>
                      <Text
                        style={[styles.taskCodeText, { fontSize: 14, color: colors.text }]}
                        numberOfLines={1}
                      >
                        {item.code}
                      </Text>
                      <Text
                        style={[styles.taskMetaText, { fontSize: 11, marginTop: 1, color: colors.textMuted }]}
                        numberOfLines={1}
                      >
                        {new Date(item.created_at).toLocaleDateString('vi-VN')}
                        {item.notes ? ` • ${item.notes}` : ''}
                      </Text>
                    </View>

                    <View style={{ alignItems: 'flex-end' }}>
                      {totalQty > 0 && (
                        <Text style={{ fontSize: 12, fontWeight: '800', color: '#f59e0b' }}>
                          {totalQty.toLocaleString('vi-VN')} {unit}
                        </Text>
                      )}
                      <Text style={{ fontSize: 10, fontWeight: '700', color: '#3b82f6' }}>
                        {hallCount}/{totalCount} LOT hạ
                      </Text>
                    </View>

                    <Feather name="chevron-right" size={17} color={colors.textMuted} />
                  </View>

                  <View style={[styles.progressBarBg, { height: 5 }]}>
                    <View
                      style={[
                        styles.progressBarFill,
                        {
                          width: `${pct}%`,
                          backgroundColor: pct >= 100 ? '#10b981' : '#3b82f6',
                        },
                      ]}
                    />
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Feather name="inbox" size={44} color={colors.textMuted} />
                <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>
                  Không có lệnh xuất nào đang chờ
                </Text>
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                  Khi Web tạo Lệnh Xuất mới cho phân hệ {systemCode}, lệnh sẽ hiển thị tại đây.
                </Text>
              </View>
            }
          />
        )}
      </View>
    );
  }

  // ── BƯỚC 2: CHI TIẾT LỆNH XUẤT & QUÉT HẠ SẢNH / XUẤT KHO ───────────────────
  const completedCount = taskItems.filter(i => i.display_status === 'Moved to Hall').length;
  const totalCount = taskItems.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header siêu gọn: Back + Tên lệnh & thanh tiến độ + Nút Xuất / Thống kê / Cam */}
      <View style={[styles.scanHeader, { marginBottom: 8 }]}>
        <TouchableOpacity
          onPress={() => setStep('select')}
          style={[
            styles.iconToolBtn,
            { width: 34, height: 34, backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Feather name="arrow-left" size={18} color={colors.text} />
        </TouchableOpacity>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[styles.scanHeaderTitle, { fontSize: 15, color: colors.text }]} numberOfLines={1}>
              {selectedTask?.code}
            </Text>
            <View
              style={{
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                paddingHorizontal: 6,
                paddingVertical: 1.5,
                borderRadius: 6,
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: '800', color: '#3b82f6' }}>
                {completedCount}/{totalCount} hạ
              </Text>
            </View>
          </View>
          <View style={[styles.progressBarBg, { height: 5, marginTop: 4 }]}>
            <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
          </View>
        </View>

        {completedCount > 0 && (
          <TouchableOpacity
            onPress={handleBulkExport}
            disabled={loading}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: '#e11d48',
              paddingHorizontal: 9,
              height: 34,
              borderRadius: 10,
            }}
          >
            <Feather name="external-link" size={13} color="#ffffff" />
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>
              Xuất ({completedCount})
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={() => setStatsModalVisible(true)}
          style={[
            styles.iconToolBtn,
            { width: 34, height: 34, backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <Feather name="bar-chart-2" size={16} color="#3b82f6" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={async () => {
            if (!showCamera && !permission?.granted) {
              await requestPermission();
            }
            setShowCamera(prev => !prev);
          }}
          style={[
            styles.iconToolBtn,
            {
              width: 34,
              height: 34,
              backgroundColor: showCamera ? '#2563eb' : colors.surface,
              borderColor: showCamera ? '#3b82f6' : colors.border,
            },
          ]}
        >
          <Feather
            name={showCamera ? 'edit-3' : 'camera'}
            size={16}
            color={showCamera ? '#ffffff' : colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      {pendingOps.length > 0 && (
        <View style={styles.pendingBanner}>
          <Text style={styles.pendingBannerText}>
            Chờ đồng bộ: {pendingOps.length} thao tác hạ sảnh
          </Text>
          <TouchableOpacity
            onPress={handleSyncPendingOps}
            disabled={syncingOps}
            style={styles.pendingSyncBtn}
          >
            <Text style={styles.pendingSyncBtnText}>
              {syncingOps ? 'Đang gửi...' : 'Đồng bộ'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Khung Camera Quét QR/Barcode */}
      {showCamera && (
        <View style={styles.scannerWrapper}>
          {permission?.granted && !isScanningPaused && isActive ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'ean13'] }}
              onBarcodeScanned={({ data }) => {
                if (!scannedResult && data) {
                  resetPauseTimer();
                  handleProcessCode(data);
                }
              }}
            />
          ) : (
            <View style={styles.pausedOverlay}>
              <TouchableOpacity
                onPress={async () => {
                  if (!permission?.granted) {
                    await requestPermission();
                  }
                  resetPauseTimer();
                }}
                style={styles.resumeContent}
              >
                <Feather name="camera" size={30} color="#3b82f6" />
                <Text style={styles.resumeTitle}>
                  {!permission?.granted ? 'Cấp quyền Camera để quét' : 'Camera đang tạm dừng'}
                </Text>
                <Text style={styles.resumeSub}>Chạm vào đây để bật lại camera</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.scannerOverlay} pointerEvents="none">
            <View style={styles.scanFrame} />
            {scannedResult && (
              <View style={styles.scanFeedback}>
                <Feather name="check" size={28} color="#22c55e" />
                <Text style={styles.scanFeedbackText}>{scannedResult}</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Thanh gộp 1 dòng: Tìm lọc / Nhập mã hạ nhanh + Chuyển Sơ đồ / DS */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
        }}
      >
        <View
          style={[
            styles.searchBox,
            {
              flex: 1,
              height: 36,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Feather name="search" size={14} color={colors.textMuted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Lọc hoặc nhập LOT / STT / vị trí..."
            placeholderTextColor={colors.textMuted}
            value={manualCode}
            onChangeText={val => {
              setManualCode(val);
              setSearchQuery(val);
            }}
            autoCapitalize="characters"
            onSubmitEditing={() => handleProcessCode(manualCode)}
          />
          {manualCode.length > 0 && (
            <TouchableOpacity
              onPress={() => {
                setManualCode('');
                setSearchQuery('');
              }}
            >
              <Feather name="x-circle" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}
          {manualCode.trim().length > 0 && (
            <TouchableOpacity
              onPress={() => handleProcessCode(manualCode)}
              style={{
                backgroundColor: '#f59e0b',
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 6,
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: '900', color: '#0f172a' }}>Hạ</Text>
            </TouchableOpacity>
          )}
        </View>

        <View
          style={{
            flexDirection: 'row',
            backgroundColor: colors.surface,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            padding: 2,
            height: 36,
            alignItems: 'center',
          }}
        >
          <TouchableOpacity
            onPress={() => setViewMode('map')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              height: 30,
              borderRadius: 7,
              backgroundColor: viewMode === 'map' ? '#059669' : 'transparent',
            }}
          >
            <Ionicons
              name="map"
              size={13}
              color={viewMode === 'map' ? '#ffffff' : colors.textMuted}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: '800',
                color: viewMode === 'map' ? '#ffffff' : colors.textSecondary,
              }}
            >
              Sơ đồ
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setViewMode('list')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 8,
              height: 30,
              borderRadius: 7,
              backgroundColor: viewMode === 'list' ? '#2563eb' : 'transparent',
            }}
          >
            <Ionicons
              name="list"
              size={13}
              color={viewMode === 'list' ? '#ffffff' : colors.textMuted}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: '800',
                color: viewMode === 'list' ? '#ffffff' : colors.textSecondary,
              }}
            >
              DS
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Hiển thị theo Sơ Đồ Kho hoặc Danh sách LOT */}
      {viewMode === 'map' ? (
        <WorkTaskMapView
          taskItems={filteredItems}
          zones={allZones}
          positions={allPositions}
          onHaSanh={item => executeMoveItemsToHall([item])}
          onHaSanhAll={items => executeMoveItemsToHall(items)}
        />
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingBottom: 28 }}
          renderItem={({ item }) => {
          const isCompleted = item.display_status === 'Moved to Hall';
          const pInfo = getPriorityInfo(item.priority);
          const sttLabel = formatSttDisplay(item.lot_stt);

          return (
            <View
              style={[
                styles.itemCard,
                {
                  backgroundColor: colors.surface,
                  borderColor: pInfo
                    ? pInfo.border
                    : isCompleted
                      ? 'rgba(34, 197, 94, 0.45)'
                      : colors.border,
                },
              ]}
            >
              <View style={{ flex: 1, paddingRight: 8 }}>
                <View style={styles.itemHeaderLine}>
                  {pInfo && <View style={[styles.priorityDot, { backgroundColor: pInfo.color }]} />}
                  <Text style={[styles.itemLotCode, { color: colors.text }]}>{item.lot_code}</Text>
                  {sttLabel ? (
                    <View style={styles.sttMiniBadge}>
                      <Text style={styles.sttMiniBadgeText}>#{sttLabel}</Text>
                    </View>
                  ) : null}
                  {item.production_code ? (
                    <View style={styles.prodCodeBadge}>
                      <Text style={styles.prodCodeBadgeText}>SX: {item.production_code}</Text>
                    </View>
                  ) : null}
                </View>

                <Text style={[styles.itemProduct, { color: colors.textSecondary }]} numberOfLines={2}>
                  {item.product_sku ? `[${item.product_sku}] ` : ''}
                  {item.product_name || 'Sản phẩm'}
                </Text>

                <View style={styles.itemMetaRow}>
                  <View style={styles.posBadge}>
                    <Feather name="map-pin" size={11} color="#3b82f6" />
                    <Text style={styles.posBadgeText}>
                      {item.position_code || 'Chưa rõ vị trí'}
                    </Text>
                  </View>
                  <Text style={[styles.itemQtyText, { color: colors.textSecondary }]}>
                    SL: <Text style={{ fontWeight: '800', color: colors.text }}>{item.quantity ?? 0}</Text>{' '}
                    {item.unit || 'Thùng'}
                  </Text>
                </View>

                {item.lot_notes ? (
                  <Text style={styles.itemNotesText} numberOfLines={1}>
                    Ghi chú: {item.lot_notes}
                  </Text>
                ) : null}
              </View>

              <View style={{ alignItems: 'flex-end', justifyContent: 'center', gap: 6 }}>
                <View
                  style={[
                    styles.statusBadge,
                    isCompleted ? styles.statusMoved : styles.statusPending,
                  ]}
                >
                  <Text
                    style={[
                      styles.statusBadgeText,
                      { color: isCompleted ? '#22c55e' : '#eab308' },
                    ]}
                  >
                    {isCompleted ? 'Ở sảnh' : 'Chờ hạ'}
                  </Text>
                </View>

                {!isCompleted && (
                  <TouchableOpacity
                    onPress={() => executeMoveItemsToHall([item])}
                    style={styles.quickHaSanhBtn}
                  >
                    <Feather name="arrow-down-circle" size={13} color="#ffffff" />
                    <Text style={styles.quickHaSanhBtnText}>Hạ sảnh</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>
              Không tìm thấy LOT nào khớp từ khóa lọc.
            </Text>
          </View>
        }
      />
      )}

      <ExportOrderStatsModal
        visible={statsModalVisible}
        onClose={() => setStatsModalVisible(false)}
        taskCode={selectedTask?.code || ''}
        taskItems={taskItems}
        zones={allZones}
        positions={allPositions}
        onRefresh={() => loadExportTasks()}
        onToggleZoneMovedToHall={handleToggleZoneMovedToHall}
        onOptimisticPriorityUpdate={handleOptimisticPriorityUpdate}
      />
    </View>
  );
}

const BASE_STYLES = {
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  headerRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 14,
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: '800' as const,
    color: '#f8fafc',
  },
  screenSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2,
  },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  pendingBanner: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 12,
  },
  pendingBannerText: {
    fontSize: 12,
    fontWeight: '700' as const,
    color: '#d97706',
    flex: 1,
  },
  pendingSyncBtn: {
    backgroundColor: '#d97706',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginLeft: 8,
  },
  pendingSyncBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800' as const,
  },
  centerLoading: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  taskCard: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  taskIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  taskCodeText: {
    fontSize: 16,
    fontWeight: '800' as const,
  },
  taskCountPill: {
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  taskCountPillText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#3b82f6',
  },
  taskMetaText: {
    fontSize: 12,
    marginTop: 4,
  },
  emptyBox: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingVertical: 48,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700' as const,
    marginTop: 12,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center' as const,
    marginTop: 6,
  },
  scanHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    marginBottom: 10,
  },
  backBtn: {
    padding: 6,
  },
  scanHeaderTitle: {
    fontSize: 17,
    fontWeight: '800' as const,
  },
  scanHeaderSub: {
    fontSize: 11,
  },
  iconToolBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  cameraToggleBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    paddingHorizontal: 10,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
  },
  progressCard: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  progressHeaderRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
  progressCountText: {
    fontSize: 15,
    fontWeight: '800' as const,
    marginTop: 1,
  },
  bulkExportBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    backgroundColor: '#22c55e',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
  },
  bulkExportBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800' as const,
  },
  progressBarBg: {
    height: 7,
    backgroundColor: 'rgba(148, 163, 184, 0.25)',
    borderRadius: 4,
    overflow: 'hidden' as const,
  },
  progressBarFill: {
    height: '100%' as const,
    backgroundColor: '#22c55e',
    borderRadius: 4,
  },
  scannerWrapper: {
    height: 175,
    borderRadius: 16,
    overflow: 'hidden' as const,
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  pausedOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0f172a',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  resumeContent: {
    alignItems: 'center' as const,
    padding: 16,
  },
  resumeTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700' as const,
    marginTop: 8,
  },
  resumeSub: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  scannerOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  scanFrame: {
    width: 190,
    height: 110,
    borderWidth: 2,
    borderColor: '#3b82f6',
    borderRadius: 12,
  },
  scanFeedback: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  scanFeedbackText: {
    color: '#22c55e',
    fontSize: 16,
    fontWeight: '800' as const,
    marginTop: 4,
  },
  inputFilterGroup: {
    gap: 8,
    marginBottom: 10,
  },
  manualRow: {
    flexDirection: 'row' as const,
    gap: 8,
  },
  manualInput: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
  },
  manualSubmitBtn: {
    width: 44,
    height: 42,
    borderRadius: 10,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  searchBox: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    paddingVertical: 0,
  },
  itemCard: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  itemHeaderLine: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
    gap: 6,
  },
  priorityDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  itemLotCode: {
    fontSize: 14,
    fontWeight: '800' as const,
  },
  sttMiniBadge: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  sttMiniBadgeText: {
    fontSize: 11,
    fontWeight: '800' as const,
    color: '#d97706',
  },
  prodCodeBadge: {
    backgroundColor: 'rgba(139, 92, 246, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  prodCodeBadgeText: {
    fontSize: 10,
    fontWeight: '700' as const,
    color: '#7c3aed',
  },
  itemProduct: {
    fontSize: 12,
    marginTop: 3,
  },
  itemMetaRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    marginTop: 5,
  },
  posBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  posBadgeText: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#3b82f6',
  },
  itemQtyText: {
    fontSize: 12,
  },
  itemNotesText: {
    fontSize: 11,
    color: '#eab308',
    fontStyle: 'italic' as const,
    marginTop: 3,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusMoved: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: '#22c55e',
  },
  statusPending: {
    backgroundColor: 'rgba(234, 179, 8, 0.12)',
    borderColor: '#eab308',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800' as const,
  },
  quickHaSanhBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    backgroundColor: '#3b82f6',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
  },
  quickHaSanhBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800' as const,
  },
  // Modal Thống kê vị trí
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.78)',
    justifyContent: 'flex-end' as const,
  },
  modalContainer: {
    height: SCREEN_HEIGHT * 0.86,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    overflow: 'hidden' as const,
  },
  modalHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800' as const,
  },
  modalSubtitle: {
    fontSize: 12,
    fontWeight: '700' as const,
    marginTop: 2,
  },
  groupToggleBox: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
  },
  groupToggleLabel: {
    fontSize: 11,
    fontWeight: '700' as const,
  },
  closeIconBtn: {
    padding: 6,
  },
  legendBar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
    borderBottomWidth: 1,
  },
  legendTitle: {
    fontSize: 10,
    fontWeight: '800' as const,
  },
  legendItem: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
  whTabBar: {
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  whTab: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    gap: 7,
  },
  whTabName: {
    fontSize: 13,
    fontWeight: '700' as const,
  },
  whBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  whBadgeText: {
    fontSize: 11,
    fontWeight: '800' as const,
  },
  zoneStatCard: {
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
  },
  zoneStatRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    marginBottom: 8,
  },
  zoneIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginRight: 10,
  },
  zonePathText: {
    fontSize: 13,
    fontWeight: '700' as const,
  },
  zoneCountBig: {
    fontSize: 17,
    fontWeight: '800' as const,
  },
  quickMoveSwitchBox: {
    alignItems: 'center' as const,
    paddingLeft: 8,
    borderLeftWidth: 1,
  },
  miniProgressTrack: {
    height: 5,
    backgroundColor: 'rgba(148, 163, 184, 0.22)',
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  miniProgressFill: {
    height: '100%' as const,
    borderRadius: 3,
  },
  modalFooter: {
    padding: 16,
    borderTopWidth: 1,
  },
  closeFullBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center' as const,
  },
  closeFullBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800' as const,
  },
  // Sub-modal chi tiết kệ
  subModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    justifyContent: 'center' as const,
    padding: 18,
  },
  subModalCard: {
    borderRadius: 20,
    borderWidth: 1,
    overflow: 'hidden' as const,
  },
  subModalHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    padding: 16,
    borderBottomWidth: 1,
  },
  subModalTitle: {
    fontSize: 15,
    fontWeight: '800' as const,
  },
  subModalSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  priorityToolbar: {
    padding: 14,
    borderBottomWidth: 1,
  },
  priorityLabel: {
    fontSize: 11,
    fontWeight: '800' as const,
    marginBottom: 8,
  },
  priorityBtnRow: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: 6,
  },
  priorityChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  priorityChipText: {
    fontSize: 11,
    fontWeight: '800' as const,
  },
  subItemCard: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    padding: 11,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  subItemCode: {
    fontSize: 13,
    fontWeight: '800' as const,
  },
  subItemProduct: {
    fontSize: 12,
    marginTop: 2,
  },
  subItemPos: {
    fontSize: 11,
    fontWeight: '600' as const,
    marginTop: 2,
  },
};
