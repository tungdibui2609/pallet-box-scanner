import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
  TextInput,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShiftProductItem } from '../../services/operationsService';

interface Props {
  visible: boolean;
  product: ShiftProductItem | null;
  defaultUnit?: string;
  onClose: () => void;
  onSubmit: (params: { quantity: number; unit: string; type: 'in' | 'out'; note?: string }) => Promise<void>;
  currentStats?: { inQty: number; outQty: number; unit: string };
}

export default function OperationNumberPadModal({ visible, product, defaultUnit, onClose, onSubmit, currentStats }: Props) {
  const insets = useSafeAreaInsets();
  const [valueStr, setValueStr] = useState<string>('');
  const [selectedUnit, setSelectedUnit] = useState<string>('Thùng');
  const [note, setNote] = useState<string>('');
  const [showNoteInput, setShowNoteInput] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (visible && product) {
      setValueStr('');
      setNote('');
      setShowNoteInput(false);
      const units = product.available_units && product.available_units.length > 0
        ? product.available_units
        : [product.unit || 'Kg'];

      const isBox = (u: string) => u.toLowerCase().includes('thùng') || u.toLowerCase().startsWith('thung');
      const boxU = units.find(isBox);

      let chosen = defaultUnit && units.includes(defaultUnit) ? defaultUnit : null;
      if (!chosen && currentStats?.unit && units.includes(currentStats.unit)) {
        chosen = currentStats.unit;
      }
      if (!chosen && boxU) {
        chosen = boxU;
      }
      if (!chosen && product.unit && units.includes(product.unit)) {
        chosen = product.unit;
      }
      if (!chosen) {
        chosen = units[0] || 'Kg';
      }
      setSelectedUnit(chosen);
    }
  }, [visible, product, currentStats, defaultUnit]);

  if (!product) return null;

  const handleDigit = (digit: string) => {
    if (digit === '.' && valueStr.includes('.')) return;
    if (valueStr.length >= 7) return;
    setValueStr(prev => prev + digit);
  };

  const handleBackspace = () => {
    setValueStr(prev => prev.slice(0, -1));
  };

  const handleAddDelta = (delta: number) => {
    const cur = parseFloat(valueStr) || 0;
    const next = Math.max(0, cur + delta);
    setValueStr(next === 0 ? '' : String(next));
  };

  const handleAction = async (type: 'in' | 'out') => {
    const qty = parseFloat(valueStr);
    if (!qty || qty <= 0) {
      alert('Vui lòng nhập số lượng lớn hơn 0');
      return;
    }
    const currentUnit = selectedUnit;
    const currentNote = note.trim() || undefined;

    // Đóng bàn phím và reset ngay lập tức (0ms lag phản hồi tức thì cho người dùng trong kho đông)
    setValueStr('');
    onClose();

    try {
      await onSubmit({
        quantity: qty,
        unit: currentUnit,
        type,
        note: currentNote,
      });
    } catch (err: any) {
      console.warn('Lỗi submit bàn phím:', err);
    }
  };

  const isBox = (u: string) => u.toLowerCase().includes('thùng') || u.toLowerCase().startsWith('thung');
  const rawUnits = product.available_units && product.available_units.length > 0
    ? product.available_units
    : [product.unit || 'Thùng (20kg)', 'Kg'];
  const availableUnits = [...rawUnits].sort((a, b) => {
    const aIs = isBox(a);
    const bIs = isBox(b);
    if (aIs && !bIs) return -1;
    if (!aIs && bIs) return 1;
    return 0;
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
              {/* Thanh kéo handle */}
              <View style={styles.handle} />

              {/* Header Tên sản phẩm */}
              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.productName} numberOfLines={2}>
                    {product.name}
                  </Text>
                  <Text style={styles.productSku}>
                    {product.sku ? `Mã: ${product.sku}` : 'Chưa có SKU'}
                    {currentStats ? `  •  Đã: +${currentStats.inQty} / -${currentStats.outQty} ${currentStats.unit}` : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={22} color="#94a3b8" />
                </TouchableOpacity>
              </View>

              {/* Đơn vị tính Selector */}
              <View style={styles.unitRow}>
                <Text style={styles.unitLabel}>ĐVT:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {availableUnits.map(u => {
                    const active = selectedUnit === u;
                    return (
                      <TouchableOpacity
                        key={u}
                        onPress={() => setSelectedUnit(u)}
                        style={[styles.unitPill, active && styles.unitPillActive]}
                      >
                        <Text style={[styles.unitPillText, active && styles.unitPillTextActive]}>
                          {u}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Màn hình hiển thị số đang gõ */}
              <View style={styles.displayBox}>
                <Text style={styles.displayPrefix}>Số lượng:</Text>
                <Text style={[styles.displayValue, !valueStr && styles.displayPlaceholder]}>
                  {valueStr || '0'}
                </Text>
                <Text style={styles.displayUnit}>{selectedUnit}</Text>
              </View>

              {/* Nút cộng dồn nhanh */}
              <View style={styles.quickAddRow}>
                {[1, 5, 10, 20, 50].map(n => (
                  <TouchableOpacity
                    key={n}
                    onPress={() => handleAddDelta(n)}
                    style={styles.quickAddBtn}
                  >
                    <Text style={styles.quickAddText}>+{n}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={() => setShowNoteInput(!showNoteInput)}
                  style={[styles.quickAddBtn, showNoteInput && { backgroundColor: '#38bdf820', borderColor: '#38bdf8' }]}
                >
                  <Ionicons name="chatbubble-ellipses-outline" size={15} color={showNoteInput ? '#38bdf8' : '#94a3b8'} />
                </TouchableOpacity>
              </View>

              {/* Ô ghi chú thêm (nếu bật) */}
              {showNoteInput && (
                <View style={styles.noteInputWrapper}>
                  <TextInput
                    style={styles.noteInput}
                    placeholder="Ghi chú đợt (ví dụ: Xe 01, Hàng dán lỗi...)"
                    placeholderTextColor="#64748b"
                    value={note}
                    onChangeText={setNote}
                  />
                </View>
              )}

              {/* Bàn phím số 3x4 */}
              <View style={styles.keypad}>
                <View style={styles.keypadRow}>
                  {['1', '2', '3'].map(d => (
                    <TouchableOpacity key={d} onPress={() => handleDigit(d)} style={styles.keyBtn}>
                      <Text style={styles.keyText}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.keypadRow}>
                  {['4', '5', '6'].map(d => (
                    <TouchableOpacity key={d} onPress={() => handleDigit(d)} style={styles.keyBtn}>
                      <Text style={styles.keyText}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.keypadRow}>
                  {['7', '8', '9'].map(d => (
                    <TouchableOpacity key={d} onPress={() => handleDigit(d)} style={styles.keyBtn}>
                      <Text style={styles.keyText}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.keypadRow}>
                  <TouchableOpacity onPress={() => handleDigit('.')} style={styles.keyBtn}>
                    <Text style={styles.keyText}>.</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDigit('0')} style={styles.keyBtn}>
                    <Text style={styles.keyText}>0</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleBackspace} style={[styles.keyBtn, styles.backspaceBtn]}>
                    <Ionicons name="backspace-outline" size={24} color="#f43f5e" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* 2 Nút Hành động Lớn: NHẬP KHO & XUẤT KHO */}
              <View style={styles.actionRow}>
                <TouchableOpacity
                  onPress={() => handleAction('in')}
                  disabled={submitting || !valueStr}
                  style={[styles.actionBtn, styles.btnIn, (!valueStr || submitting) && styles.btnDisabled]}
                >
                  <Ionicons name="arrow-down-circle" size={20} color="#fff" />
                  <Text style={styles.actionBtnText}>NHẬP KHO (+)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleAction('out')}
                  disabled={submitting || !valueStr}
                  style={[styles.actionBtn, styles.btnOut, (!valueStr || submitting) && styles.btnDisabled]}
                >
                  <Ionicons name="arrow-up-circle" size={20} color="#fff" />
                  <Text style={styles.actionBtnText}>XUẤT KHO (-)</Text>
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
  productName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
    lineHeight: 20,
  },
  productSku: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  unitLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    marginRight: 8,
  },
  unitPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    marginRight: 6,
  },
  unitPillActive: {
    backgroundColor: '#6366f1',
    borderColor: '#818cf8',
  },
  unitPillText: {
    fontSize: 12,
    color: '#cbd5e1',
    fontWeight: '600',
  },
  unitPillTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  displayBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginVertical: 4,
    borderWidth: 1.5,
    borderColor: '#6366f1',
  },
  displayPrefix: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '600',
    marginRight: 10,
  },
  displayValue: {
    fontSize: 28,
    fontWeight: '900',
    color: '#38bdf8',
    letterSpacing: 1,
  },
  displayPlaceholder: {
    color: '#475569',
  },
  displayUnit: {
    fontSize: 14,
    fontWeight: '700',
    color: '#a5b4fc',
    marginLeft: 8,
  },
  quickAddRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 6,
  },
  quickAddBtn: {
    flex: 1,
    height: 32,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 3,
  },
  quickAddText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  noteInputWrapper: {
    marginBottom: 6,
  },
  noteInput: {
    height: 36,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
    paddingHorizontal: 12,
    color: '#f8fafc',
    fontSize: 12,
  },
  keypad: {
    marginVertical: 4,
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  keyBtn: {
    flex: 1,
    height: 48,
    backgroundColor: '#0f172a',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 3,
    borderWidth: 1,
    borderColor: '#334155',
  },
  keyText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f8fafc',
  },
  backspaceBtn: {
    backgroundColor: '#3f1d24',
    borderColor: '#881337',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  actionBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  btnIn: {
    backgroundColor: '#16a34a',
  },
  btnOut: {
    backgroundColor: '#e11d48',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
});

