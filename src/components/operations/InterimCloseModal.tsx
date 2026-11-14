import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  TextInput,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DeliveryShift, createSubShift } from '../../services/operationsService';

interface Props {
  visible: boolean;
  shift: DeliveryShift | null;
  onClose: () => void;
  onSuccess: () => void;
  user: any;
}

export default function InterimCloseModal({ visible, shift, onClose, onSuccess, user }: Props) {
  const insets = useSafeAreaInsets();
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!shift) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await createSubShift({
        shift,
        notes: notes.trim() || undefined,
        user,
      });
      setNotes('');
      onSuccess();
      onClose();
    } catch (e: any) {
      alert('Lỗi chốt ca tạm: ' + (e?.message || e));
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
                  <Ionicons name="time-outline" size={20} color="#f59e0b" />
                  <Text style={styles.title}>Chốt Ca Tạm (Đợt)</Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <View style={styles.body}>
                <View style={styles.infoBox}>
                  <Text style={styles.jobName} numberOfLines={1}>
                    {shift.summary_data?.job_name || shift.notes || 'Công việc'}
                  </Text>
                  <Text style={styles.hint}>
                    Chốt tạm sẽ lưu lại mốc số liệu của đợt làm việc này và bắt đầu đếm số liệu cho đợt tiếp theo. Toàn bộ công việc vẫn tiếp tục hoạt động bình thường.
                  </Text>
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Ghi chú đợt chốt tạm</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Ví dụ: Chốt xe 01, Hết ca sáng, Tổ 2..."
                    placeholderTextColor="#64748b"
                    value={notes}
                    onChangeText={setNotes}
                    autoFocus
                  />
                </View>

                <View style={styles.btnRow}>
                  <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                    <Text style={styles.cancelBtnText}>Hủy</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={handleConfirm}
                    disabled={submitting}
                    style={styles.submitBtn}
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                        <Text style={styles.submitBtnText}>Xác Nhận Chốt Tạm</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
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
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    marginBottom: 10,
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
  body: {
    paddingVertical: 4,
  },
  infoBox: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
  },
  jobName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#818cf8',
    marginBottom: 4,
  },
  hint: {
    fontSize: 11,
    color: '#94a3b8',
    lineHeight: 16,
  },
  formGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    marginBottom: 6,
  },
  input: {
    height: 44,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    color: '#f8fafc',
    fontSize: 13,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    backgroundColor: '#334155',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: '#cbd5e1',
    fontWeight: '700',
    fontSize: 13,
  },
  submitBtn: {
    flex: 2,
    height: 44,
    backgroundColor: '#d97706',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  submitBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
});

