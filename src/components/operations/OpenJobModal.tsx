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
import {
  OrderTypeItem,
  JobTemplate,
  ShiftProductItem,
  getOrderTypes,
  getJobTemplates,
  createShift,
} from '../../services/operationsService';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
  user: any;
  allProducts?: ShiftProductItem[];
}

export default function OpenJobModal({ visible, onClose, onSuccess, user, allProducts = [] }: Props) {
  const insets = useSafeAreaInsets();
  const [jobName, setJobName] = useState('');
  const [notes, setNotes] = useState('');
  const [orderTypes, setOrderTypes] = useState<OrderTypeItem[]>([]);
  const [selectedOrderType, setSelectedOrderType] = useState<OrderTypeItem | null>(null);
  const [jobTemplates, setJobTemplates] = useState<JobTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<JobTemplate | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setJobName('');
      setNotes('');
      setSelectedOrderType(null);
      setSelectedTemplate(null);
      loadInitialData();
    }
  }, [visible]);

  const loadInitialData = async () => {
    setLoadingTemplates(true);
    try {
      const [types, templates] = await Promise.all([
        getOrderTypes(),
        getJobTemplates(),
      ]);
      setOrderTypes(types);
      setJobTemplates(templates);
    } catch (e) {
      console.warn('Lỗi lấy dữ liệu tạo ca:', e);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleSelectTemplate = (tpl: JobTemplate) => {
    if (selectedTemplate?.id === tpl.id && jobName.trim() === tpl.name.trim()) {
      // Bấm lại để bỏ chọn
      setSelectedTemplate(null);
      setJobName('');
      setNotes('');
    } else {
      setSelectedTemplate(tpl);
      setJobName(tpl.name);
      if (tpl.notes) {
        setNotes(tpl.notes);
      }
    }
  };

  const handleStart = async () => {
    if (!jobName.trim()) {
      alert('Vui lòng nhập Tên công việc trước khi bắt đầu!');
      return;
    }
    setSubmitting(true);
    try {
      // Khớp mẫu công việc (ưu tiên mẫu đang chọn, hoặc tự khớp theo tên)
      const matched = selectedTemplate || jobTemplates.find(
        t => t.name.trim().toLowerCase() === jobName.trim().toLowerCase()
      );

      // Tự động ghim các sản phẩm của mẫu vào bàn làm việc
      let initialPinned: ShiftProductItem[] = [];
      if (matched?.pinned_product_ids && matched.pinned_product_ids.length > 0 && allProducts.length > 0) {
        const idSet = new Set(matched.pinned_product_ids);
        initialPinned = allProducts.filter(p => idSet.has(p.id));
      }

      await createShift({
        jobName: jobName.trim(),
        notes: notes.trim() || undefined,
        templateId: matched?.id || null,
        pinnedProducts: initialPinned,
        orderTypeId: selectedOrderType?.id || null,
        orderTypeName: selectedOrderType?.name || null,
        orderTypeCode: selectedOrderType?.code || null,
        user,
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      alert('Lỗi mở công việc: ' + (err?.message || err));
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
                  <Ionicons name="briefcase-outline" size={20} color="#818cf8" />
                  <Text style={styles.title}>Tạo Công Việc Mới</Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {/* 1. Tên công việc */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>
                    Tên công việc <Text style={{ color: '#f43f5e' }}>*</Text>
                  </Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Ví dụ: Đóng gói SR múi Dona, Xuất bán xe 01..."
                    placeholderTextColor="#64748b"
                    value={jobName}
                    onChangeText={(val) => {
                      setJobName(val);
                      if (selectedTemplate && selectedTemplate.name.trim().toLowerCase() !== val.trim().toLowerCase()) {
                        setSelectedTemplate(null);
                      }
                    }}
                    autoFocus
                  />
                </View>

                {/* 1.1 Công việc mẫu (Gợi ý chọn nhanh) */}
                <View style={styles.formGroup}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={styles.label}>Công việc mẫu (Chọn nhanh)</Text>
                    {loadingTemplates && (
                      <Text style={{ fontSize: 10, color: '#818cf8' }}>Đang tải mẫu...</Text>
                    )}
                  </View>
                  {jobTemplates.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 2 }} keyboardShouldPersistTaps="handled">
                      {jobTemplates.map(tpl => {
                        const isSelected = selectedTemplate?.id === tpl.id || jobName.trim().toLowerCase() === tpl.name.trim().toLowerCase();
                        const pinCount = tpl.pinned_product_ids?.length || 0;
                        return (
                          <TouchableOpacity
                            key={tpl.id}
                            onPress={() => handleSelectTemplate(tpl)}
                            style={[styles.templatePill, isSelected && styles.templatePillActive]}
                            activeOpacity={0.7}
                          >
                            <Ionicons
                              name={isSelected ? 'checkmark-circle' : 'bookmark-outline'}
                              size={13}
                              color={isSelected ? '#fff' : '#818cf8'}
                            />
                            <Text style={[styles.templatePillText, isSelected && styles.templatePillTextActive]}>
                              {tpl.name}
                            </Text>
                            {pinCount > 0 && (
                              <View style={[styles.pinCountBadge, isSelected && styles.pinCountBadgeActive]}>
                                <Text style={[styles.pinCountText, isSelected && styles.pinCountTextActive]}>
                                  {pinCount} SP
                                </Text>
                              </View>
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  ) : !loadingTemplates ? (
                    <Text style={styles.hint}>Chưa có công việc mẫu nào được tạo trên hệ thống.</Text>
                  ) : null}
                </View>

                {/* 2. Loại phiếu kế toán (Tự động điền) */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Loại phiếu (Kế toán)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 4 }} keyboardShouldPersistTaps="handled">
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
                  <Text style={styles.hint}>
                    Gán sẵn loại phiếu để khi làm phiếu kết toán tự động khớp đúng loại.
                  </Text>
                </View>

                {/* 3. Ghi chú mở ca */}
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Ghi chú công việc</Text>
                  <TextInput
                    style={[styles.input, { height: 60, textAlignVertical: 'top' }]}
                    placeholder="Ghi chú thêm về ca làm việc, tổ đội, cửa kho..."
                    placeholderTextColor="#64748b"
                    value={notes}
                    onChangeText={setNotes}
                    multiline
                  />
                </View>
              </ScrollView>

              {/* Nút Bắt đầu */}
              <TouchableOpacity
                onPress={handleStart}
                disabled={submitting || !jobName.trim()}
                style={[styles.submitBtn, (!jobName.trim() || submitting) && styles.submitBtnDisabled]}
              >
                <Ionicons name="play" size={18} color="#fff" />
                <Text style={styles.submitBtnText}>
                  {submitting ? 'Đang tạo...' : 'Bắt Đầu Làm Việc'}
                </Text>
              </TouchableOpacity>
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
    height: 42,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
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
    backgroundColor: '#6366f1',
    borderColor: '#818cf8',
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
  templatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    marginRight: 6,
  },
  templatePillActive: {
    backgroundColor: '#4338ca',
    borderColor: '#6366f1',
  },
  templatePillText: {
    fontSize: 12,
    color: '#e2e8f0',
    fontWeight: '700',
  },
  templatePillTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  pinCountBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(129, 140, 248, 0.18)',
  },
  pinCountBadgeActive: {
    backgroundColor: '#10b981',
  },
  pinCountText: {
    fontSize: 10,
    color: '#818cf8',
    fontWeight: '800',
  },
  pinCountTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  hint: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 4,
  },
  submitBtn: {
    height: 46,
    backgroundColor: '#6366f1',
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
});

