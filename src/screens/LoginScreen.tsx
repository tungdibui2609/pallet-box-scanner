import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { getStoredUser, getOfflineCredentials } from '../services/auth';
import { UserProfile } from '../types/auth';

export default function LoginScreen({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { login, loginOffline } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [offlineLoading, setOfflineLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cachedUser, setCachedUser] = useState<UserProfile | null>(null);

  useEffect(() => {
    loadCachedAccount();
  }, []);

  async function loadCachedAccount() {
    try {
      const stored = await getStoredUser();
      const creds = await getOfflineCredentials();
      if (stored) {
        setCachedUser(stored);
        if (creds?.inputIdentifier) {
          setUsername(creds.inputIdentifier);
        } else if (stored.username) {
          setUsername(stored.username);
        } else if (stored.email) {
          setUsername(stored.email);
        }
      }
    } catch {}
  }

  async function handleSignIn() {
    if (!username.trim()) {
      setErrorMessage('Vui lòng nhập email hoặc tên đăng nhập');
      return;
    }
    if (!password) {
      setErrorMessage('Vui lòng nhập mật khẩu');
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await login(username.trim(), password);
      if (!res.success) {
        setErrorMessage(res.message || 'Đăng nhập không thành công');
      }
    } catch (e: any) {
      setErrorMessage(e.message || 'Lỗi kết nối máy chủ');
    } finally {
      setLoading(false);
    }
  }

  async function handleQuickOfflineLogin() {
    if (!cachedUser) return;
    setOfflineLoading(true);
    try {
      const ok = await loginOffline();
      if (!ok) {
        setErrorMessage('Không thể mở phiên ngoại tuyến. Vui lòng nhập mật khẩu đăng nhập.');
      }
    } finally {
      setOfflineLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── LOGO & HEADER ──────────────────────── */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <Ionicons name="cube" size={44} color="#38bdf8" />
          </View>
          <Text style={styles.brandTitle}>CHÁNH THU WAREHOUSE</Text>
          <Text style={styles.brandSubtitle}>Hệ Thống Quét Tem Thùng & Pallet Kho</Text>
          
          <View style={styles.serverBadge}>
            <View style={styles.onlineDot} />
            <Text style={styles.serverText}>api.chanhthu.click</Text>
          </View>
        </View>

        {/* ── TIỆN ÍCH TIẾP TỤC NGOẠI TUYẾN KHI CÓ TÀI KHOẢN ĐÃ LƯU ──── */}
        {cachedUser && (
          <View style={styles.offlineCard}>
            <View style={styles.offlineCardHeader}>
              <View style={styles.offlineBadge}>
                <Ionicons name="cloud-offline" size={13} color="#f59e0b" />
                <Text style={styles.offlineBadgeText}>Tài khoản lưu trên máy</Text>
              </View>
              <Text style={styles.offlineCompanyText} numberOfLines={1}>
                {cachedUser.company?.code || 'CTG'} · {cachedUser.company?.name || 'Chánh Thu'}
              </Text>
            </View>

            <View style={styles.offlineUserRow}>
              <View style={styles.offlineAvatar}>
                <Ionicons name="person" size={18} color="#38bdf8" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.offlineUserName} numberOfLines={1}>
                  {cachedUser.full_name}
                </Text>
                <Text style={styles.offlineUserDetail} numberOfLines={1}>
                  {cachedUser.username || cachedUser.email}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.offlineBtn, offlineLoading && styles.loginBtnDisabled]}
              onPress={handleQuickOfflineLogin}
              disabled={offlineLoading}
              activeOpacity={0.8}
            >
              {offlineLoading ? (
                <ActivityIndicator color="#0f172a" size="small" />
              ) : (
                <>
                  <Ionicons name="flash" size={16} color="#0f172a" />
                  <Text style={styles.offlineBtnText}>VÀO NHANH NGOẠI TUYẾN (KHÔNG CẦN MẠNG)</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* ── FORM CARD ──────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {cachedUser ? 'Đăng Nhập Tài Khoản Khác' : 'Đăng Nhập Tài Khoản'}
          </Text>
          <Text style={styles.cardDesc}>
            Đăng nhập lần đầu cần mạng để tải cấu hình kho. Sau khi đăng nhập, tài khoản sẽ được lưu vĩnh viễn trên máy để làm việc ngoại tuyến.
          </Text>

          {errorMessage && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color="#ef4444" />
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          )}

          {/* Username / Email Input */}
          <Text style={styles.inputLabel}>Email hoặc Tên đăng nhập:</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="person-outline" size={20} color="#94a3b8" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="VD: tungnguyen@chanhthu.com hoặc ctg.phuc"
              placeholderTextColor="#64748b"
              value={username}
              onChangeText={(t) => {
                setUsername(t);
                if (errorMessage) setErrorMessage(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          {/* Password Input */}
          <Text style={styles.inputLabel}>Mật khẩu:</Text>
          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={20} color="#94a3b8" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Nhập mật khẩu..."
              placeholderTextColor="#64748b"
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                if (errorMessage) setErrorMessage(null);
              }}
              secureTextEntry={!showPassword}
              returnKeyType="done"
              onSubmitEditing={handleSignIn}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(!showPassword)}
              style={styles.eyeBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color="#94a3b8"
              />
            </TouchableOpacity>
          </View>

          {/* Submit Button */}
          <TouchableOpacity
            style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
            onPress={handleSignIn}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={styles.loginBtnText}>ĐĂNG NHẬP NGAY</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* ── SECURITY INFO NOTICE ───────────────── */}
        <View style={styles.infoBox}>
          <Ionicons name="shield-checkmark" size={22} color="#10b981" />
          <View style={{ flex: 1 }}>
            <Text style={styles.infoTitle}>Bảo Mật Phân Quyền Công Ty</Text>
            <Text style={styles.infoText}>
              Khi đăng nhập, mọi Pallet và tem thùng bạn quét sẽ tự động gắn kết với công ty của bạn, đảm bảo tính bảo mật và quản lý tập trung trên web mẹ.
            </Text>
          </View>
        </View>

        {/* ── OPTIONAL SERVER SETTINGS BUTTON ───── */}
        {onOpenSettings && (
          <TouchableOpacity style={styles.settingsLink} onPress={onOpenSettings}>
            <Ionicons name="settings-outline" size={16} color="#64748b" />
            <Text style={styles.settingsLinkText}>Cấu hình máy chủ kết nối</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scrollContent: {
    padding: 20,
    paddingTop: 36,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1e293b',
    borderWidth: 2,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#38bdf8',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#f8fafc',
    letterSpacing: 1,
  },
  brandSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 4,
  },
  serverBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  serverText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '700',
  },
  offlineCard: {
    backgroundColor: '#1e293b',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(245, 158, 11, 0.4)',
    marginBottom: 18,
    shadowColor: '#f59e0b',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  offlineCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  offlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  offlineBadgeText: {
    color: '#f59e0b',
    fontSize: 10,
    fontWeight: '800',
  },
  offlineCompanyText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
  },
  offlineUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  offlineAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderWidth: 1,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  offlineUserName: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '800',
  },
  offlineUserDetail: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  offlineBtn: {
    backgroundColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    shadowColor: '#f59e0b',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  offlineBtnText: {
    color: '#0f172a',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  cardDesc: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
    marginBottom: 18,
    lineHeight: 17,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#ef4444',
    padding: 10,
    borderRadius: 10,
    marginBottom: 16,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#cbd5e1',
    marginBottom: 6,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 16,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    paddingVertical: 12,
    color: '#f8fafc',
    fontSize: 14,
  },
  eyeBtn: {
    padding: 6,
  },
  loginBtn: {
    backgroundColor: '#0284c7',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
    shadowColor: '#0284c7',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    padding: 14,
    borderRadius: 16,
    marginTop: 20,
  },
  infoTitle: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 3,
  },
  infoText: {
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 16,
  },
  settingsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 24,
    paddingVertical: 8,
  },
  settingsLinkText: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
});
