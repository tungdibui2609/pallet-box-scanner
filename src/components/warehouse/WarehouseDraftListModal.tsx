import React, { useState } from 'react';
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
import * as Haptics from 'expo-haptics';
import {
  DraftProposal,
  ProposalItem,
  removeDraftItem,
  clearLocalDraftProposal,
  submitAdjustmentProposalToServer,
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
  const { user } = useAuth();
  const [shiftNote, setShiftNote] = useState<string>(draft.notes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

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
        <View style={styles.container}>
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

          {/* List of draft items */}
          <ScrollView style={styles.scrollBody}>
            {draft.items.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="layers-outline" size={48} color="#475569" />
                <Text style={styles.emptyTitle}>Chưa có vị trí nào được ghi nháp</Text>
                <Text style={styles.emptySub}>
                  Chạm vào bất kỳ ô vị trí nào trên sơ đồ kho để ghi nháp (Xuất rỗng, Sửa số lượng, Chuyển ô).
                </Text>
              </View>
            ) : (
              draft.items.map((it, idx) => (
                <View key={it.id || idx} style={styles.itemCard}>
                  <View style={styles.itemHeader}>
                    <View style={styles.posCodeBadge}>
                      <Text style={styles.posCodeText}>{it.position_code}</Text>
                    </View>

                    {it.action_type === 'CLEAR' && (
                      <View style={[styles.actionTag, { backgroundColor: '#88133744', borderColor: '#f43f5e' }]}>
                        <Text style={[styles.actionTagText, { color: '#f43f5e' }]}>🔴 Xuất rỗng ô (X)</Text>
                      </View>
                    )}
                    {it.action_type === 'SET_QTY' && (
                      <View style={[styles.actionTag, { backgroundColor: '#78350f44', borderColor: '#f59e0b' }]}>
                        <Text style={[styles.actionTagText, { color: '#fbbf24' }]}>
                          🟡 Sửa SL: {it.new_quantity} {it.unit || 'th'}
                        </Text>
                      </View>
                    )}
                    {it.action_type === 'MOVE' && (
                      <View style={[styles.actionTag, { backgroundColor: '#0c4a6e44', borderColor: '#38bdf8' }]}>
                        <Text style={[styles.actionTagText, { color: '#38bdf8' }]}>
                          🔵 Chuyển sang: {it.target_position_code || '---'}
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity
                      onPress={() => handleDeleteItem(it.position_id)}
                      style={styles.delBtn}
                    >
                      <Ionicons name="trash-outline" size={16} color="#94a3b8" />
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.itemProduct} numberOfLines={1}>
                    {it.product_name || 'Hàng đông lạnh'}
                  </Text>

                  {/* Hiển thị chi tiết từng dòng con nếu là pallet hỗn hợp */}
                  {it.sub_items && it.sub_items.length > 1 ? (
                    <View style={styles.subItemsContainer}>
                      {it.sub_items.map((sub, sIdx) => (
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
                  ) : null}

                  <View style={styles.itemMetaRow}>
                    {it.lot_code && (
                      <Text style={styles.itemLot}>Lot: {it.lot_code}</Text>
                    )}
                    <Text style={styles.itemQtyCompare}>
                      Trước: {it.current_quantity ?? '---'} {it.unit || 'th'}
                      {it.action_type === 'SET_QTY' && (
                        <Text style={{ color: '#34d399', fontWeight: '800' }}>
                          {' '}➔ Sau: {it.new_quantity} {it.unit || 'th'}
                        </Text>
                      )}
                      {it.action_type === 'CLEAR' && (
                        <Text style={{ color: '#f43f5e', fontWeight: '800' }}>
                          {' '}➔ Trống (0)
                        </Text>
                      )}
                    </Text>
                  </View>

                  {it.note ? (
                    <Text style={styles.itemNote}>💬 {it.note}</Text>
                  ) : null}

                  <TouchableOpacity
                    onPress={() => {
                      onEditItem(it);
                      onClose();
                    }}
                    style={styles.editBtn}
                  >
                    <Ionicons name="pencil" size={13} color="#60a5fa" />
                    <Text style={styles.editBtnText}>Chỉnh sửa dòng này</Text>
                  </TouchableOpacity>
                </View>
              ))
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
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  posCodeBadge: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#475569',
  },
  posCodeText: {
    color: '#f8fafc',
    fontSize: 13,
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
  delBtn: {
    padding: 4,
  },
  itemProduct: {
    color: '#f1f5f9',
    fontSize: 12.5,
    fontWeight: '700',
    marginBottom: 4,
  },
  subItemsContainer: {
    backgroundColor: '#090d16',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#33415555',
    gap: 4,
  },
  subItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
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
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemLot: {
    color: '#60a5fa',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
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
});
