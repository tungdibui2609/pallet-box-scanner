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
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { JournalRecord } from '../../services/operationsService';

interface Props {
  visible: boolean;
  record: JournalRecord | null;
  onClose: () => void;
  onSubmit: (params: { id: string; quantity: number; unit: string; type: 'in' | 'out'; notes?: string }) => Promise<void>;
}

export default function EditJournalModal({ visible, record, onClose, onSubmit }: Props) {
  const insets = useSafeAreaInsets();
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('Thùng (20kg)');
  const [type, setType] = useState<'in' | 'out'>('in');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible && record) {
      setQuantity(String(record.quantity_sent || (record as any).result_quantity || ''));
      setUnit(record.unit || 'Thùng (20kg)');
      const isImport = record.to_department === 'Kho' || (record.notes && record.notes.includes('Nhập kho'));
      setType(isImport ? 'in' : 'out');
      // Lọc bỏ các tag [CV_ID: ...] để chỉ hiện ghi chú của user
      const cleanNote = (record.notes || '')
        .replace(/\[CV_ID:\s*[^\]]+\]/gi, '')
        .replace(/\[PID:\s*[^\]]+\]/gi, '')
        .replace(/\[SKU:\s*[^\]]*\]/gi, '')
        .replace(/\[CV:\s*[^\]]+\]/gi, '')
        .replace(/Nhập kho|Xuất kho/gi, '')
        .replace(/^[\s-]+/, '')
        .trim();
      setNotes(cleanNote);
    }
  }, [visible, record]);

  if (!record) return null;

  const handleSave = async () => {
    const qtyNum = parseFloat(quantity);
    if (!qtyNum || qtyNum <= 0) {
      alert('Vui lòng nhập số lượng hợp lệ lớn hơn 0');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        id: record.id,
        quantity: qtyNum,
        unit,
        type,
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (e: any) {
      alert('Lỗi cập nhật: ' + (e?.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  const commonUnits = ['Thùng (20kg)', 'Kg', 'Thùng', 'Bao', 'Hộp', 'Túi'];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
              <View style={styles.handle} />

              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>Chỉnh Sửa Lượt Ghi Nhận</Text>
                  <Text style={styles.productName} numberOfLines={1}>
                    {record.item_name}
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {/* 1. Loại thao tác (Nhập / Xuất) */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Loại giao nhận</Text>
                  <View style={styles.typeRow}>
                    <TouchableOpacity
                      onPress={() => setType('in')}
                      style={[styles.typeBtn, type === 'in' && styles.typeBtnInActive]}
                    >
                      <Ionicons name="arrow-down" size={15} color={type === 'in' ? '#fff' : '#22c55e'} />
                      <Text style={[styles.typeBtnText, type === 'in' && styles.typeBtnTextActive]}>
                        Nhập kho (+)
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => setType('out')}
                      style={[styles.typeBtn, type === 'out' && styles.typeBtnOutActive]}
                    >
                      <Ionicons name="arrow-up" size={15} color={type === 'out' ? '#fff' : '#ef4444'} />
                      <Text style={[styles.typeBtnText, type === 'out' && styles.typeBtnTextActive]}>
                        Xuất kho (-)
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* 2. Số lượng */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Số lượng *</Text>
                  <TextInput
                    style={styles.input}
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="numeric"
                    placeholder="Nhập số lượng..."
                    placeholderTextColor="#64748b"
                    selectTextOnFocus
                  />
                </View>

                {/* 3. Đơn vị tính */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Đơn vị tính</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                    {commonUnits.map(u => {
                      const isSel = unit === u;
                      return (
                        <TouchableOpacity
                          key={u}
                          onPress={() => setUnit(u)}
                          style={[styles.unitChip, isSel && styles.unitChipActive]}
                        >
                          <Text style={[styles.unitChipText, isSel && styles.unitChipTextActive]}>
                            {u}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                {/* 4. Ghi chú */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Ghi chú thêm</Text>
                  <TextInput
                    style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
                    value={notes}
                    onChangeText={setNotes}
                    placeholder="Ghi chú đợt, lý do điều chỉnh..."
                    placeholderTextColor="#64748b"
                    multiline
                  />
                </View>
              </ScrollView>

              <View style={styles.btnRow}>
                <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Hủy</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleSave}
                  disabled={submitting}
                  style={styles.submitBtn}
                >
                  {submitting ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.submitBtnText}>Lưu Thay Đổi</Text>
                  )}
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
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1e293b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 8,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: '#475569',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '800',
    color: '#f8fafc',
  },
  productName: {
    fontSize: 12,
    color: '#818cf8',
    fontWeight: '600',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    backgroundColor: '#0f172a',
    borderRadius: 8,
  },
  formGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 12,
    height: 42,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 38,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  typeBtnInActive: {
    backgroundColor: '#16a34a',
    borderColor: '#22c55e',
  },
  typeBtnOutActive: {
    backgroundColor: '#e11d48',
    borderColor: '#f43f5e',
  },
  typeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
  },
  typeBtnTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  unitChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 7,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
  },
  unitChipActive: {
    backgroundColor: '#312e81',
    borderColor: '#6366f1',
  },
  unitChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
  },
  unitChipTextActive: {
    color: '#a5b4fc',
    fontWeight: '800',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  cancelBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#94a3b8',
  },
  submitBtn: {
    flex: 2,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#6366f1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#ffffff',
  },
});

