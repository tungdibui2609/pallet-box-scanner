import React, { useState, useEffect, useMemo } from 'react';
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
import { useTheme, AppThemeColors } from '../../contexts/ThemeContext';
import { ModalNavBarSpacer } from '../common/ModalNavBarSpacer';
import { ShiftProductItem } from '../../services/operationsService';
import { LocalPickedImage } from '../../services/operationImagesService';
import OperationImagePickerBar from './OperationImagePickerBar';

interface Props {
  visible: boolean;
  product: ShiftProductItem | null;
  defaultUnit?: string;
  onClose: () => void;
  onSubmit: (params: { quantity: number; unit: string; type: 'in' | 'out'; note?: string; images?: LocalPickedImage[] }) => Promise<void>;
  currentStats?: { inQty: number; outQty: number; unit: string };
}

export default function OperationNumberPadModal({ visible, product, defaultUnit, onClose, onSubmit, currentStats }: Props) {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const insets = useSafeAreaInsets();
  const [valueStr, setValueStr] = useState<string>('');
  const [selectedUnit, setSelectedUnit] = useState<string>('Thùng');
  const [note, setNote] = useState<string>('');
  const [showNoteInput, setShowNoteInput] = useState<boolean>(false);
  const [images, setImages] = useState<LocalPickedImage[]>([]);
  const [submitting] = useState<boolean>(false);

  const productId = product?.id || null;
  const initDepsRef = React.useRef({ product, currentStats, defaultUnit });
  initDepsRef.current = { product, currentStats, defaultUnit };

  // Chỉ reset số lượng / ghi chú / ảnh khi MỞ modal hoặc ĐỔI sang sản phẩm khác
  // Tránh reset mất số lượng / ảnh đang nhập khi parent re-render lúc quay về từ Camera/Thư viện hoặc Realtime
  useEffect(() => {
    if (!visible || !productId) return;
    const { product: curProd, currentStats: curStats, defaultUnit: curDefUnit } = initDepsRef.current;
    if (!curProd) return;
    const timer = setTimeout(() => {
      setValueStr('');
      setNote('');
      setShowNoteInput(false);
      setImages([]);
      const units = curProd.available_units && curProd.available_units.length > 0
        ? curProd.available_units
        : [curProd.unit || 'Kg'];

      const isBox = (u: string) => u.toLowerCase().includes('thùng') || u.toLowerCase().startsWith('thung');
      const boxU = units.find(isBox);

      let chosen = curDefUnit && units.includes(curDefUnit) ? curDefUnit : null;
      if (!chosen && curStats?.unit && units.includes(curStats.unit)) {
        chosen = curStats.unit;
      }
      if (!chosen && boxU) {
        chosen = boxU;
      }
      if (!chosen && curProd.unit && units.includes(curProd.unit)) {
        chosen = curProd.unit;
      }
      if (!chosen) {
        chosen = units[0] || 'Kg';
      }
      setSelectedUnit(chosen);
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, productId]);

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
    const currentImages = images;

    // Đóng bàn phím và reset ngay lập tức (0ms lag phản hồi tức thì cho người dùng trong kho đông)
    setValueStr('');
    setImages([]);
    onClose();

    try {
      await onSubmit({
        quantity: qty,
        unit: currentUnit,
        type,
        note: currentNote,
        images: currentImages,
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
            <View style={[styles.sheetContainer, { paddingBottom: 16 }]}>
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
                  <Ionicons name="close" size={20} color={isDark ? '#94a3b8' : '#475569'} />
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
                  style={[
                    styles.quickAddBtn,
                    showNoteInput && {
                      backgroundColor: isDark ? '#38bdf820' : '#e0f2fe',
                      borderColor: isDark ? '#38bdf8' : '#0284c7',
                    },
                  ]}
                >
                  <Ionicons
                    name="chatbubble-ellipses-outline"
                    size={15}
                    color={showNoteInput ? (isDark ? '#38bdf8' : '#0284c7') : colors.textMuted}
                  />
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

              {/* Chụp ảnh / Chọn từ thư viện (không bắt buộc) */}
              <View style={{ marginBottom: 8 }}>
                <OperationImagePickerBar
                  images={images}
                  onChange={setImages}
                  compact
                  label="Ảnh chứng minh"
                />
              </View>

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
          <ModalNavBarSpacer />
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const createStyles = (c: AppThemeColors, isDark: boolean) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: isDark ? '#1e293b' : '#ffffff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
  },
  handle: {
    width: 44,
    height: 5,
    backgroundColor: isDark ? '#475569' : '#cbd5e1',
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
    borderBottomColor: isDark ? '#334155' : '#e2e8f0',
  },
  productName: {
    fontSize: 15,
    fontWeight: '800',
    color: c.text,
    lineHeight: 20,
  },
  productSku: {
    fontSize: 11,
    color: c.textMuted,
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    borderRadius: 999,
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  unitLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
    marginRight: 8,
  },
  unitPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: isDark ? '#0f172a' : '#f8fafc',
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#cbd5e1',
    marginRight: 6,
  },
  unitPillActive: {
    backgroundColor: '#4f46e5',
    borderColor: '#4f46e5',
  },
  unitPillText: {
    fontSize: 12,
    color: c.textSecondary,
    fontWeight: '700',
  },
  unitPillTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  displayBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: isDark ? '#0f172a' : '#eef2ff',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginVertical: 4,
    borderWidth: 1.5,
    borderColor: isDark ? '#6366f1' : '#c7d2fe',
  },
  displayPrefix: {
    fontSize: 13,
    color: c.textMuted,
    fontWeight: '700',
    marginRight: 10,
  },
  displayValue: {
    fontSize: 28,
    fontWeight: '900',
    color: isDark ? '#38bdf8' : '#0f172a',
    letterSpacing: 1,
  },
  displayPlaceholder: {
    color: isDark ? '#475569' : '#94a3b8',
  },
  displayUnit: {
    fontSize: 14,
    fontWeight: '800',
    color: isDark ? '#a5b4fc' : '#4f46e5',
    marginLeft: 8,
  },
  quickAddRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 6,
  },
  quickAddBtn: {
    flex: 1,
    height: 34,
    backgroundColor: isDark ? '#0f172a' : '#eef2ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#c7d2fe',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 3,
  },
  quickAddText: {
    fontSize: 12,
    fontWeight: '800',
    color: isDark ? '#e2e8f0' : '#4338ca',
  },
  noteInputWrapper: {
    marginBottom: 6,
  },
  noteInput: {
    height: 36,
    backgroundColor: c.inputBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    color: c.text,
    fontSize: 12,
  },
  keypad: {
    marginVertical: 4,
    padding: 6,
    borderRadius: 16,
    backgroundColor: isDark ? 'transparent' : '#f1f5f9',
  },
  keypadRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  keyBtn: {
    flex: 1,
    height: 48,
    backgroundColor: isDark ? '#0f172a' : '#ffffff',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 3,
    borderWidth: 1,
    borderColor: isDark ? '#334155' : '#e2e8f0',
    elevation: isDark ? 0 : 1,
  },
  keyText: {
    fontSize: 20,
    fontWeight: '800',
    color: c.text,
  },
  backspaceBtn: {
    backgroundColor: isDark ? '#3f1d24' : '#fff1f2',
    borderColor: isDark ? '#881337' : '#fecdd3',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  actionBtn: {
    flex: 1,
    height: 48,
    borderRadius: 14,
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
  modeRow: {
    flexDirection: 'row',
    backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
    borderRadius: 10,
    padding: 3,
    marginBottom: 8,
    gap: 4,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeBtnActive: {
    backgroundColor: c.surface,
  },
  modeText: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textMuted,
  },
  modeTextActive: {
    color: isDark ? '#38bdf8' : '#4f46e5',
  },
  rangeCard: {
    backgroundColor: c.surfaceAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 10,
    marginBottom: 8,
    gap: 8,
  },
  rangeInputsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  rangeLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
    marginBottom: 4,
  },
  rangeInput: {
    height: 44,
    backgroundColor: c.inputBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    color: c.text,
    fontSize: 18,
    fontWeight: '800',
  },
  calcTypeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  calcTypeBtn: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  calcTypeBtnActive: {
    backgroundColor: c.amberSoftBg,
    borderColor: '#f59e0b',
  },
  calcTypeText: {
    fontSize: 11,
    fontWeight: '700',
    color: c.textMuted,
  },
  calcTypeTextActive: {
    color: c.amberSoftText,
  },
  calcHintText: {
    fontSize: 11,
    color: c.textMuted,
    lineHeight: 15,
  },
  rangeResultBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.amberSoftBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.amberSoftBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  rangeFormula: {
    fontSize: 12,
    fontWeight: '700',
    color: c.amberSoftText,
  },
  rangeSuggest: {
    fontSize: 11,
    color: c.textSecondary,
    marginTop: 2,
  },
  rangeResultNum: {
    fontSize: 22,
    fontWeight: '900',
    color: c.text,
    marginLeft: 8,
  },
});

