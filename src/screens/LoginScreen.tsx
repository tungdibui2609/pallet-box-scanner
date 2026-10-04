import React, { useState } from 'react';
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
import { DEFAULT_SUPABASE_URL } from '../services/supabase';

export default function LoginScreen({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

        {/* ── FORM CARD ──────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Đăng Nhập Tài Khoản</Text>
          <Text style={styles.cardDesc}>
            Vui lòng đăng nhập tài khoản hệ thống để đồng bộ dữ liệu và bảo mật kho công ty.
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
    marginBottom: 24,
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
    marginBottom: 16,
    lineHeight: 18,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#450a0a',
    borderWidth: 1,
    borderColor: '#ef4444',
    padding: 10,
    borderRadius: 10,
    marginBottom: 14,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  inputLabel: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 6,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 12,
    paddingHorizontal: 12,
    height: 48,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    height: '100%',
  },
  eyeBtn: {
    padding: 4,
  },
  loginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 10,
    gap: 8,
    shadowColor: '#059669',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  infoBox: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
    borderRadius: 16,
    padding: 16,
    marginTop: 20,
    alignItems: 'flex-start',
  },
  infoTitle: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 2,
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
    marginTop: 20,
    paddingVertical: 8,
  },
  settingsLinkText: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
});
