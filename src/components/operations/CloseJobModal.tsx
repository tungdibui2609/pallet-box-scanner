import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  TextInput,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DeliveryShift, OrderTypeItem, getOrderTypes, closeShift } from '../../services/operationsService';

interface Props {
  visible: boolean;
  shift: DeliveryShift | null;
  onClose: () => void;
  onSuccess: () => void;
  user: any;
}

export default function CloseJobModal({ visible, shift, onClose, onSuccess, user }: Props) {
  const insets = useSafeAreaInsets();
  const [closeNotes, setCloseNotes] = useState('');
  const [orderTypes, setOrderTypes] = useState<OrderTypeItem[]>([]);
  const [selectedOrderType, setSelectedOrderType] = useState<OrderTypeItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible && shift) {
      setCloseNotes('');
      loadTypes();
    }
  }, [visible, shift]);

  const loadTypes = async () => {
    try {
      const types = await getOrderTypes();
      setOrderTypes(types);
      const preTypeId = shift?.summary_data?.order_type_id;
      if (preTypeId) {
        const found = types.find(t => t.id === preTypeId);
        if (found) setSelectedOrderType(found);
      }
    } catch (e) {
      console.warn('Lỗi lấy loại phiếu:', e);
    }
  };

  if (!shift) return null;

  const jobName = shift.summary_data?.job_name || shift.notes || 'Công việc';

  const handleConfirmClose = async () => {
    setSubmitting(true);
    try {
      await closeShift({
        shiftId: shift.id,
        jobName,
        closeNotes: closeNotes.trim(),
        orderTypeId: selectedOrderType?.id || shift.summary_data?.order_type_id || null,
        orderTypeName: selectedOrderType?.name || shift.summary_data?.order_type_name || null,
        orderTypeCode: selectedOrderType?.code || shift.summary_data?.order_type_code || null,
        user,
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      alert('Lỗi chốt công việc: ' + (err?.message || err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
              <View style={styles.handle} />

              <View style={styles.header}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="stop-circle-outline" size={20} color="#f43f5e" />
                  <Text style={styles.title}>Hoàn Thành Công Việc</Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <Text style={styles.jobBadge}>
                {jobName}
              </Text>

              {/* 1. Chọn / Đổi Loại phiếu kế toán trước khi đóng */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>Loại phiếu kế toán:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 4 }}>
                  <TouchableOpacity
                    onPress={() => setSelectedOrderType(null)}
                    style={[styles.typePill, !selectedOrderType && styles.typePillActive]}
                  >
                    <Text style={[styles.typePillText, !selectedOrderType && styles.typePillTextActive]}>
                      Mặc định
                    </Text>
                  </TouchableOpacity>
                  {orderTypes.map(ot => {
                    const active = selectedOrderType?.id === ot.id;
                    return (
                      <TouchableOpacity
                        key={ot.id}
                        onPress={() => setSelectedOrderType(ot)}
                        style={[styles.typePill, active && styles.typePillActive]}
                      >
                        <Text style={[styles.typePillText, active && styles.typePillTextActive]}>
                          {ot.code ? `${ot.code} - ` : ''}{ot.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* 2. Ghi chú tổng kết */}
              <View style={styles.formGroup}>
                <Text style={styles.label}>Ghi chú bàn giao cuối ca:</Text>
                <TextInput
                  style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
                  placeholder="Ghi chú tổng kết sau khi hoàn thành..."
                  placeholderTextColor="#64748b"
                  value={closeNotes}
                  onChangeText={setCloseNotes}
                  multiline
                />
              </View>

              {/* 2 Nút: Hủy & Xác nhận đóng */}
              <View style={styles.actionRow}>
                <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Hủy</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleConfirmClose}
                  disabled={submitting}
                  style={[styles.closeSubmitBtn, submitting && { opacity: 0.5 }]}
                >
                  <Ionicons name="checkmark-done" size={18} color="#fff" />
                  <Text style={styles.closeSubmitBtnText}>
                    {submitting ? 'Đang đóng...' : 'Xác Nhận Đóng CV'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: '#475569',
    borderRadius: 3,
    alignSelf: 'center',
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f8fafc',
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  jobBadge: {
    fontSize: 13,
    fontWeight: '700',
    color: '#38bdf8',
    backgroundColor: '#0f172a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  formGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    marginBottom: 5,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f8fafc',
    fontSize: 13,
  },
  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    marginRight: 6,
  },
  typePillActive: {
    backgroundColor: '#e11d48',
    borderColor: '#f43f5e',
  },
  typePillText: {
    fontSize: 11,
    color: '#cbd5e1',
    fontWeight: '600',
  },
  typePillTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  cancelBtn: {
    flex: 1,
    height: 46,
    backgroundColor: '#334155',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  closeSubmitBtn: {
    flex: 2,
    height: 46,
    backgroundColor: '#e11d48',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  closeSubmitBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
});

