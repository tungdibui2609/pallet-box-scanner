import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  DraftProposal,
  ProposalItem,
  SubmittedProposal,
  removeDraftItem,
  clearLocalDraftProposal,
  submitAdjustmentProposalToServer,
  getSubmittedAdjustmentProposals,
  getCachedSubmittedProposals,
  syncOfflineAdjustmentProposals,
} from '../../services/warehouseAdjustmentService';
import { useAuth } from '../../contexts/AuthContext';

interface WarehouseDraftListModalProps {
  visible: boolean;
  onClose: () => void;
  draft: DraftProposal;
  onRefreshDraft: () => void;
  onSubmittedSuccess: () => void;
  onEditItem: (item: ProposalItem) => void;
}

export default function WarehouseDraftListModal({
  visible,
  onClose,
  draft,
  onRefreshDraft,
  onSubmittedSuccess,
  onEditItem,
}: WarehouseDraftListModalProps) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'DRAFT' | 'HISTORY'>('DRAFT');
  const [shiftNote, setShiftNote] = useState<string>(draft.notes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // State cho Tab Đã gửi duyệt
  const [submittedList, setSubmittedList] = useState<SubmittedProposal[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  const [historySearchQuery, setHistorySearchQuery] = useState<string>('');
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(null);

  // Chỉ đọc từ bộ nhớ máy khi mở modal (tránh tải ngầm gây lag)
  const loadCachedProposals = useCallback(async () => {
    try {
      const list = await getCachedSubmittedProposals('KHO_DONG_LANH');
      setSubmittedList(list);
    } catch {
      // ignore
    }
  }, []);

  // Chỉ tải mới từ máy chủ khi người dùng chủ động bấm nút Làm mới (↻)
  const loadSubmittedProposals = useCallback(async () => {
    setLoadingHistory(true);
    try {
      await syncOfflineAdjustmentProposals().catch(() => {});
      const list = await getSubmittedAdjustmentProposals('KHO_DONG_LANH');
      setSubmittedList(list);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      if (draft.items.length === 0) {
        setActiveTab('HISTORY');
      } else {
        setActiveTab('DRAFT');
      }
      loadCachedProposals();
    }
  }, [visible, draft.items.length, loadCachedProposals]);

  const filteredSubmitted = useMemo(() => {
    if (historyFilter === 'ALL') return submittedList;
    return submittedList.filter((p) => p.status === historyFilter);
  }, [submittedList, historyFilter]);

  const normalizedHistoryQuery = historySearchQuery.trim().toUpperCase();

  const matchedPositionHistory = useMemo(() => {
    if (!normalizedHistoryQuery) return [];
    const entries: Array<{ proposal: SubmittedProposal; item: ProposalItem }> = [];
    filteredSubmitted.forEach((prop) => {
      prop.items.forEach((it) => {
        const matchSrc = (it.position_code || '').toUpperCase().includes(normalizedHistoryQuery);
        const matchDst = (it.target_position_code || '').toUpperCase().includes(normalizedHistoryQuery);
        if (matchSrc || matchDst) {
          entries.push({ proposal: prop, item: it });
        }
      });
    });
    return entries;
  }, [filteredSubmitted, normalizedHistoryQuery]);

  const formatDateTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const hh = d.getHours().toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      const dd = d.getDate().toString().padStart(2, '0');
      const mo = (d.getMonth() + 1).toString().padStart(2, '0');
      return `${hh}:${mm} - ${dd}/${mo}`;
    } catch {
      return iso;
    }
  };

  const renderHistoryItemInfo = (it: ProposalItem) => {
    if (it.action_type === 'ASSIGN_LOT' && it.lot_found === false) {
      return (
        <Text style={styles.historyLotNotFound}>
          ⚠️ Không tìm thấy Lot khớp STT {it.lot_stt || '---'} trong kho
        </Text>
      );
    }

    const showProd = Boolean(it.product_name || it.lot_code || it.lot_stt || it.action_type !== 'NOTE');
    if (!showProd) return null;

    return (
      <View style={{ marginTop: 4, gap: 4 }}>
        <Text style={styles.historyDetailProd} numberOfLines={2}>
          {it.product_name || (it.action_type === 'NOTE' ? 'Ô trống' : 'Hàng đông lạnh')}
        </Text>
        {(it.lot_stt || it.lot_code || (it.action_type === 'ASSIGN_LOT' && it.new_quantity != null)) && (
          <View style={styles.historyLotRow}>
            {it.lot_stt ? (
              <View style={[styles.historyMetaBadge, styles.historyBadgeStt]}>
                <Text style={styles.historyBadgeSttText}>STT: {it.lot_stt}</Text>
              </View>
            ) : null}
            {it.lot_code ? (
              <View style={[styles.historyMetaBadge, styles.historyBadgeLot]}>
                <Text style={styles.historyBadgeLotText}>Lot: {it.lot_code}</Text>
              </View>
            ) : null}
            {it.action_type === 'ASSIGN_LOT' && it.new_quantity != null ? (
              <View style={[styles.historyMetaBadge, styles.historyBadgeQty]}>
                <Text style={styles.historyBadgeQtyText}>
                  SL: {it.new_quantity} {it.unit || 'Thùng'}
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  const handleDeleteItem = async (positionId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await removeDraftItem(positionId);
    onRefreshDraft();
  };

  const handleClearAll = () => {
    Alert.alert(
      'Hủy toàn bộ bản nháp',
      'Bạn có chắc chắn muốn xóa hết tất cả các vị trí đã ghi nháp?',
      [
        { text: 'Không', style: 'cancel' },
        {
          text: 'Xóa hết',
          style: 'destructive',
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            await clearLocalDraftProposal();
            onRefreshDraft();
            onClose();
          },
        },
      ]
    );
  };

  const handleSubmit = async () => {
    if (!draft.items || draft.items.length === 0) {
      Alert.alert('Chưa có vị trí', 'Vui lòng chọn ít nhất 1 vị trí trên sơ đồ để ghi nháp trước khi gửi.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await submitAdjustmentProposalToServer({
        system_code: 'KHO_DONG_LANH',
        company_id: user?.company_id || null,
        title: `Đề xuất điều chỉnh vị trí (${draft.items.length} vị trí)`,
        created_by: user?.id || null,
        created_by_name: user?.full_name || user?.username || 'Nhân viên kho',
        notes: shiftNote.trim() || undefined,
        items: draft.items,
      });

      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (res.isOfflineSaved) {
          Alert.alert(
            'Đã lưu ngoại tuyến (Offline)',
            'Hiện đang không có mạng. Phiếu điều chỉnh đã được lưu an toàn vào máy và sẽ tự động gửi lên máy chủ ngay khi có mạng trở lại!',
            [{ text: 'Đã hiểu', onPress: () => { onSubmittedSuccess(); onClose(); } }]
          );
        } else {
          Alert.alert(
            'Gửi thành công! 🎉',
            `Đã gửi phiếu đề xuất (${draft.items.length} vị trí) lên máy chủ. Quản lý sẽ duyệt và cập nhật vào sơ đồ kho.`,
            [{ text: 'Đóng', onPress: () => { onSubmittedSuccess(); onClose(); } }]
          );
        }
      } else {
        Alert.alert('Lỗi', res.error || 'Không thể gửi phiếu đề xuất');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, activeTab === 'HISTORY' && styles.containerHistory, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={styles.iconCircle}>
                <Ionicons name="clipboard" size={20} color="#f59e0b" />
              </View>
              <View>
                <Text style={styles.headerTitle}>PHIẾU GHI NHÁP ĐIỀU CHỈNH</Text>
                <Text style={styles.headerSub}>
                  {draft.items.length} vị trí đã ghi nhận trong ca
                </Text>
              </View>
            </View>

            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Tabs Switcher */}
          <View style={styles.tabBar}>
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setActiveTab('DRAFT');
              }}
              style={[styles.tabBtn, activeTab === 'DRAFT' && styles.tabBtnActive]}
            >
              <Ionicons
                name="create-outline"
                size={15}
                color={activeTab === 'DRAFT' ? '#f59e0b' : '#94a3b8'}
              />
              <Text style={[styles.tabText, activeTab === 'DRAFT' && styles.tabTextActive]}>
                Đang nháp ({draft.items.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setActiveTab('HISTORY');
              }}
              style={[styles.tabBtn, activeTab === 'HISTORY' && styles.tabBtnActive]}
            >
              <Ionicons
                name="time-outline"
                size={15}
                color={activeTab === 'HISTORY' ? '#38bdf8' : '#94a3b8'}
              />
              <Text style={[styles.tabText, activeTab === 'HISTORY' && { color: '#38bdf8' }]}>
                Đã gửi duyệt ({submittedList.length})
              </Text>
            </TouchableOpacity>
          </View>

          {activeTab === 'DRAFT' ? (
            <>
              {/* List of draft items */}
              <ScrollView style={styles.scrollBody} contentContainerStyle={{ paddingBottom: 16 }}>
            {draft.items.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="layers-outline" size={48} color="#475569" />
                <Text style={styles.emptyTitle}>Chưa có vị trí nào được ghi nháp</Text>
                <Text style={styles.emptySub}>
                  Chạm vào bất kỳ ô vị trí nào trên sơ đồ kho để ghi nháp (Xuất rỗng, Sửa số lượng, Chuyển ô).
                </Text>
              </View>
            ) : (
              draft.items.map((it, idx) => {
                const isMixedPallet = Boolean(it.sub_items && it.sub_items.length > 1);
                return (
                  <View key={it.id || idx} style={styles.itemCard}>
                    {/* Hàng 1: Mã vị trí + Nhãn thao tác + Nút Sửa / Xóa */}
                    <View style={styles.itemHeader}>
                      <View style={styles.posCodeBadge}>
                        <Text style={styles.posCodeText}>{it.position_code}</Text>
                      </View>

                      {it.action_type === 'CLEAR' && (
                        <View style={[styles.actionTag, { backgroundColor: '#88133744', borderColor: '#f43f5e' }]}>
                          <Text style={[styles.actionTagText, { color: '#f43f5e' }]} numberOfLines={1}>
                            Xuất rỗng (X)
                          </Text>
                        </View>
                      )}
                      {it.action_type === 'SET_QTY' && (
                        <View style={[styles.actionTag, { backgroundColor: '#78350f44', borderColor: '#f59e0b' }]}>
                          <Text style={[styles.actionTagText, { color: '#fbbf24' }]} numberOfLines={1}>
                            Sửa SL: {it.new_quantity} {it.unit || 'th'}
                          </Text>
                        </View>
                      )}
                      {it.action_type === 'MOVE' && (
                        <View style={[styles.actionTag, { backgroundColor: '#0c4a6e44', borderColor: '#38bdf8' }]}>
                          <Text style={[styles.actionTagText, { color: '#38bdf8' }]} numberOfLines={1}>
                            ➔ {it.target_position_code || '---'}
                          </Text>
                        </View>
                      )}
                      {it.action_type === 'ASSIGN_LOT' && (
                        <View style={[styles.actionTag, { backgroundColor: '#581c8744', borderColor: '#a855f7' }]}>
                          <Text style={[styles.actionTagText, { color: '#d8b4fe' }]} numberOfLines={1}>
                            🏷️ STT: {it.lot_stt || it.lot_code || '---'}
                          </Text>
                        </View>
                      )}
                      {it.action_type === 'NOTE' && (
                        <View style={[styles.actionTag, { backgroundColor: '#064e3b55', borderColor: '#10b981' }]}>
                          <Text style={[styles.actionTagText, { color: '#6ee7b7' }]} numberOfLines={1}>
                            📝 Ghi chú
                          </Text>
                        </View>
                      )}

                      <View style={styles.headerActions}>
                        <TouchableOpacity
                          onPress={() => {
                            onEditItem(it);
                            onClose();
                          }}
                          style={styles.iconActionBtn}
                          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                        >
                          <Ionicons name="pencil" size={14} color="#60a5fa" />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleDeleteItem(it.position_id)}
                          style={styles.iconActionBtn}
                          hitSlop={{ top: 8, bottom: 8, left: 6, right: 8 }}
                        >
                          <Ionicons name="trash-outline" size={15} color="#94a3b8" />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Hàng 2: Tên sản phẩm hoặc danh sách dòng con nếu là Pallet hỗn hợp */}
                    {isMixedPallet ? (
                      <View style={styles.subItemsContainer}>
                        <Text style={styles.mixedBadgeTitle}>
                          Pallet hỗn hợp ({it.sub_items!.length} sản phẩm)
                        </Text>
                        {it.sub_items!.map((sub, sIdx) => (
                          <View key={sIdx} style={styles.subItemRow}>
                            <Text style={styles.subItemNameText} numberOfLines={1}>
                              • {sub.product_name}
                            </Text>
                            <Text style={styles.subItemQtyText}>
                              {sub.current_quantity} ➔{' '}
                              <Text
                                style={{
                                  color: it.action_type === 'CLEAR' ? '#f43f5e' : '#34d399',
                                  fontWeight: '800',
                                }}
                              >
                                {it.action_type === 'CLEAR' ? 0 : sub.new_quantity} {sub.unit || it.unit || 'th'}
                              </Text>
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.itemProduct} numberOfLines={2}>
                        {it.product_name || 'Hàng đông lạnh'}
                      </Text>
                    )}

                    {/* Hàng 3: Mã Lot & Số lượng (tự động xuống dòng gọn gàng nếu hẹp, không bao giờ dính chữ hay tràn lề) */}
                    <View style={styles.itemMetaRow}>
                      {it.lot_code ? (
                        <View style={styles.lotChip}>
                          <Text style={styles.itemLot}>{it.lot_code}</Text>
                        </View>
                      ) : null}

                      {!isMixedPallet && (
                        <View style={styles.qtyCompareWrap}>
                          <Text style={styles.itemQtyCompare}>
                            {it.current_quantity ?? '---'} {it.unit || 'th'}
                          </Text>
                          {it.action_type === 'SET_QTY' && (
                            <Text style={[styles.itemQtyCompare, { color: '#34d399', fontWeight: '800' }]}>
                              {' '}➔ {it.new_quantity} {it.unit || 'th'}
                            </Text>
                          )}
                          {it.action_type === 'CLEAR' && (
                            <Text style={[styles.itemQtyCompare, { color: '#f43f5e', fontWeight: '800' }]}>
                              {' '}➔ 0 (Trống)
                            </Text>
                          )}
                        </View>
                      )}

                      {isMixedPallet && it.action_type === 'SET_QTY' && (
                        <Text style={[styles.itemQtyCompare, { color: '#fbbf24', fontWeight: '700' }]}>
                          Tổng: {it.current_quantity ?? '---'} ➔{' '}
                          <Text style={{ color: '#34d399', fontWeight: '800' }}>{it.new_quantity}</Text>
                        </Text>
                      )}
                    </View>

                    {it.note ? (
                      <Text style={styles.itemNote} numberOfLines={2}>💬 {it.note}</Text>
                    ) : null}
                  </View>
                );
              })
            )}

            {draft.items.length > 0 && (
              <View style={styles.shiftNoteBox}>
                <Text style={styles.shiftNoteLabel}>GHI CHÚ CA LÀM VIỆC / TÊN PHIẾU:</Text>
                <TextInput
                  style={styles.shiftNoteInput}
                  value={shiftNote}
                  onChangeText={setShiftNote}
                  placeholder="Ví dụ: Ca chiều 12/11 - Bốc cont 25..."
                  placeholderTextColor="#64748b"
                />
              </View>
            )}
          </ScrollView>

          {/* Footer Actions */}
          {draft.items.length > 0 && (
            <View style={styles.footer}>
              <TouchableOpacity
                onPress={handleClearAll}
                style={styles.clearBtn}
                disabled={isSubmitting}
              >
                <Text style={styles.clearBtnText}>Xóa hết</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleSubmit}
                style={styles.submitBtn}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <>
                    <Ionicons name="paper-plane" size={18} color="#fff" />
                  <Text style={styles.submitBtnText}>GỬI ĐỀ XUẤT DUYỆT</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
            </>
          ) : (
            <View style={{ flex: 1 }}>
              {/* Thanh lọc trạng thái & nút tải lại */}
              <View style={styles.historyFilterBar}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  {(
                    [
                      { id: 'ALL', label: 'Tất cả' },
                      { id: 'PENDING', label: '🟡 Chờ duyệt' },
                      { id: 'APPROVED', label: '🟢 Đã duyệt' },
                      { id: 'REJECTED', label: '🔴 Từ chối' },
                    ] as const
                  ).map((f) => (
                    <TouchableOpacity
                      key={f.id}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setHistoryFilter(f.id);
                      }}
                      style={[
                        styles.filterPill,
                        historyFilter === f.id && styles.filterPillActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterPillText,
                          historyFilter === f.id && styles.filterPillTextActive,
                        ]}
                      >
                        {f.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <TouchableOpacity
                  onPress={loadSubmittedProposals}
                  style={styles.refreshHistoryBtn}
                  disabled={loadingHistory}
                >
                  <Ionicons name="refresh" size={16} color="#38bdf8" />
                </TouchableOpacity>
              </View>

              {/* Ô tìm kiếm lịch sử theo mã vị trí */}
              <View style={styles.historySearchWrap}>
                <Ionicons name="search" size={15} color="#64748b" />
                <TextInput
                  style={styles.historySearchInput}
                  value={historySearchQuery}
                  onChangeText={setHistorySearchQuery}
                  placeholder="Tìm theo mã vị trí (VD: K1D1A02T102)..."
                  placeholderTextColor="#64748b"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                {historySearchQuery ? (
                  <TouchableOpacity
                    onPress={() => setHistorySearchQuery('')}
                    style={styles.historySearchClear}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={17} color="#94a3b8" />
                  </TouchableOpacity>
                ) : null}
              </View>

              <ScrollView style={styles.scrollBody} contentContainerStyle={{ paddingBottom: 16 }}>
                {loadingHistory ? (
                  <View style={styles.emptyContainer}>
                    <ActivityIndicator size="large" color="#38bdf8" />
                    <Text style={styles.emptySub}>Đang tải danh sách phiếu đã gửi...</Text>
                  </View>
                ) : normalizedHistoryQuery ? (
                  matchedPositionHistory.length === 0 ? (
                    <View style={styles.emptyContainer}>
                      <Ionicons name="search-outline" size={42} color="#475569" />
                      <Text style={styles.emptyTitle}>
                        Không tìm thấy vị trí "{historySearchQuery.trim()}"
                      </Text>
                      <Text style={styles.emptySub}>
                        Thử chọn bộ lọc "Tất cả" hoặc kiểm tra lại mã vị trí cần tìm.
                      </Text>
                    </View>
                  ) : (
                    <>
                      <View style={styles.historyMatchBanner}>
                        <Text style={styles.historyMatchBannerText}>
                          Tìm thấy {matchedPositionHistory.length} lần nháp cho "{normalizedHistoryQuery}"
                        </Text>
                      </View>
                      {matchedPositionHistory.map(({ proposal: prop, item: it }, idx) => {
                        const statusInfo = prop.isOfflinePending
                          ? { label: 'Chờ đồng bộ', bg: '#4c1d9544', border: '#a78bfa', text: '#c4b5fd' }
                          : prop.status === 'APPROVED'
                          ? { label: 'Đã duyệt', bg: '#064e3b44', border: '#10b981', text: '#34d399' }
                          : prop.status === 'REJECTED'
                          ? { label: 'Từ chối', bg: '#88133744', border: '#f43f5e', text: '#fb7185' }
                          : { label: 'Chờ duyệt', bg: '#78350f44', border: '#f59e0b', text: '#fbbf24' };

                        return (
                          <View key={`${prop.id}-${it.id || idx}`} style={styles.historyCard}>
                            <View style={styles.historyMatchHeader}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                                <Ionicons name="time-outline" size={13} color="#fbbf24" />
                                <Text style={[styles.historyTimeText, { color: '#fde68a', fontWeight: '700' }]}>
                                  {formatDateTime(prop.created_at)}
                                </Text>
                                <View style={styles.historyCodeBadge}>
                                  <Text style={styles.historyCodeText}>{prop.code}</Text>
                                </View>
                              </View>
                              <View
                                style={[
                                  styles.statusBadge,
                                  { backgroundColor: statusInfo.bg, borderColor: statusInfo.border },
                                ]}
                              >
                                <Text style={[styles.statusBadgeText, { color: statusInfo.text }]}>
                                  {statusInfo.label}
                                </Text>
                              </View>
                            </View>

                            <View style={[styles.historyDetailTop, { marginTop: 8 }]}>
                              <View style={styles.posCodeBadge}>
                                <Text style={[styles.posCodeText, { fontSize: 12 }]}>{it.position_code}</Text>
                              </View>

                              {it.action_type === 'CLEAR' && (
                                <Text style={[styles.historyActionLabel, { color: '#fb7185' }]}>
                                  Xuất rỗng (0)
                                </Text>
                              )}
                              {it.action_type === 'SET_QTY' && (
                                <Text style={[styles.historyActionLabel, { color: '#34d399' }]}>
                                  {it.current_quantity ?? '?'} ➔ {it.new_quantity} {it.unit || 'th'}
                                </Text>
                              )}
                              {it.action_type === 'MOVE' && (
                                <Text style={[styles.historyActionLabel, { color: '#38bdf8' }]}>
                                  Chuyển ➔ {it.target_position_code || '---'}
                                </Text>
                              )}
                              {it.action_type === 'ASSIGN_LOT' && (
                                <Text style={[styles.historyActionLabel, { color: '#d8b4fe' }]}>
                                  Gắn STT: {it.lot_stt || it.lot_code || '---'}
                                </Text>
                              )}
                              {it.action_type === 'NOTE' && (
                                <Text style={[styles.historyActionLabel, { color: '#6ee7b7' }]}>
                                  📝 Chỉ ghi chú
                                </Text>
                              )}
                            </View>

                            {renderHistoryItemInfo(it)}

                            {it.note ? (
                              <Text
                                style={[
                                  styles.itemNote,
                                  it.action_type === 'NOTE' && {
                                    color: '#a7f3d0',
                                    backgroundColor: '#064e3b44',
                                    borderWidth: 1,
                                    borderColor: '#10b98144',
                                    paddingHorizontal: 8,
                                    paddingVertical: 5,
                                    borderRadius: 6,
                                  },
                                ]}
                              >
                                💬 {it.note}
                              </Text>
                            ) : null}
                          </View>
                        );
                      })}
                    </>
                  )
                ) : filteredSubmitted.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Ionicons name="document-text-outline" size={44} color="#475569" />
                    <Text style={styles.emptyTitle}>Chưa có phiếu nào</Text>
                    <Text style={styles.emptySub}>
                      Các phiếu điều chỉnh vị trí sau khi gửi duyệt sẽ hiển thị tại đây để bạn theo dõi trạng thái.
                    </Text>
                  </View>
                ) : (
                  filteredSubmitted.map((prop) => {
                    const isExpanded = expandedProposalId === prop.id;
                    const statusInfo = prop.isOfflinePending
                      ? { label: 'Chờ đồng bộ', bg: '#4c1d9544', border: '#a78bfa', text: '#c4b5fd' }
                      : prop.status === 'APPROVED'
                      ? { label: 'Đã duyệt', bg: '#064e3b44', border: '#10b981', text: '#34d399' }
                      : prop.status === 'REJECTED'
                      ? { label: 'Từ chối', bg: '#88133744', border: '#f43f5e', text: '#fb7185' }
                      : { label: 'Chờ duyệt', bg: '#78350f44', border: '#f59e0b', text: '#fbbf24' };

                    return (
                      <View key={prop.id} style={styles.historyCard}>
                        <TouchableOpacity
                          onPress={() => {
                            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                            setExpandedProposalId(isExpanded ? null : prop.id);
                          }}
                          activeOpacity={0.75}
                        >
                          <View style={styles.historyCardTop}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                              <View style={styles.historyCodeBadge}>
                                <Text style={styles.historyCodeText}>{prop.code}</Text>
                              </View>
                              <Text style={styles.historyTimeText}>{formatDateTime(prop.created_at)}</Text>
                            </View>

                            <View
                              style={[
                                styles.statusBadge,
                                { backgroundColor: statusInfo.bg, borderColor: statusInfo.border },
                              ]}
                            >
                              <Text style={[styles.statusBadgeText, { color: statusInfo.text }]}>
                                {statusInfo.label}
                              </Text>
                            </View>
                          </View>

                          <View style={styles.historyCardMid}>
                            <Text style={styles.historyTitleText} numberOfLines={1}>
                              {prop.title}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                              <Text style={styles.historyPosCountText}>{prop.total_positions} vị trí</Text>
                              <Ionicons
                                name={isExpanded ? 'chevron-up' : 'chevron-down'}
                                size={16}
                                color="#94a3b8"
                              />
                            </View>
                          </View>

                          {prop.notes ? (
                            <Text style={styles.historyNoteText} numberOfLines={isExpanded ? 4 : 1}>
                              📝 {prop.notes}
                            </Text>
                          ) : null}

                          {prop.status !== 'PENDING' && prop.review_notes ? (
                            <Text style={styles.historyReviewNoteText} numberOfLines={2}>
                              👤 {prop.approved_by_name || 'Quản lý'}: {prop.review_notes}
                            </Text>
                          ) : null}
                        </TouchableOpacity>

                        {/* Chi tiết các vị trí trong phiếu khi mở rộng */}
                        {isExpanded && (
                          <View style={styles.historyDetailList}>
                            {prop.items.map((it, idx) => (
                              <View key={it.id || idx} style={styles.historyDetailRow}>
                                <View style={styles.historyDetailTop}>
                                  <View style={styles.posCodeBadge}>
                                    <Text style={[styles.posCodeText, { fontSize: 11 }]}>{it.position_code}</Text>
                                  </View>

                                  {it.action_type === 'CLEAR' && (
                                    <Text style={[styles.historyActionLabel, { color: '#fb7185' }]}>
                                      Xuất rỗng (0)
                                    </Text>
                                  )}
                                  {it.action_type === 'SET_QTY' && (
                                    <Text style={[styles.historyActionLabel, { color: '#34d399' }]}>
                                      {it.current_quantity ?? '?'} ➔ {it.new_quantity} {it.unit || 'th'}
                                    </Text>
                                  )}
                                  {it.action_type === 'MOVE' && (
                                    <Text style={[styles.historyActionLabel, { color: '#38bdf8' }]}>
                                      Chuyển ➔ {it.target_position_code || '---'}
                                    </Text>
                                  )}
                                  {it.action_type === 'ASSIGN_LOT' && (
                                    <Text style={[styles.historyActionLabel, { color: '#d8b4fe' }]}>
                                      Gắn STT: {it.lot_stt || it.lot_code || '---'}
                                    </Text>
                                  )}
                                  {it.action_type === 'NOTE' && (
                                    <Text style={[styles.historyActionLabel, { color: '#6ee7b7' }]}>
                                      📝 Chỉ ghi chú
                                    </Text>
                                  )}
                                </View>

                                {it.sub_items && it.sub_items.length > 1 ? (
                                  <View style={{ marginTop: 4, gap: 2 }}>
                                    {it.sub_items.map((sub, sIdx) => (
                                      <View key={sIdx} style={styles.subItemRow}>
                                        <Text style={styles.subItemNameText} numberOfLines={1}>
                                          • {sub.product_name}
                                        </Text>
                                        <Text style={styles.subItemQtyText}>
                                          {sub.current_quantity} ➔{' '}
                                          <Text style={{ color: '#34d399', fontWeight: '800' }}>
                                            {it.action_type === 'CLEAR' ? 0 : sub.new_quantity} {sub.unit || 'th'}
                                          </Text>
                                        </Text>
                                      </View>
                                    ))}
                                  </View>
                                ) : (
                                  renderHistoryItemInfo(it)
                                )}

                                {it.note ? (
                                  <Text
                                    style={[
                                      styles.itemNote,
                                      it.action_type === 'NOTE' && {
                                        color: '#a7f3d0',
                                        backgroundColor: '#064e3b44',
                                        borderWidth: 1,
                                        borderColor: '#10b98144',
                                        paddingHorizontal: 8,
                                        paddingVertical: 5,
                                        borderRadius: 6,
                                      },
                                    ]}
                                  >
                                    💬 {it.note}
                                  </Text>
                                ) : null}
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: '#334155',
    maxHeight: '88%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  containerHistory: {
    height: '85%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f59e0b22',
    borderWidth: 1,
    borderColor: '#f59e0b44',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '900',
  },
  headerSub: {
    color: '#94a3b8',
    fontSize: 11,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#1e293b',
  },
  scrollBody: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyTitle: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  emptySub: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  itemCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 8,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 6,
  },
  posCodeBadge: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#475569',
  },
  posCodeText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  actionTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    flex: 1,
  },
  actionTagText: {
    fontSize: 11,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconActionBtn: {
    padding: 5,
    backgroundColor: '#0f172a',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  delBtn: {
    padding: 4,
  },
  itemProduct: {
    color: '#f1f5f9',
    fontSize: 12.5,
    fontWeight: '700',
    marginBottom: 6,
    lineHeight: 17,
  },
  subItemsContainer: {
    backgroundColor: '#090d16',
    borderRadius: 8,
    padding: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#33415555',
    gap: 4,
  },
  mixedBadgeTitle: {
    color: '#fbbf24',
    fontSize: 10.5,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  subItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  subItemNameText: {
    color: '#cbd5e1',
    fontSize: 11,
    flex: 1,
  },
  subItemQtyText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  itemMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderColor: '#33415544',
  },
  lotChip: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#1e3a8a88',
  },
  itemLot: {
    color: '#60a5fa',
    fontSize: 10.5,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  qtyCompareWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  itemQtyCompare: {
    color: '#94a3b8',
    fontSize: 11,
  },
  itemNote: {
    color: '#fef08a',
    fontSize: 11,
    backgroundColor: '#78350f22',
    borderWidth: 1,
    borderColor: '#78350f55',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 6,
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 2,
  },
  editBtnText: {
    color: '#60a5fa',
    fontSize: 11,
    fontWeight: '700',
  },
  shiftNoteBox: {
    backgroundColor: '#141e33',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginTop: 6,
    marginBottom: 20,
  },
  shiftNoteLabel: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 6,
  },
  shiftNoteInput: {
    backgroundColor: '#090d16',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    color: '#f8fafc',
    fontSize: 12.5,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: '#1e293b',
  },
  clearBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
  },
  clearBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  submitBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#0284c7',
    borderRadius: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '900',
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: '#1e293b',
    backgroundColor: '#0b1120',
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  tabBtnActive: {
    backgroundColor: '#0f172a',
    borderColor: '#38bdf8',
  },
  tabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  tabTextActive: {
    color: '#f59e0b',
    fontWeight: '800',
  },
  historyFilterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 99,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterPillActive: {
    backgroundColor: '#0c4a6e',
    borderColor: '#38bdf8',
  },
  filterPillText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  filterPillTextActive: {
    color: '#e0f2fe',
    fontWeight: '800',
  },
  refreshHistoryBtn: {
    padding: 7,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  historyCard: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  historyCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  historyCodeBadge: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#475569',
  },
  historyCodeText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  historyTimeText: {
    color: '#94a3b8',
    fontSize: 11,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 99,
    borderWidth: 1,
  },
  statusBadgeText: {
    fontSize: 10.5,
    fontWeight: '800',
  },
  historyCardMid: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  historyTitleText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
  },
  historyPosCountText: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '700',
  },
  historyNoteText: {
    color: '#cbd5e1',
    fontSize: 11,
    marginTop: 4,
    fontStyle: 'italic',
  },
  historyReviewNoteText: {
    color: '#86efac',
    fontSize: 11,
    marginTop: 4,
    backgroundColor: '#064e3b33',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  historyDetailList: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: '#334155',
    gap: 8,
  },
  historyDetailRow: {
    backgroundColor: '#0f172a',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  historyDetailTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  historyActionLabel: {
    fontSize: 11.5,
    fontWeight: '800',
  },
  historyDetailProd: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 4,
  },
  historySearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  historySearchInput: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 12.5,
    paddingVertical: 0,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  historySearchClear: {
    paddingLeft: 4,
  },
  historyMatchBanner: {
    backgroundColor: '#f59e0b18',
    borderWidth: 1,
    borderColor: '#f59e0b44',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 10,
  },
  historyMatchBannerText: {
    color: '#fde68a',
    fontSize: 11.5,
    fontWeight: '700',
  },
  historyMatchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderColor: '#33415588',
  },
  historyLotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  historyMetaBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  historyBadgeStt: {
    backgroundColor: '#581c8744',
    borderColor: '#a855f766',
  },
  historyBadgeSttText: {
    color: '#d8b4fe',
    fontSize: 10.5,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  historyBadgeLot: {
    backgroundColor: '#1e3a8a44',
    borderColor: '#3b82f666',
  },
  historyBadgeLotText: {
    color: '#93c5fd',
    fontSize: 10.5,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  historyBadgeQty: {
    backgroundColor: '#064e3b44',
    borderColor: '#10b98166',
  },
  historyBadgeQtyText: {
    color: '#6ee7b7',
    fontSize: 10.5,
    fontWeight: '700',
  },
  historyLotNotFound: {
    color: '#fda4af',
    fontSize: 11,
    marginTop: 4,
    backgroundColor: '#88133733',
    borderWidth: 1,
    borderColor: '#f43f5e44',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
