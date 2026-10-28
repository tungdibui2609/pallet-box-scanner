import React, { createContext, useContext, useState, useEffect } from 'react';
import { UserProfile } from '../types/auth';
import { checkSessionUser, loginUser, logoutUser, getStoredUser } from '../services/auth';

interface AuthContextType {
  user: UserProfile | null;
  isLoading: boolean;
  login: (userOrEmail: string, pass: string) => Promise<{ success: boolean; message?: string; isOffline?: boolean }>;
  loginOffline: () => Promise<boolean>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    initAuth();
  }, []);

  async function initAuth() {
    setIsLoading(true);
    try {
      // 1. Nạp ngay tài khoản đã lưu trong máy để vào thẳng app không cần mạng
      const stored = await getStoredUser();
      if (stored) {
        setUser(stored);
      }

      // 2. Kiểm tra cập nhật ngầm nếu có kết nối mạng
      const freshUser = await checkSessionUser();
      if (freshUser) {
        setUser(freshUser);
      } else if (stored) {
        // Nếu không có mạng hoặc kiểm tra cloud thất bại, vẫn giữ nguyên tài khoản đã lưu
        setUser(stored);
      }
    } catch (e) {
      console.warn('Lỗi khởi tạo Auth:', e);
      const stored = await getStoredUser();
      if (stored) setUser(stored);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLogin(userOrEmail: string, pass: string) {
    setIsLoading(true);
    try {
      const res = await loginUser(userOrEmail, pass);
      if (res.success && res.user) {
        setUser(res.user);
        return { success: true, isOffline: res.isOffline };
      }
      return { success: false, message: res.message || 'Đăng nhập không thành công' };
    } finally {
      setIsLoading(false);
    }
  }

  async function handleLoginOffline(): Promise<boolean> {
    const stored = await getStoredUser();
    if (stored) {
      setUser(stored);
      return true;
    }
    return false;
  }

  async function handleLogout() {
    setIsLoading(true);
    try {
      await logoutUser();
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshUser() {
    const freshUser = await checkSessionUser();
    if (freshUser) {
      setUser(freshUser);
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login: handleLogin,
        loginOffline: handleLoginOffline,
        logout: handleLogout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
