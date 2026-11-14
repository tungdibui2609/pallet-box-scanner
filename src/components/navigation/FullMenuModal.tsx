import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';

export type AppTab =
  | 'scanner'
  | 'stamp_scanner'
  | 'operations'
  | 'inventory'
  | 'warehouse_map'
  | 'pallets'
  | 'settings';

interface FullMenuModalProps {
  visible: boolean;
  onClose: () => void;
  currentTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
}

export const FullMenuModal: React.FC<FullMenuModalProps> = ({
  visible,
  onClose,
  currentTab,
  onSelectTab,
}) => {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  const handleSelect = (tab: AppTab) => {
    onSelectTab(tab);
    onClose();
  };

  const menuSections: Array<{
    title: string;
    items: Array<{
      tab: AppTab;
      label: string;
      desc: string;
      icon: keyof typeof Ionicons.glyphMap;
      color: string;
      bgColor: string;
      isPrimary?: boolean;
    }>;
  }> = [
    {
      title: 'CHỨC NĂNG CHÍNH VẬN HÀNH',
      items: [
        {
          tab: 'stamp_scanner',
          label: 'Dấu Đóng Thùng',
          desc: 'Quét mã dấu đóng & liên kết tem',
          icon: 'finger-print',
          color: '#fbbf24',
          bgColor: 'rgba(251, 191, 36, 0.15)',
          isPrimary: true,
        },
        {
          tab: 'operations',
          label: 'Số Liệu & Ca Làm',
          desc: 'Ghi nhận số liệu nhập xuất, báo cáo ngày & mặt hàng',
          icon: 'calculator',
          color: '#818cf8',
          bgColor: 'rgba(129, 140, 248, 0.15)',
          isPrimary: true,
        },
        {
          tab: 'pallets',
          label: 'Pallet Kho',
          desc: 'Danh sách kiện/pallet và tình trạng lưu kho',
          icon: 'cube',
          color: '#38bdf8',
          bgColor: 'rgba(56, 189, 248, 0.15)',
          isPrimary: true,
        },
        {
          tab: 'warehouse_map',
          label: 'Sơ Đồ Kho',
          desc: 'Vị trí sơ đồ kệ và các ô chứa pallet',
          icon: 'map',
          color: '#06b6d4',
          bgColor: 'rgba(6, 182, 212, 0.15)',
          isPrimary: true,
        },
      ],
    },
    {
      title: 'QUÉT TEM & KIỂM KÊ',
      items: [
        {
          tab: 'scanner',
          label: 'Quét Tem Thùng',
          desc: 'Quét camera barcode tem thùng và đóng pallet',
          icon: 'scan',
          color: '#22c55e',
          bgColor: 'rgba(34, 197, 94, 0.15)',
        },
        {
          tab: 'inventory',
          label: 'Kiểm Kê Kho',
          desc: 'Kiểm tra tồn thực tế và đối soát hàng tồn',
          icon: 'clipboard',
          color: '#10b981',
          bgColor: 'rgba(16, 185, 129, 0.15)',
        },
      ],
    },
    {
      title: 'HỆ THỐNG & TÀI KHOẢN',
      items: [
        {
          tab: 'settings',
          label: 'Cài Đặt & Phân Hệ',
          desc: 'Chọn phân hệ kho làm việc, máy in & cấu hình',
          icon: 'settings',
          color: '#a78bfa',
          bgColor: 'rgba(167, 139, 250, 0.15)',
        },
      ],
    },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.backdrop} />
        </TouchableWithoutFeedback>

        <View style={[styles.sheetContainer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {/* Header Thông Tin Tài Khoản */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={styles.headerAvatar}>
                <Ionicons name="person" size={20} color="#38bdf8" />
              </View>
              <View>
                <Text style={styles.headerName}>{user?.full_name || 'Nhân viên kho'}</Text>
                <Text style={styles.headerCompany}>
                  {user?.company?.name || 'Công Ty CP Tập Đoàn XNK Trái Cây Chánh Thu'}
                </Text>
              </View>
            </View>

            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
              <Ionicons name="close" size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* Danh Sách Tất Cả Chức Năng */}
          <ScrollView
            style={styles.menuScroll}
            contentContainerStyle={{ padding: 14, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
          >
            {menuSections.map(sec => (
              <View key={sec.title} style={styles.sectionBox}>
                <Text style={styles.sectionTitle}>{sec.title}</Text>
                <View style={styles.itemsCard}>
                  {sec.items.map((item, idx) => {
                    const isSelected = currentTab === item.tab;
                    const isLast = idx === sec.items.length - 1;

                    return (
                      <TouchableOpacity
                        key={item.tab}
                        onPress={() => handleSelect(item.tab)}
                        style={[
                          styles.menuItemRow,
                          !isLast && styles.menuItemBorder,
                          isSelected && styles.menuItemRowActive,
                        ]}
                        activeOpacity={0.7}
                      >
                        <View style={[styles.itemIconBox, { backgroundColor: item.bgColor }]}>
                          <Ionicons name={item.icon} size={20} color={item.color} />
                        </View>

                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text
                              style={[
                                styles.itemLabel,
                                isSelected && { color: item.color, fontWeight: '800' },
                              ]}
                            >
                              {item.label}
                            </Text>
                            {item.isPrimary && (
                              <View style={styles.primaryBadge}>
                                <Text style={styles.primaryBadgeText}>Chính</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.itemDesc} numberOfLines={1}>
                            {item.desc}
                          </Text>
                        </View>

                        {isSelected ? (
                          <Ionicons name="checkmark-circle" size={18} color={item.color} />
                        ) : (
                          <Ionicons name="chevron-forward" size={16} color="#475569" />
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}

            {/* Nút Đăng Xuất */}
            <TouchableOpacity
              onPress={() => {
                onClose();
                logout();
              }}
              style={styles.logoutBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="log-out-outline" size={18} color="#ef4444" />
              <Text style={styles.logoutBtnText}>Đăng xuất khỏi ứng dụng</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetContainer: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    maxHeight: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerName: {
    fontSize: 14,
    fontWeight: '800',
    color: '#f8fafc',
  },
  headerCompany: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    maxWidth: 240,
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
  },
  menuScroll: {
    flexGrow: 0,
  },
  sectionBox: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#64748b',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
  },
  itemsCard: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  menuItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  menuItemRowActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.12)',
  },
  menuItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  itemIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f8fafc',
  },
  primaryBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
  },
  primaryBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#818cf8',
  },
  itemDesc: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.25)',
    marginTop: 6,
  },
  logoutBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ef4444',
  },
});
